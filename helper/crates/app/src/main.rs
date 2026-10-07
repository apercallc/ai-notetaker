//! `notetaker-helper` — the persistent tray app. Owns the AI pipeline, the
//! audio capture lifecycle, and crash recovery, per the non-negotiable
//! constraint that the helper (not the extension) owns the pipeline.
//!
//! Talks to `notetaker-nm-host` shim instances over a local socket (see
//! `ipc.rs`); those shims are what Chrome actually spawns per
//! `docs/native-messaging-protocol.md`.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio_diagnostics;
mod desktop_library;
mod desktop_migration;
mod desktop_settings;
mod desktop_sync;
mod ipc;
mod ipc_endpoint;
mod logging;
mod notify;
mod paths;
mod single_instance;
mod tray;
mod update_check;

use async_trait::async_trait;
use audio_diagnostics::AudioDiagnosticsCoordinator;
use desktop_sync::{DesktopSync, DesktopSyncStatus, SyncConflictReason};
use notetaker_audio::{AudioCapture, AudioDiagnostics};
use notetaker_core::native_messaging::{
    decode_browser_audio_chunk, ActionItem, ApiKeys, BrowserAudioChannel,
    CaptureCapabilitiesMessage, CaptureSource, ErrorCode, ExtensionToHelper, HelperToExtension,
    ManagedServiceConfig, MeetingMode, ProcessingMode, ProviderKind, SummarizationProviderId,
    TranscriptionProviderId,
};
use notetaker_core::pipeline::{Pipeline, RetryableChunk};
use notetaker_core::providers::test_provider_key;
use notetaker_core::providers::{
    AudioChunk, FlaggedMoment, ProviderError, SummarizationProvider, Summary, SummaryOptions,
    TranscriptSegment, TranscriptionProvider,
};
use notetaker_core::resilience::RetryQueue;
use notetaker_core::storage::MeetingStore;
use notetaker_core::{
    build_summarization_provider, build_transcription_provider, native_messaging,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::Mutex;
use uuid::Uuid;

const MAX_MANAGED_UPLOAD_ATTEMPTS: u32 = 3;
const MANAGED_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const MANAGED_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

fn managed_http_client() -> Result<reqwest::Client, String> {
    notetaker_core::providers::http_client_builder()
        .connect_timeout(MANAGED_CONNECT_TIMEOUT)
        .timeout(MANAGED_REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("managed HTTP client could not be configured: {error}"))
}

fn managed_retry_delay(attempt: u32) -> std::time::Duration {
    std::time::Duration::from_secs(2_u64.saturating_pow(attempt.saturating_add(1)).min(30))
}

fn should_reset_managed_job_cursor(status: reqwest::StatusCode) -> bool {
    matches!(
        status,
        reqwest::StatusCode::UNAUTHORIZED
            | reqwest::StatusCode::FORBIDDEN
            | reqwest::StatusCode::NOT_FOUND
    )
}

fn managed_identity_matches(
    meta: &notetaker_core::storage::MeetingMeta,
    service: &ManagedServiceConfig,
) -> bool {
    meta.managed_account_id.as_deref() == Some(service.account_id.as_str())
        && meta.managed_workspace_id.as_deref() == Some(service.workspace_id.as_str())
}

async fn retry_managed_upload<F, Fut>(attempt: F) -> Result<String, String>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<String, String>>,
{
    retry_managed_upload_with_wait(attempt, |delay| async move {
        tokio::time::sleep(delay).await;
    })
    .await
}

async fn retry_managed_upload_with_wait<F, Fut, W, WaitFut>(
    mut attempt: F,
    mut wait: W,
) -> Result<String, String>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<String, String>>,
    W: FnMut(std::time::Duration) -> WaitFut,
    WaitFut: Future<Output = ()>,
{
    let mut last_error = None;
    for attempt_number in 0..MAX_MANAGED_UPLOAD_ATTEMPTS {
        match attempt().await {
            Ok(job_id) => return Ok(job_id),
            Err(error) => {
                tracing::warn!(attempt = attempt_number + 1, %error, "managed upload attempt failed");
                last_error = Some(error);
                if attempt_number + 1 < MAX_MANAGED_UPLOAD_ATTEMPTS {
                    wait(managed_retry_delay(attempt_number)).await;
                }
            }
        }
    }
    Err(last_error.unwrap_or_else(|| "managed upload failed without an error".to_string()))
}

/// Managed capture intentionally does not call a local AI provider. It keeps
/// the durable audio pipeline alive while the stop handler uploads the saved
/// channel files to the hosted worker, which owns provider execution.
struct ManagedCaptureTranscription;

#[async_trait]
impl TranscriptionProvider for ManagedCaptureTranscription {
    fn id(&self) -> native_messaging::TranscriptionProviderId {
        native_messaging::TranscriptionProviderId::Deepgram
    }

    fn is_streaming(&self) -> bool {
        false
    }

    async fn transcribe_chunk(
        &self,
        _chunk: &AudioChunk,
    ) -> Result<Vec<TranscriptSegment>, ProviderError> {
        Ok(Vec::new())
    }
}

struct ManagedCaptureSummarization;

#[async_trait]
impl SummarizationProvider for ManagedCaptureSummarization {
    fn id(&self) -> native_messaging::SummarizationProviderId {
        native_messaging::SummarizationProviderId::Claude
    }

    async fn summarize(
        &self,
        _transcript: &[TranscriptSegment],
        _options: &SummaryOptions,
    ) -> Result<Summary, ProviderError> {
        Ok(Summary {
            summary: String::new(),
            action_items: Vec::new(),
        })
    }
}

#[derive(Clone)]
struct Settings {
    inner: native_messaging::ExtensionToHelper, // holds the Settings variant; validated on use
}

#[derive(Clone)]
struct ActiveRecording {
    audio: Option<Arc<dyn AudioCapture>>,
    audio_processing: Arc<AudioProcessingQueue>,
    capture_source: CaptureSource,
    processing_mode: ProcessingMode,
}

struct PersistedAudioChunk {
    channel: notetaker_core::providers::AudioChannel,
    sample_rate_hz: u32,
    existing_len: usize,
    end: usize,
}

impl PersistedAudioChunk {
    fn read(&self, store: &MeetingStore, meeting_id: Uuid) -> Result<Vec<u8>, String> {
        let channel_file = match self.channel {
            notetaker_core::providers::AudioChannel::Mic => notetaker_core::storage::MIC_FILE,
            notetaker_core::providers::AudioChannel::Speaker => {
                notetaker_core::storage::SPEAKER_FILE
            }
        };
        store
            .read_audio_range(meeting_id, channel_file, self.existing_len, self.end)
            .map_err(|error| format!("failed to read persisted audio: {error}"))
    }
}

/// Separates durable audio ingress from provider work. The sender is removed
/// during `finish`, so the worker drains every already-enqueued frame and then
/// exits; a slow provider can no longer block the Native Messaging reader from
/// persisting the next frame.
/// Queued frames hold only disk ranges, so a stalled provider does not retain
/// the call's raw audio in memory. The consumer loads one frame at a time.
struct AudioProcessingQueue {
    sender: std::sync::Mutex<Option<tokio::sync::mpsc::UnboundedSender<PersistedAudioChunk>>>,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl AudioProcessingQueue {
    fn enqueue(&self, chunk: PersistedAudioChunk) -> bool {
        let Ok(sender) = self.sender.lock() else {
            return false;
        };
        sender
            .as_ref()
            .is_some_and(|sender| sender.send(chunk).is_ok())
    }

    async fn close(&self) -> Option<tokio::task::JoinHandle<()>> {
        let sender = self.sender.lock().ok().and_then(|mut sender| sender.take());
        drop(sender);
        self.task.lock().await.take()
    }

    async fn finish(&self) {
        if let Some(task) = self.close().await {
            let _ = task.await;
        }
    }
}

struct AppState {
    store: Arc<MeetingStore>,
    data_dir: std::path::PathBuf,
    library: Arc<desktop_library::DesktopLibrary>,
    audio: Arc<dyn AudioCapture>,
    audio_diagnostics: AudioDiagnosticsCoordinator,
    pairing_token: Mutex<Option<String>>,
    settings: Mutex<Option<Settings>>,
    active: Mutex<HashMap<Uuid, ActiveRecording>>,
    pipelines: Mutex<HashMap<Uuid, Arc<Mutex<Pipeline>>>>,
    retry_tasks: Mutex<HashMap<Uuid, RetryWorker>>,
    recovering: Mutex<HashSet<Uuid>>,
    managed_tasks: Mutex<HashMap<Uuid, tokio::task::JoinHandle<()>>>,
    // std Mutex, not tokio: the IPC layer needs a synchronous disconnect
    // callback to prune a dead connection's entries before its writer task
    // is awaited, and every critical section here is short with no .await
    // inside — see subscribe_meeting/send_meeting_message/prune_subscribers.
    subscribers: std::sync::Mutex<HashMap<Uuid, Vec<ipc::OutSender>>>,
}

#[derive(Clone)]
struct DesktopCommandContext {
    app: Arc<AppState>,
    tray: Arc<tray::TrayController<tauri::Wry>>,
    output: ipc::OutSender,
    preferences: Arc<std::sync::Mutex<desktop_settings::DesktopPreferences>>,
    key_storage_error: Arc<std::sync::Mutex<Option<String>>>,
    sync: Arc<DesktopSync>,
    library: Arc<desktop_library::DesktopLibrary>,
    ui_app: tauri::AppHandle<tauri::Wry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopAudioStatus {
    platform: String,
    driver: String,
    checking: bool,
    timed_out: bool,
    microphone: Option<String>,
    speaker: Option<String>,
    ready: bool,
    guidance: String,
    native_loopback: bool,
    virtual_device_fallback: bool,
    permission_required: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopMeetingSummary {
    id: String,
    title: String,
    started_at: String,
    ended_at: Option<String>,
    status: String,
    summary: Option<String>,
    action_items: Vec<ActionItem>,
    active: bool,
    text_only_import: bool,
    extension_source_status: Option<String>,
    reprocessed_from: Option<String>,
    can_reprocess_extension_audio: bool,
    folder_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopMeetingDetail {
    meeting: DesktopMeetingSummary,
    transcript: Vec<TranscriptSegment>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSnapshot {
    version: String,
    settings: desktop_settings::DesktopSettingsView,
    credential_store_error: Option<String>,
    audio: DesktopAudioStatus,
    active_meeting_id: Option<String>,
    meetings: Vec<DesktopMeetingSummary>,
    folders: Vec<desktop_library::Folder>,
    library_error: Option<String>,
    unreadable_recordings: usize,
    notes_folder: String,
    webapp_sync: DesktopSyncStatus,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSettingsInput {
    transcription_provider: TranscriptionProviderId,
    summarization_provider: SummarizationProviderId,
    default_meeting_mode: MeetingMode,
    custom_vocabulary: Vec<String>,
    custom_summary_instructions: String,
    /// `None` keeps the current credential; an empty string removes it.
    deepgram_key: Option<String>,
    groq_key: Option<String>,
    claude_key: Option<String>,
    gemini_key: Option<String>,
    deepseek_key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderKeyCheck {
    valid: bool,
    message: String,
}

struct RetryWorker {
    stop_when_empty: Arc<AtomicBool>,
    _task: tokio::task::JoinHandle<()>,
}

impl RetryWorker {
    fn request_stop(&self) {
        self.stop_when_empty.store(true, Ordering::Release);
    }

    fn abort(self) {
        self._task.abort();
    }
}

/// Meetings whose Stop is being processed. The slot is released when the guard drops, whichever
/// way the stop ends.
static STOPS_IN_FLIGHT: std::sync::LazyLock<std::sync::Mutex<HashSet<Uuid>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(HashSet::new()));

struct StopGuard(Uuid);

impl StopGuard {
    fn acquire(meeting_id: Uuid) -> Option<Self> {
        let mut in_flight = STOPS_IN_FLIGHT
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        in_flight.insert(meeting_id).then(|| Self(meeting_id))
    }

    fn is_in_flight(meeting_id: Uuid) -> bool {
        STOPS_IN_FLIGHT
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contains(&meeting_id)
    }
}

impl Drop for StopGuard {
    fn drop(&mut self) {
        STOPS_IN_FLIGHT
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&self.0);
    }
}

/// https anywhere, or plain http only to a loopback host (local development). The host is
/// parsed rather than prefix-matched: `http://localhost.evil.com` must not pass for loopback.
fn hosted_url_is_allowed(raw: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(raw.trim()) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    match url.scheme() {
        "https" => true,
        "http" => {
            host.eq_ignore_ascii_case("localhost")
                || host
                    .parse::<std::net::Ipv4Addr>()
                    .is_ok_and(|address| address.is_loopback())
                || host
                    .trim_matches(['[', ']'])
                    .parse::<std::net::Ipv6Addr>()
                    .is_ok_and(|address| address.is_loopback())
        }
        _ => false,
    }
}

async fn managed_service_from_state(state: &AppState) -> Result<ManagedServiceConfig, String> {
    let settings = state
        .settings
        .lock()
        .await
        .clone()
        .ok_or_else(|| "managed settings are not configured".to_string())?;
    let ExtensionToHelper::Settings {
        processing_mode,
        managed_service,
        ..
    } = settings.inner
    else {
        return Err("managed settings are invalid".into());
    };
    let ProcessingMode::Managed {
        account_id,
        workspace_id,
        ..
    } = processing_mode
    else {
        return Err("managed processing is not selected".into());
    };
    let service =
        managed_service.ok_or_else(|| "hosted service credentials are missing".to_string())?;
    if service.base_url.is_empty()
        || service.access_token.is_empty()
        || service.account_id.is_empty()
        || service.workspace_id.is_empty()
    {
        return Err("hosted service URL or session is missing".into());
    }
    // The bearer token and raw call audio go to this URL: never over plain http
    // (loopback is allowed for local development).
    if !hosted_url_is_allowed(&service.base_url) {
        return Err("hosted service URL must use https".into());
    }
    if service.account_id != account_id || service.workspace_id != workspace_id {
        return Err(
            "managed processing identity does not match the hosted service workspace".into(),
        );
    }
    Ok(service)
}

async fn upload_managed_recording(
    store: &MeetingStore,
    meeting_id: Uuid,
    service: &ManagedServiceConfig,
) -> Result<String, String> {
    let meta = store
        .load_meta(meeting_id)
        .map_err(|error| error.to_string())?;
    if !managed_identity_matches(&meta, service) {
        return Err("managed recording belongs to a different hosted workspace; sign in to that workspace before retrying".into());
    }
    const CHUNK_BYTES: usize = 4 * 1024 * 1024;
    let channels = [
        ("mic", notetaker_core::storage::MIC_FILE),
        ("speaker", notetaker_core::storage::SPEAKER_FILE),
    ];
    let channel_lengths = channels
        .iter()
        .map(|(_, file)| {
            store
                .audio_len(meeting_id, file)
                .map_err(|error| error.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let total_bytes = channel_lengths.iter().try_fold(0usize, |total, length| {
        total
            .checked_add(*length)
            .ok_or_else(|| "managed recording is too large".to_string())
    })?;
    if total_bytes == 0 {
        return Err("managed recording contains no persisted audio".into());
    }
    let total_chunks = channel_lengths
        .iter()
        .map(|length| length.div_ceil(CHUNK_BYTES))
        .sum::<usize>();
    let client = managed_http_client()?;
    let base = service.base_url.trim_end_matches('/');
    let meeting_payload = serde_json::json!({
        "id": meeting_id.to_string(),
        "title": meta
            .title
            .clone()
            .unwrap_or_else(|| format!("Meeting on {}", meta.started_at.format("%Y-%m-%d"))),
        "startedAt": meta.started_at.to_rfc3339(),
        "endedAt": meta.ended_at.unwrap_or_else(chrono::Utc::now).to_rfc3339(),
        "summary": "",
        "transcript": [],
        "actionItems": [],
        "mode": serde_json::to_value(meta.summary_options.mode).unwrap_or_else(|_| serde_json::json!("general")),
        "captureSource": "desktop",
        "processingMode": "managed",
    });
    let response = client
        .post(format!("{base}/api/v1/meetings"))
        .bearer_auth(&service.access_token)
        .header("x-workspace-id", &service.workspace_id)
        .json(&meeting_payload)
        .send()
        .await
        .map_err(|error| format!("managed meeting registration failed: {error}"))?;
    ensure_managed_success(response, "managed meeting registration").await?;

    let idempotency_key = managed_upload_key(meeting_id, total_bytes);
    let manifest = serde_json::json!({
        "meetingId": meeting_id.to_string(),
        "totalChunks": total_chunks,
        "totalBytes": total_bytes,
        "idempotencyKey": idempotency_key,
    });
    let response = client
        .post(format!("{base}/api/v1/uploads"))
        .bearer_auth(&service.access_token)
        .header("x-workspace-id", &service.workspace_id)
        .json(&manifest)
        .send()
        .await
        .map_err(|error| format!("managed upload creation failed: {error}"))?;
    let upload_body = ensure_managed_success(response, "managed upload creation").await?;
    let upload_id = upload_body
        .get("uploadId")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "managed service returned no upload id".to_string())?
        .to_owned();
    let direct_upload = upload_body
        .get("directUpload")
        .and_then(serde_json::Value::as_bool)
        == Some(true);

    // Persist the server-issued upload identity before sending the first
    // chunk. If the helper exits mid-upload, the next worker run reuses the
    // same idempotent upload and resumes at the last acknowledged chunk;
    // replaying one acknowledged chunk remains safe because the API treats
    // identical checksums as an idempotent retry.
    let mut next_chunk = if meta.managed_upload_id.as_deref() == Some(upload_id.as_str()) {
        meta.managed_next_chunk.min(total_chunks)
    } else {
        0
    };
    store
        .set_managed_upload_progress(meeting_id, &upload_id, next_chunk)
        .map_err(|error| format!("managed upload state could not be persisted: {error}"))?;

    let mut index = 0usize;
    for ((channel, channel_file), channel_length) in channels.iter().copied().zip(channel_lengths) {
        let mut offset = 0usize;
        while offset < channel_length {
            let end = offset.saturating_add(CHUNK_BYTES).min(channel_length);
            if index < next_chunk {
                index += 1;
                offset = end;
                continue;
            }
            let chunk = store
                .read_audio_range(meeting_id, channel_file, offset, end)
                .map_err(|error| format!("managed audio could not be read: {error}"))?;
            let checksum: String = Sha256::digest(&chunk)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect();
            if direct_upload {
                let direct_path =
                    format!("{base}/api/v1/uploads/{upload_id}/chunks/{index}/direct");
                let response = client.post(&direct_path)
                    .bearer_auth(&service.access_token)
                    .header("x-workspace-id", &service.workspace_id)
                    .json(&serde_json::json!({ "byteLength": chunk.len(), "checksum": checksum, "channel": channel }))
                    .send().await.map_err(|error| format!("managed upload reservation failed: {error}"))?;
                let ticket = ensure_managed_success(response, "managed upload reservation").await?;
                if ticket.get("replayed").and_then(serde_json::Value::as_bool) != Some(true) {
                    let raw_url = ticket
                        .get("url")
                        .and_then(serde_json::Value::as_str)
                        .ok_or_else(|| {
                            "managed service returned no storage upload URL".to_string()
                        })?;
                    let url = reqwest::Url::parse(raw_url)
                        .map_err(|_| "invalid storage upload URL".to_string())?;
                    if url.scheme() != "https"
                        || !url.username().is_empty()
                        || url.password().is_some()
                        || url.fragment().is_some()
                    {
                        return Err("invalid storage upload URL".to_string());
                    }
                    // Separate client has no account headers/cookies. Never
                    // follow a storage redirect with a signed upload capability.
                    let storage_client = notetaker_core::providers::http_client_builder()
                        .redirect(reqwest::redirect::Policy::none())
                        .timeout(std::time::Duration::from_secs(180))
                        .build()
                        .map_err(|error| format!("storage client failed: {error}"))?;
                    let uploaded = storage_client
                        .put(url)
                        .header("content-type", "application/octet-stream")
                        .header("if-none-match", "*")
                        .body(chunk)
                        .send()
                        .await
                        .map_err(|_| {
                            "managed audio storage upload failed; retry from the local recording"
                                .to_string()
                        })?;
                    if !uploaded.status().is_success()
                        && uploaded.status() != reqwest::StatusCode::PRECONDITION_FAILED
                    {
                        return Err(format!(
                            "managed audio storage returned {}",
                            uploaded.status()
                        ));
                    }
                    let response = client
                        .post(&direct_path)
                        .bearer_auth(&service.access_token)
                        .header("x-workspace-id", &service.workspace_id)
                        .json(&serde_json::json!({ "operation": "complete" }))
                        .send()
                        .await
                        .map_err(|error| format!("managed chunk completion failed: {error}"))?;
                    ensure_managed_success(response, "managed chunk completion").await?;
                }
            } else {
                let response = client
                    .put(format!("{base}/api/v1/uploads/{upload_id}/chunks/{index}"))
                    .bearer_auth(&service.access_token)
                    .header("x-workspace-id", &service.workspace_id)
                    .header("x-chunk-sha256", &checksum)
                    .header("x-audio-channel", channel)
                    .body(chunk)
                    .send()
                    .await
                    .map_err(|error| format!("managed audio upload failed: {error}"))?;
                ensure_managed_success(response, "managed audio upload").await?;
            }
            index += 1;
            next_chunk = index;
            store
                .set_managed_upload_progress(meeting_id, &upload_id, next_chunk)
                .map_err(|error| format!("managed upload state could not be persisted: {error}"))?;
            offset = end;
        }
    }
    let response = client
        .post(format!("{base}/api/v1/uploads/{upload_id}/complete"))
        .bearer_auth(&service.access_token)
        .header("x-workspace-id", &service.workspace_id)
        .send()
        .await
        .map_err(|error| format!("managed upload completion failed: {error}"))?;
    ensure_managed_success(response, "managed upload completion").await?;
    let response = client
        .post(format!("{base}/api/v1/meetings/{meeting_id}/process"))
        .bearer_auth(&service.access_token)
        .header("x-workspace-id", &service.workspace_id)
        .json(&serde_json::json!({ "uploadId": upload_id, "idempotencyKey": idempotency_key }))
        .send()
        .await
        .map_err(|error| format!("managed processing enqueue failed: {error}"))?;
    let job = ensure_managed_success(response, "managed processing enqueue").await?;
    job.get("jobId")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "managed service returned no job id".into())
}

async fn ensure_managed_success(
    response: reqwest::Response,
    operation: &str,
) -> Result<serde_json::Value, String> {
    let status = response.status();
    let body = response
        .json::<serde_json::Value>()
        .await
        .unwrap_or_else(|_| serde_json::json!({}));
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(format!(
            "{operation}: your session ended. Sign in again in Settings → Account & sync; the recording is saved on this device and will resume."
        ));
    }
    if !status.is_success() {
        let message = body
            .get("error")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("unknown error");
        return Err(format!("{operation} failed ({status}): {message}"));
    }
    Ok(body)
}

/// The helper is persistent even when Chrome's MV3 worker is suspended, so it
/// owns the managed-job watch as well as the upload. This keeps a completed
/// hosted summary from being stranded in the service merely because the
/// browser was closed after clicking Stop.
async fn poll_managed_job(
    state: Arc<AppState>,
    service: ManagedServiceConfig,
    meeting_id: Uuid,
    job_id: String,
) {
    let client = match managed_http_client() {
        Ok(client) => client,
        Err(error) => {
            tracing::error!(%meeting_id, %error, "managed job client could not be configured");
            send_meeting_message(
                &state,
                meeting_id,
                HelperToExtension::ManagedJobStatus {
                    meeting_id,
                    job_id,
                    status: "error".into(),
                    message: Some("Hosted processing could not be contacted. Saved audio remains available for retry.".into()),
                    summary: None,
                    action_items: None,
                },
            );
            return;
        }
    };
    let base = service.base_url.trim_end_matches('/');
    let url = format!("{base}/api/v1/jobs/{job_id}");
    let mut last_status = "queued".to_string();

    // Two seconds a poll for the first ten minutes, then ten seconds up to about half an hour in
    // total: a long call's job routinely outlasts five minutes, and giving up while it is still
    // running leaves the user thinking the notes failed.
    for attempt in 0..MANAGED_POLL_ATTEMPTS {
        if attempt > 0 {
            tokio::time::sleep(managed_poll_delay(attempt)).await;
        }
        let response = match client
            .get(&url)
            .bearer_auth(&service.access_token)
            .header("x-workspace-id", &service.workspace_id)
            .send()
            .await
        {
            Ok(response) => response,
            Err(_) => continue,
        };
        if should_reset_managed_job_cursor(response.status()) {
            if let Err(error) = state.store.clear_managed_job_id(meeting_id) {
                tracing::warn!(%meeting_id, %error, "could not clear managed job cursor after hosted access failure");
            }
            send_meeting_message(
                &state,
                meeting_id,
                HelperToExtension::ManagedJobStatus {
                    meeting_id,
                    job_id: job_id.clone(),
                    status: "error".into(),
                    message: Some("Hosted access expired or the job is no longer available. Sign in again to retry; saved audio remains available.".into()),
                    summary: None,
                    action_items: None,
                },
            );
            return;
        }
        if !response.status().is_success() {
            continue;
        }
        let body = match response.json::<serde_json::Value>().await {
            Ok(body) => body,
            Err(_) => continue,
        };
        let status = body
            .get("status")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("queued");
        if status == "error" {
            if let Err(error) = state.store.clear_managed_job_id(meeting_id) {
                tracing::warn!(%meeting_id, %error, "could not clear failed managed job cursor");
            }
            send_meeting_message(
                &state,
                meeting_id,
                HelperToExtension::ManagedJobStatus {
                    meeting_id,
                    job_id: job_id.clone(),
                    status: "error".into(),
                    message: body
                        .get("message")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_owned),
                    summary: None,
                    action_items: None,
                },
            );
            return;
        }
        if status == "complete" {
            let summary = body
                .get("meeting")
                .and_then(|meeting| meeting.get("summary"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned);
            let action_items = body
                .get("meeting")
                .and_then(|meeting| meeting.get("actionItems"))
                .and_then(serde_json::Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| {
                            let text = item.get("text")?.as_str()?.to_owned();
                            let owner = item
                                .get("owner")
                                .and_then(serde_json::Value::as_str)
                                .map(str::to_owned);
                            Some(ActionItem {
                                text,
                                owner,
                                ..ActionItem::default()
                            })
                        })
                        .collect::<Vec<_>>()
                });
            // The browser may be asleep (no subscriber) when the job finishes. Keep the result on
            // this computer first, so it is never lost with the only copy of the message.
            if let Some(text) = &summary {
                let saved = Summary {
                    summary: text.clone(),
                    action_items: action_items.clone().unwrap_or_default(),
                };
                if let Err(error) = state.store.write_summary(meeting_id, &saved) {
                    tracing::warn!(%meeting_id, %error, "could not save the hosted summary locally");
                }
            }
            let _ = state.store.mark_managed_complete(meeting_id);
            send_meeting_message(
                &state,
                meeting_id,
                HelperToExtension::ManagedJobStatus {
                    meeting_id,
                    job_id,
                    status: "complete".into(),
                    message: None,
                    summary,
                    action_items,
                },
            );
            return;
        }
        if status != last_status {
            last_status = status.to_string();
            send_meeting_message(
                &state,
                meeting_id,
                HelperToExtension::ManagedJobStatus {
                    meeting_id,
                    job_id: job_id.clone(),
                    status: status.to_string(),
                    message: None,
                    summary: None,
                    action_items: None,
                },
            );
        }
    }

    send_meeting_message(
        &state,
        meeting_id,
        HelperToExtension::ManagedJobStatus {
            meeting_id,
            job_id,
            status: "error".into(),
            message: Some("managed job status polling timed out; the hosted job may still be retried from the workspace".into()),
            summary: None,
            action_items: None,
        },
    );
}

/// The upload's idempotency key names the exact recording: the same meeting resumed and grown is a
/// different upload, and the server rightly refuses a key reused with a different manifest. Replays
/// of the same recording (same size) still land on the same upload and resume it.
fn managed_upload_key(meeting_id: Uuid, total_bytes: usize) -> String {
    format!("meeting:{meeting_id}:{total_bytes}")
}

const MANAGED_POLL_ATTEMPTS: u32 = 300 + 120;

fn managed_poll_delay(attempt: u32) -> std::time::Duration {
    std::time::Duration::from_secs(if attempt < 300 { 2 } else { 10 })
}

/// Runs one durable managed-processing attempt. If the helper stopped before
/// it received a job id, the meeting/upload endpoints' idempotency keys make a
/// replay safe; if it already has a job id, only polling is resumed.
async fn run_managed_processing(
    state: Arc<AppState>,
    service: ManagedServiceConfig,
    meeting_id: Uuid,
    existing_job_id: Option<String>,
) {
    let job_id = match existing_job_id {
        Some(job_id) => job_id,
        None => match retry_managed_upload(|| {
            upload_managed_recording(&state.store, meeting_id, &service)
        })
        .await
        {
            Ok(job_id) => {
                if let Err(error) = state.store.set_managed_job_id(meeting_id, &job_id) {
                    tracing::error!(%meeting_id, %error, "could not persist managed job id");
                }
                job_id
            }
            Err(error) => {
                send_meeting_message(
                    &state,
                    meeting_id,
                    HelperToExtension::ManagedJobStatus {
                        meeting_id,
                        job_id: String::new(),
                        status: "error".into(),
                        message: Some(error),
                        summary: None,
                        action_items: None,
                    },
                );
                return;
            }
        },
    };

    send_meeting_message(
        &state,
        meeting_id,
        HelperToExtension::ManagedJobStatus {
            meeting_id,
            job_id: job_id.clone(),
            status: "queued".into(),
            message: None,
            summary: None,
            action_items: None,
        },
    );
    poll_managed_job(state, service, meeting_id, job_id).await;
}

async fn start_managed_worker(
    state: Arc<AppState>,
    service: ManagedServiceConfig,
    meeting_id: Uuid,
    existing_job_id: Option<String>,
) {
    let mut tasks = state.managed_tasks.lock().await;
    if tasks
        .get(&meeting_id)
        .is_some_and(|task| !task.is_finished())
    {
        return;
    }
    if let Some(task) = tasks.remove(&meeting_id) {
        task.abort();
    }
    let task_state = state.clone();
    let task = tokio::spawn(async move {
        run_managed_processing(task_state, service, meeting_id, existing_job_id).await;
    });
    tasks.insert(meeting_id, task);
}

/// Location of the pairing token inside the (0700) data directory. Shared
/// with the tray's "Pair New Browser" item, which deletes this file to
/// authorize a re-pair.
pub(crate) fn pairing_token_path(root: &std::path::Path) -> std::path::PathBuf {
    root.join("pairing_token.txt")
}

fn write_pairing_token(path: &std::path::Path, token: &str) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(token.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    file.sync_all()
}

/// Reads a previously issued pairing token, treating a blank file as "never
/// paired".
///
/// `write_pairing_token` opens with `truncate(true)`, so a crash or a full
/// disk between that open and the write leaves a zero-byte file behind. Read
/// verbatim, that empties into `Some("")`; treating it as `None` lets the next
/// hello repair the pairing instead of wedging the profile permanently.
fn load_pairing_token(path: &std::path::Path) -> Option<String> {
    let token = std::fs::read_to_string(path).ok()?;
    let token = token.trim();
    (!token.is_empty()).then(|| token.to_string())
}

/// Compares a presented pairing token without leaking how much of it matched.
///
/// The socket directory is 0700, so this is defence in depth rather than the
/// primary control — but a same-user process is exactly the attacker this
/// token exists to stop, and a local loop is the one setting where timing a
/// byte-by-byte `==` is genuinely practical.
fn pairing_token_matches(expected: &str, provided: &str) -> bool {
    if expected.len() != provided.len() {
        return false;
    }
    expected
        .bytes()
        .zip(provided.bytes())
        .fold(0u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}

/// A missing browser token means the extension profile was freshly installed
/// or its local storage was cleared. Native Messaging has already enforced
/// the extension origin, so issue a new local token instead of stranding that
/// profile behind an app-data file the user cannot reasonably find.
///
/// BUT: re-issuing on a null token when a token already exists would let any
/// same-user process that can reach the 0700 socket mint itself a fresh valid
/// token (hello with `pairing_token: null`) — defeating the token entirely.
/// So an existing token is only ever replaced after the user clears it from
/// the tray's "Pair New Browser" item, which deletes the token file. The
/// first-ever pairing (no token on disk) stays automatic, as does repair of a
/// blank/corrupt file left by an interrupted write.
fn should_issue_pairing_token(existing: Option<&str>, presented: Option<&str>) -> bool {
    // Only the first-ever pairing (no token on disk) auto-mints. An existing
    // token is replaced only after the user clears it via the tray's
    // "Pair New Browser" item, which deletes the token file. `load_pairing_token`
    // maps a blank/corrupt file to None, so interrupted-write repair still
    // works through the first-ever branch. `presented` is intentionally
    // unused: whether the browser lost its copy cannot distinguish "fresh
    // profile" from "rogue same-user process", so it must not authorize a
    // reissue.
    let _ = presented;
    existing.is_none()
}

fn secure_data_dir(root: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(root)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn main() {
    let root = match paths::data_dir().and_then(|root| secure_data_dir(&root).map(|()| root)) {
        Ok(root) => root,
        Err(error) => {
            // A read-only or missing profile folder used to panic here with nothing on screen, and the
            // extension then only ever saw "helper not running". Say what is wrong, then stop cleanly.
            eprintln!("AI Notetaker cannot use its data folder: {error}");
            notify::Notifier::default().notify_deduped(
                "data-dir-unusable",
                "AI Notetaker",
                &format!("The helper cannot use its data folder ({error}). Check the folder's permissions and free disk space, then start it again."),
            );
            std::process::exit(1);
        }
    };
    logging::init(&root);
    // Expanded once: the macro embeds the macOS Info.plist symbol, so a second use fails to link.
    let context = tauri::generate_context!();
    let _instance = match single_instance::acquire(&root) {
        Ok(single_instance::Acquired::Yes(lock)) => lock,
        Ok(single_instance::Acquired::AlreadyRunning) => {
            // Launching the app again (launcher, dock, Start menu) must raise the running
            // window. The plugin tells the first instance and exits this process; the setup
            // hook is only reached when the first instance could not be contacted.
            let _ = tauri::Builder::default()
                .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
                    show_main_window(app);
                }))
                .setup(|app| {
                    notify::Notifier::default().notify_deduped(
                        "already-running",
                        "AI Notetaker",
                        "AI Notetaker is already running. Open it from the tray menu.",
                    );
                    app.handle().exit(0);
                    Ok(())
                })
                .run(context);
            return;
        }
        Err(error) => {
            tracing::error!(%error, "could not acquire helper lock");
            return;
        }
    };

    let start_hidden = std::env::args().any(|arg| arg == BACKGROUND_FLAG);
    update_check::set_started_hidden(start_hidden);
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_window_event(|window, event| {
            // Closing the window must not end a recording or the recovery tray. Where no tray
            // exists (GNOME without an indicator extension) a closed window quits unless a
            // capture is live; relaunching always raises the running window.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if tray::keeps_running_when_window_closes() {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            desktop_snapshot,
            desktop_test_provider_key,
            desktop_save_settings,
            desktop_hosted_sign_in,
            desktop_hosted_sign_in_code,
            desktop_open_connect_page,
            desktop_hosted_sign_out,
            desktop_account_overview,
            desktop_team_roster,
            desktop_team_action,
            desktop_account_billing,
            desktop_import_transfer,
            desktop_import_audio_transfer,
            desktop_sync_existing_notes,
            desktop_retry_webapp_sync,
            desktop_set_action_item,
            desktop_save_text_file,
            desktop_start_recording,
            desktop_stop_recording,
            desktop_recover_meeting,
            desktop_reprocess_extension_audio,
            desktop_get_meeting,
            desktop_delete_meeting,
            desktop_create_folder,
            desktop_rename_folder,
            desktop_move_folder,
            desktop_delete_folder,
            desktop_move_meeting,
            desktop_test_audio,
            desktop_open_screen_recording_settings,
            desktop_open_blackhole_download,
            desktop_open_notes_folder,
            desktop_open_webapp,
            desktop_open_web_page,
            desktop_open_about_link,
            desktop_open_webapp_conflict,
            desktop_resolve_webapp_conflict,
        ])
        .setup(move |app| {
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                Some(vec![BACKGROUND_FLAG]),
            ))?;

            let root = root.clone();
            secure_data_dir(&root).map_err(|e| -> Box<dyn std::error::Error> { Box::new(e) })?;
            // Launch-at-login is on by default so recovery and the tray are
            // available after a reboot. It is applied once per install: the
            // marker keeps a later tray opt-out from being undone on upgrade.
            #[cfg(desktop)]
            apply_default_autostart(app.handle(), &root);
            let store = Arc::new(
                MeetingStore::new(&root)
                    .map_err(|e| -> Box<dyn std::error::Error> { Box::new(e) })?,
            );
            let existing_token = load_pairing_token(&pairing_token_path(&root));
            let audio: Arc<dyn AudioCapture> = build_audio_backend();
            let library = Arc::new(desktop_library::DesktopLibrary::new(root.clone()));
            let state = Arc::new(AppState {
                store,
                data_dir: root.clone(),
                library: library.clone(),
                audio,
                audio_diagnostics: AudioDiagnosticsCoordinator::default(),
                pairing_token: Mutex::new(existing_token),
                settings: Mutex::new(None),
                active: Mutex::new(HashMap::new()),
                pipelines: Mutex::new(HashMap::new()),
                retry_tasks: Mutex::new(HashMap::new()),
                recovering: Mutex::new(HashSet::new()),
                managed_tasks: Mutex::new(HashMap::new()),
                subscribers: std::sync::Mutex::new(HashMap::new()),
            });
            let preferences = desktop_settings::DesktopPreferences::load(&root).unwrap_or_else(|error| {
                tracing::warn!(%error, "desktop preferences could not be loaded; using defaults");
                desktop_settings::DesktopPreferences::default()
            });
            let (api_keys, key_storage_error) = match desktop_settings::load_api_keys() {
                Ok(keys) => (keys, None),
                Err(error) => {
                    tracing::warn!(%error, "OS credential store is unavailable");
                    (ApiKeys::default(), Some(error))
                }
            };
            let preferences = Arc::new(std::sync::Mutex::new(preferences));
            let key_storage_error = Arc::new(std::sync::Mutex::new(key_storage_error));
            let sync = DesktopSync::load(&root);
            let tray = tray::initialize(app.handle(), root.clone());
            let (ui_output, mut ui_events) = tokio::sync::mpsc::unbounded_channel();
            app.manage(DesktopCommandContext {
                app: state.clone(),
                tray: tray.clone(),
                output: ui_output.clone(),
                preferences: preferences.clone(),
                key_storage_error: key_storage_error.clone(),
                sync: sync.clone(),
                library: library.clone(),
                ui_app: app.handle().clone(),
            });
            let ui_app = app.handle().clone();
            let sync_app = ui_app.clone();
            let sync_state = state.clone();
            let sync_preferences = preferences.clone();
            let sync_queue = sync.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(message) = ui_events.recv().await {
                    if let HelperToExtension::SummaryReady { meeting_id, .. } = &message {
                        if sync_queue.enqueue(*meeting_id).is_ok() {
                            spawn_desktop_sync(
                                sync_state.clone(),
                                sync_preferences.clone(),
                                sync_queue.clone(),
                                sync_app.clone(),
                            );
                        }
                    }
                    if let Err(error) = ui_app.emit("helper-message", message) {
                        tracing::debug!(%error, "desktop window is not ready for a helper event");
                    }
                }
            });
            let initial_settings = {
                let preferences = preferences
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .clone();
                let webapp = desktop_settings::wire_webapp_config(&preferences.webapp_url)
                    .unwrap_or_else(|error| {
                        tracing::warn!(%error, "saved web-app sync URL is invalid");
                        None
                    });
                make_settings_message(&preferences, api_keys, webapp)
            };
            let initial_state = state.clone();
            let initial_tray = tray.clone();
            let initial_output = ui_output.clone();
            tauri::async_runtime::spawn(async move {
                handle_message(initial_state, initial_tray, initial_settings, initial_output).await;
            });
            let update_app = app.handle().clone();
            let update_data_dir = root.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    update_check::check_if_due(&update_app, &update_data_dir).await;
                    tokio::time::sleep(std::time::Duration::from_secs(6 * 60 * 60)).await;
                }
            });
            let retry_state = state.clone();
            let retry_preferences = preferences.clone();
            let retry_queue = sync.clone();
            let retry_app = app.handle().clone();
            let retry_output = ui_output.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    // Hosted recordings whose upload failed (offline, session expired and renewed)
                    // are retried here; a worker that is already running is left alone.
                    let hosted = {
                        let preferences = retry_preferences
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .clone();
                        desktop_settings::hosted_service(&preferences)
                    };
                    if let Some(service) = hosted {
                        start_pending_managed_workers(
                            retry_state.clone(),
                            service,
                            retry_output.clone(),
                        )
                        .await;
                    }
                    let outcome = run_desktop_sync(
                        retry_state.clone(),
                        retry_preferences.clone(),
                        retry_queue.clone(),
                        retry_app.clone(),
                    ).await;
                    // A workspace without a plan answers 402 to every request; asking again every
                    // minute only repeats the same refusal. A manual "Sync now" still tries at once.
                    let plan_blocked = matches!(outcome, Ok(true));
                    let wait = if plan_blocked { 15 * 60 } else { 60 };
                    tokio::time::sleep(std::time::Duration::from_secs(wait)).await;
                }
            });
            if let Ok(interrupted) = state
                .store
                .find_interrupted_meetings_excluding(&HashSet::new())
            {
                tray.set_attention(!interrupted.is_empty());
            }
            let ipc_state = state.clone();
            let ipc_tray = tray.clone();
            tauri::async_runtime::spawn(async move {
                let prune_state = ipc_state.clone();
                let on_disconnect = move |disconnected: ipc::OutSender| {
                    prune_subscribers(&prune_state, disconnected)
                };
                if let Err(error) = ipc::run_ipc_server(
                    &root,
                    move |msg, out_tx| {
                        let state = ipc_state.clone();
                        let tray = ipc_tray.clone();
                        async move { handle_message(state, tray, msg, out_tx).await }
                    },
                    on_disconnect,
                )
                .await
                {
                    tracing::error!("IPC server stopped: {error}");
                }
            });

            // Recordings that were waiting on hosted processing (made before it was retired) are
            // handed back to the local pipeline so their audio can be recovered with the user's keys.
            let released = release_stranded_managed_recordings(&state.data_dir, &state.store);
            if released > 0 {
                tracing::info!(released, "released hosted-pending recordings to the local pipeline");
            }

            // A login start stays in the tray only when something will show the tray icon;
            // otherwise the window is the only way to reach the app.
            if !start_hidden || !tray::tray_available() {
                show_main_window(app.handle());
            }
            tracing::info!("notetaker-helper starting");
            Ok(())
        })
        .build(context)
        .unwrap_or_else(|error| {
            tracing::error!(%error, "AI Notetaker helper stopped during startup");
            std::process::exit(1);
        });
    app.run(|app, event| {
        // Clicking the dock icon of a running app raises its window.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            show_main_window(app);
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (app, event);
    });
}

/// Passed by the launch-at-login entry so a login start stays in the tray.
const BACKGROUND_FLAG: &str = "--background";

pub(crate) fn show_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
async fn desktop_snapshot(
    context: tauri::State<'_, DesktopCommandContext>,
) -> Result<DesktopSnapshot, String> {
    let preferences = context
        .preferences
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    let stored_keys = desktop_settings::load_api_keys();
    let stored_token = desktop_settings::get_webapp_token();
    let mut credential_error = context
        .key_storage_error
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    let keys = match stored_keys {
        Ok(keys) => keys,
        Err(error) => {
            credential_error = Some(error);
            ApiKeys::default()
        }
    };
    let has_webapp_token = match stored_token {
        Ok(token) => token.is_some_and(|token| !token.trim().is_empty()),
        Err(error) => {
            credential_error.get_or_insert(error);
            false
        }
    };
    let webapp_sync = context.sync.status(
        has_webapp_token
            && desktop_settings::normalize_webapp_url(&preferences.webapp_url)
                .ok()
                .flatten()
                .is_some(),
    );

    let audio_diagnostics = context
        .app
        .audio_diagnostics
        .get(context.app.audio.clone())
        .await;
    let diagnostics = audio_diagnostics.diagnostics;
    let audio = DesktopAudioStatus {
        platform: diagnostics.platform,
        driver: diagnostics.driver,
        checking: audio_diagnostics.checking,
        timed_out: audio_diagnostics.timed_out,
        microphone: diagnostics.microphone,
        speaker: diagnostics.speaker,
        ready: diagnostics.ready,
        guidance: diagnostics.guidance,
        native_loopback: diagnostics.native_loopback,
        virtual_device_fallback: diagnostics.virtual_device_fallback,
        permission_required: diagnostics.permission_required,
    };

    let active = context.app.active.lock().await;
    let active_ids: HashSet<Uuid> = active.keys().copied().collect();
    let active_meeting_id = active
        .iter()
        .find_map(|(id, recording)| recording.audio.is_some().then(|| id.to_string()));
    drop(active);

    let (library, library_error) = match context.library.snapshot() {
        Ok(library) => (library, None),
        Err(error) => (desktop_library::LibraryState::default(), Some(error)),
    };
    let placements = library.placements;
    let store = context.app.store.clone();
    let meetings = tokio::task::spawn_blocking(move || -> Result<_, String> {
        let scan = store
            .scan_meetings()
            .map_err(|error| format!("Meeting history could not be read: {error}"))?;
        let unreadable = scan.unreadable.len();
        let reprocessed_sources = scan
            .readable
            .iter()
            .filter_map(|meta| meta.reprocessed_from)
            .collect::<HashSet<_>>();
        let mut meetings = Vec::new();
        for meta in scan.readable.into_iter().rev() {
            let summary = store.load_summary(meta.id).ok().flatten();
            let is_active = active_ids.contains(&meta.id);
            let status = if is_active {
                "recording"
            } else if meta.state == notetaker_core::storage::MeetingState::Recording {
                "recovered"
            } else if summary.is_some() {
                "complete"
            } else if meta.summary_pending || meta.managed_pending {
                "processing"
            } else {
                "saved"
            };
            let can_reprocess_extension_audio = !meta.text_only_import
                && meta.extension_source_status.is_some()
                && meta.reprocessed_from.is_none()
                && (store.audio_len(meta.id, "mic.pcm").unwrap_or(0) > 0
                    || store.audio_len(meta.id, "speaker.pcm").unwrap_or(0) > 0)
                && !reprocessed_sources.contains(&meta.id);
            meetings.push(DesktopMeetingSummary {
                id: meta.id.to_string(),
                title: meta.title.unwrap_or_else(|| {
                    format!("Meeting on {}", meta.started_at.format("%b %-d, %Y"))
                }),
                started_at: meta.started_at.to_rfc3339(),
                ended_at: meta.ended_at.map(|ended| ended.to_rfc3339()),
                status: status.to_string(),
                summary: summary.as_ref().map(|value| value.summary.clone()),
                action_items: summary.map_or_else(Vec::new, |value| value.action_items),
                active: is_active,
                text_only_import: meta.text_only_import,
                extension_source_status: meta.extension_source_status,
                reprocessed_from: meta.reprocessed_from.map(|id| id.to_string()),
                can_reprocess_extension_audio,
                folder_id: placements.get(&meta.id).map(ToString::to_string),
            });
        }
        Ok((meetings, unreadable))
    })
    .await
    .map_err(|error| format!("Meeting history scan failed: {error}"))??;

    Ok(DesktopSnapshot {
        version: env!("CARGO_PKG_VERSION").to_string(),
        settings: desktop_settings::settings_view(preferences, &keys, has_webapp_token),
        credential_store_error: credential_error,
        audio,
        active_meeting_id,
        meetings: meetings.0,
        folders: library.folders,
        library_error,
        unreadable_recordings: meetings.1,
        notes_folder: context.app.data_dir.join("meetings").display().to_string(),
        webapp_sync,
    })
}

#[tauri::command]
async fn desktop_test_provider_key(
    provider: ProviderKind,
    key: String,
) -> Result<ProviderKeyCheck, String> {
    let key = validate_secret(Some(key))?.ok_or_else(|| "Enter an API key first.".to_string())?;
    let (valid, message) = test_provider_key(provider, &key).await;
    Ok(ProviderKeyCheck { valid, message })
}

#[tauri::command]
async fn desktop_save_settings(
    context: tauri::State<'_, DesktopCommandContext>,
    input: DesktopSettingsInput,
) -> Result<desktop_settings::DesktopSettingsView, String> {
    if input.custom_vocabulary.len() > 100
        || input
            .custom_vocabulary
            .iter()
            .any(|term| term.chars().count() > 100)
    {
        return Err("Use at most 100 vocabulary terms, each 100 characters or fewer.".into());
    }
    if input.custom_summary_instructions.chars().count() > 4_000 {
        return Err("Custom summary instructions must be 4,000 characters or fewer.".into());
    }
    let mut keys = desktop_settings::load_api_keys()?;
    let previous_keys = keys.clone();
    apply_secret_update(&mut keys.deepgram, input.deepgram_key)?;
    apply_secret_update(&mut keys.groq, input.groq_key)?;
    apply_secret_update(&mut keys.claude, input.claude_key)?;
    apply_secret_update(&mut keys.gemini, input.gemini_key)?;
    apply_secret_update(&mut keys.deepseek, input.deepseek_key)?;

    let current_preferences = context
        .preferences
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    let sync_token = desktop_settings::get_webapp_token()?;
    let preferences = desktop_settings::DesktopPreferences {
        transcription_provider: input.transcription_provider,
        summarization_provider: input.summarization_provider,
        default_meeting_mode: input.default_meeting_mode,
        custom_vocabulary: input
            .custom_vocabulary
            .into_iter()
            .map(|term| term.trim().to_string())
            .filter(|term| !term.is_empty())
            .collect(),
        custom_summary_instructions: input.custom_summary_instructions.trim().to_string(),
        webapp_url: current_preferences.webapp_url.clone(),
        processing: current_preferences.processing,
        hosted_account: current_preferences.hosted_account.clone(),
        sync_from_sign_in: current_preferences.sync_from_sign_in,
    };

    if let Err(error) = desktop_settings::save_api_keys(&keys) {
        let _ = desktop_settings::save_api_keys(&previous_keys);
        return Err(error);
    }
    if let Err(error) = preferences.save(&context.app.data_dir) {
        let _ = desktop_settings::save_api_keys(&previous_keys);
        return Err(error);
    }

    *context
        .preferences
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = preferences.clone();
    *context
        .key_storage_error
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    let webapp = desktop_settings::wire_webapp_config(&preferences.webapp_url)?;
    let settings = make_settings_message(&preferences, keys.clone(), webapp);
    handle_message(
        context.app.clone(),
        context.tray.clone(),
        settings,
        context.output.clone(),
    )
    .await;

    let has_webapp_token = sync_token
        .as_ref()
        .is_some_and(|token| !token.trim().is_empty());
    if has_webapp_token && !preferences.webapp_url.is_empty() {
        spawn_desktop_sync(
            context.app.clone(),
            context.preferences.clone(),
            context.sync.clone(),
            context.ui_app.clone(),
        );
    }

    Ok(desktop_settings::settings_view(
        preferences,
        &keys,
        has_webapp_token,
    ))
}

#[derive(Deserialize)]
struct HostedLoginReply {
    #[serde(rename = "accessToken")]
    access_token: String,
    #[serde(rename = "expiresAt", default)]
    expires_at: String,
    #[serde(rename = "accountId")]
    account_id: String,
    #[serde(rename = "workspaceId")]
    workspace_id: String,
    #[serde(default)]
    plan: String,
    #[serde(default)]
    email: Option<String>,
}

#[derive(Deserialize)]
struct HostedLoginError {
    error: Option<String>,
}

/// Signs in to the hosted service. The password is sent once and never stored; only the
/// revocable session token it returns is kept, in the OS credential store.
#[tauri::command]
async fn desktop_hosted_sign_in(
    context: tauri::State<'_, DesktopCommandContext>,
    email: String,
    password: String,
    base_url: Option<String>,
) -> Result<desktop_settings::DesktopSettingsView, String> {
    let email = email.trim().to_string();
    if email.is_empty()
        || email.chars().count() > 320
        || password.is_empty()
        || password.chars().count() > 1_000
    {
        return Err("Enter the email and password for your AI Notetaker account.".into());
    }
    let base_url = desktop_settings::normalize_webapp_url(
        base_url
            .as_deref()
            .unwrap_or(desktop_settings::DEFAULT_WEBAPP_URL),
    )?
    .unwrap_or_else(|| desktop_settings::DEFAULT_WEBAPP_URL.to_string());
    let client = notetaker_core::providers::http_client_builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("Sign-in could not start: {error}"))?;
    let response = client
        .post(format!("{base_url}/api/v1/auth/login"))
        .json(&serde_json::json!({ "email": email, "password": password }))
        .send()
        .await
        .map_err(|_| "Could not reach the AI Notetaker service. Check your internet connection and try again.".to_string())?;
    let status = response.status();
    if !status.is_success() {
        let detail = response
            .json::<HostedLoginError>()
            .await
            .ok()
            .and_then(|body| body.error);
        return Err(match status.as_u16() {
            401 => "That email and password did not match. Check them and try again.".to_string(),
            404 => "Account sign-in is not available at this address. Check the web-app URL."
                .to_string(),
            429 => "Too many sign-in attempts. Wait a few minutes and try again.".to_string(),
            _ => detail
                .unwrap_or_else(|| format!("Sign-in failed ({status}). Try again in a moment.")),
        });
    }
    let reply: HostedLoginReply = response.json().await.map_err(|_| {
        "The service sent an unexpected sign-in reply. Update AI Notetaker and try again."
            .to_string()
    })?;
    if reply.access_token.is_empty() || reply.account_id.is_empty() || reply.workspace_id.is_empty()
    {
        return Err("The service sent an incomplete sign-in reply. Try again.".into());
    }

    finish_hosted_sign_in(&context, email, base_url, reply).await
}

/// Opens the web app's "Connect the desktop app" page, where a signed-in person (however they
/// sign in there, including Google) creates a one-time code to paste into the desktop app.
#[tauri::command]
fn desktop_open_connect_page(
    context: tauri::State<'_, DesktopCommandContext>,
) -> Result<(), String> {
    let preferences = current_preferences(&context);
    let base = preferences
        .hosted_account
        .as_ref()
        .map(|account| account.base_url.clone())
        .or_else(|| {
            desktop_settings::normalize_webapp_url(&preferences.webapp_url)
                .ok()
                .flatten()
        })
        .unwrap_or_else(|| desktop_settings::DEFAULT_WEBAPP_URL.to_string());
    open_external(&format!("{base}/account/connect-desktop"))
}

/// Signs in with the one-time code from the web app's Connect page. Works for every kind of
/// account, including ones that only have Google sign-in.
#[tauri::command]
async fn desktop_hosted_sign_in_code(
    context: tauri::State<'_, DesktopCommandContext>,
    code: String,
    base_url: Option<String>,
) -> Result<desktop_settings::DesktopSettingsView, String> {
    let code = code.trim().to_string();
    if code.is_empty() || code.chars().count() > 128 || code.chars().any(char::is_whitespace) {
        return Err("Paste the code exactly as the web app shows it.".into());
    }
    let base_url = desktop_settings::normalize_webapp_url(
        base_url
            .as_deref()
            .unwrap_or(desktop_settings::DEFAULT_WEBAPP_URL),
    )?
    .unwrap_or_else(|| desktop_settings::DEFAULT_WEBAPP_URL.to_string());
    let client = notetaker_core::providers::http_client_builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("Sign-in could not start: {error}"))?;
    let response = client
        .post(format!("{base_url}/api/v1/auth/desktop-code"))
        .json(&serde_json::json!({ "code": code }))
        .send()
        .await
        .map_err(|_| "Could not reach the AI Notetaker service. Check your internet connection and try again.".to_string())?;
    let status = response.status();
    if !status.is_success() {
        return Err(match status.as_u16() {
            401 => "That code is not valid or has expired. Create a new one in the web app."
                .to_string(),
            404 => "Account sign-in is not available at this address.".to_string(),
            _ => format!("Sign-in failed ({status}). Try again in a moment."),
        });
    }
    let reply: HostedLoginReply = response.json().await.map_err(|_| {
        "The service sent an unexpected sign-in reply. Update AI Notetaker and try again."
            .to_string()
    })?;
    let email = reply.email.clone().unwrap_or_default();
    finish_hosted_sign_in(&context, email, base_url, reply).await
}

async fn finish_hosted_sign_in(
    context: &DesktopCommandContext,
    email: String,
    base_url: String,
    reply: HostedLoginReply,
) -> Result<desktop_settings::DesktopSettingsView, String> {
    if reply.access_token.is_empty() || reply.account_id.is_empty() || reply.workspace_id.is_empty()
    {
        return Err("The service sent an incomplete sign-in reply. Try again.".into());
    }

    let previous = context
        .preferences
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    let previous_token = desktop_settings::get_hosted_token().ok().flatten();
    desktop_settings::set_hosted_token(Some(&reply.access_token))?;
    let preferences = desktop_settings::DesktopPreferences {
        // Signing in is for sync and plan management; notes keep using the user's own keys.
        processing: desktop_settings::ProcessingChoice::Local,
        hosted_account: Some(desktop_settings::HostedAccount {
            email,
            base_url,
            account_id: reply.account_id,
            workspace_id: reply.workspace_id,
            plan: if reply.plan.is_empty() {
                "free".into()
            } else {
                reply.plan
            },
            expires_at: reply.expires_at,
            sync_allowed: None,
        }),
        ..previous
    };
    // Signing in also connects the notes library to this workspace, so the desktop and the
    // web app show the same notes. A sync token the user already set up is never replaced.
    let mut preferences = preferences;
    let mut connected_sync = false;
    if desktop_settings::get_webapp_token()
        .ok()
        .flatten()
        .is_none()
    {
        match fetch_desktop_sync_token(&preferences).await {
            Ok((token, can_sync)) => match desktop_settings::set_webapp_token(Some(&token)) {
                Ok(()) => {
                    if let Some(account) = &mut preferences.hosted_account {
                        account.sync_allowed = Some(can_sync);
                    }
                    if let Some(account) = &preferences.hosted_account {
                        preferences.webapp_url = account.base_url.clone();
                    }
                    preferences.sync_from_sign_in = true;
                    // The token is kept either way so sync starts the moment a plan is added;
                    // without one the service would answer every request with 402.
                    connected_sync = can_sync;
                }
                Err(error) => tracing::warn!(%error, "could not store the notes-sync token"),
            },
            Err(error) => tracing::warn!(%error, "could not connect notes sync after sign-in"),
        }
    }
    if let Err(error) = preferences.save(&context.app.data_dir) {
        let _ = desktop_settings::set_hosted_token(previous_token.as_deref());
        if connected_sync {
            let _ = desktop_settings::set_webapp_token(None);
        }
        return Err(error);
    }
    let view = apply_preferences(context, preferences).await?;
    if connected_sync {
        spawn_desktop_sync(
            context.app.clone(),
            context.preferences.clone(),
            context.sync.clone(),
            context.ui_app.clone(),
        );
    }
    Ok(view)
}

/// Asks the service to end a token (best effort; the token also expires on its own).
async fn revoke_token(base_url: &str, token: &str) {
    let Ok(client) = notetaker_core::providers::http_client_builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .build()
    else {
        return;
    };
    let _ = client
        .post(format!(
            "{}/api/v1/auth/logout",
            base_url.trim_end_matches('/')
        ))
        .bearer_auth(token)
        .send()
        .await;
}

async fn fetch_desktop_sync_token(
    preferences: &desktop_settings::DesktopPreferences,
) -> Result<(String, bool), String> {
    let body = hosted_call(
        preferences,
        reqwest::Method::POST,
        "account/desktop-sync-token",
        Some(serde_json::json!({})),
        std::time::Duration::from_secs(20),
    )
    .await?;
    // An older service omits the flag; treat that as "sync allowed" like it always was.
    let can_sync = body
        .get("canSync")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true);
    body.get("token")
        .and_then(serde_json::Value::as_str)
        .filter(|token| !token.is_empty())
        .map(|token| (token.to_string(), can_sync))
        .ok_or_else(|| "The service sent no sync token.".to_string())
}

/// One authenticated call to the hosted service as the signed-in user. `path` is relative to
/// `/api/v1/` and is always chosen by this app, never by the UI.
async fn hosted_call(
    preferences: &desktop_settings::DesktopPreferences,
    method: reqwest::Method,
    path: &str,
    body: Option<serde_json::Value>,
    timeout: std::time::Duration,
) -> Result<serde_json::Value, String> {
    let service = desktop_settings::hosted_session(preferences).ok_or_else(|| {
        "Sign in to your AI Notetaker account in Settings → Account & sync.".to_string()
    })?;
    if !hosted_url_is_allowed(&service.base_url) {
        return Err("The hosted service address must use https.".into());
    }
    let client = notetaker_core::providers::http_client_builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("Could not start the request: {error}"))?;
    let mut request = client
        .request(method, format!("{}/api/v1/{path}", service.base_url))
        .bearer_auth(&service.access_token)
        .header("x-workspace-id", &service.workspace_id);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.map_err(|_| {
        "Could not reach the AI Notetaker service. Check your internet connection and try again."
            .to_string()
    })?;
    let status = response.status().as_u16();
    let body = response
        .json::<serde_json::Value>()
        .await
        .unwrap_or(serde_json::Value::Null);
    interpret_hosted_response(status, body)
}

/// Success and structured refusals (`{ok:false,error}` on a 4xx) are returned to the screen to
/// show; an ended session and unexpected failures become plain error messages.
fn interpret_hosted_response(
    status: u16,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if status == 401 {
        return Err("Your session ended. Sign in again in Settings → Account & sync.".into());
    }
    if (200..300).contains(&status)
        || body.get("ok").is_some()
        || body.get("portalRequired").is_some()
    {
        return Ok(body);
    }
    Err(body
        .get("error")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("The service could not complete that ({status}). Try again.")))
}

fn current_preferences(context: &DesktopCommandContext) -> desktop_settings::DesktopPreferences {
    context
        .preferences
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

/// Plan, usage (meetings, audio hours, questions) and what the owner can buy or manage.
#[tauri::command]
async fn desktop_account_overview(
    context: tauri::State<'_, DesktopCommandContext>,
) -> Result<serde_json::Value, String> {
    hosted_call(
        &current_preferences(&context),
        reqwest::Method::GET,
        "account/overview",
        None,
        std::time::Duration::from_secs(20),
    )
    .await
}

#[tauri::command]
async fn desktop_team_roster(
    context: tauri::State<'_, DesktopCommandContext>,
) -> Result<serde_json::Value, String> {
    hosted_call(
        &current_preferences(&context),
        reqwest::Method::GET,
        "team",
        None,
        std::time::Duration::from_secs(20),
    )
    .await
}

#[tauri::command]
async fn desktop_team_action(
    context: tauri::State<'_, DesktopCommandContext>,
    operation: String,
    id: Option<String>,
    email: Option<String>,
    role: Option<String>,
) -> Result<serde_json::Value, String> {
    if !matches!(
        operation.as_str(),
        "invite" | "add" | "role" | "remove" | "reset" | "revoke-invite"
    ) {
        return Err("Unknown team action.".into());
    }
    hosted_call(
        &current_preferences(&context),
        reqwest::Method::POST,
        "team",
        Some(serde_json::json!({
            "operation": operation,
            "id": id.unwrap_or_default(),
            "email": email.unwrap_or_default(),
            "role": role.unwrap_or_default(),
        })),
        std::time::Duration::from_secs(30),
    )
    .await
}

/// Opens Stripe Checkout for `price_id` or, with `manage`, the billing portal (upgrade,
/// change plan, payment method, cancel). A workspace with a live plan is sent to the portal.
#[tauri::command]
async fn desktop_account_billing(
    context: tauri::State<'_, DesktopCommandContext>,
    price_id: Option<String>,
    manage: bool,
) -> Result<(), String> {
    let preferences = current_preferences(&context);
    let base = desktop_settings::hosted_session(&preferences)
        .ok_or_else(|| {
            "Sign in to your AI Notetaker account in Settings → Account & sync.".to_string()
        })?
        .base_url;
    let timeout = std::time::Duration::from_secs(30);
    let mut reply = None;
    if !manage {
        let price_id = price_id
            .filter(|id| !id.is_empty())
            .ok_or_else(|| "Choose a plan first.".to_string())?;
        let checkout = hosted_call(
            &preferences,
            reqwest::Method::POST,
            "billing/checkout",
            Some(serde_json::json!({
                "priceId": price_id,
                "successUrl": format!("{base}/billing?checkout=success"),
                "cancelUrl": format!("{base}/billing?checkout=cancelled"),
            })),
            timeout,
        )
        .await?;
        if checkout.get("portalRequired").is_none() {
            reply = Some(checkout);
        }
    }
    let reply = match reply {
        Some(reply) => reply,
        None => {
            hosted_call(
                &preferences,
                reqwest::Method::POST,
                "billing/portal",
                Some(serde_json::json!({})),
                timeout,
            )
            .await?
        }
    };
    let url = reply
        .get("url")
        .and_then(serde_json::Value::as_str)
        .filter(|url| billing_url_is_allowed(url, &base))
        .ok_or_else(|| {
            "The billing page could not be opened. Try again, or use the web app.".to_string()
        })?;
    open_external(url)
}

/// Only Stripe's checkout and billing-portal pages, or a page on the signed-in service itself,
/// are opened from a billing reply, so a compromised or mistyped service cannot send the user
/// to an arbitrary site from a trusted-looking button.
fn billing_url_is_allowed(url: &str, service_base: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    if parsed.scheme() != "https" || !parsed.username().is_empty() || parsed.password().is_some() {
        return false;
    }
    let Some(host) = parsed.host_str() else {
        return false;
    };
    if host == "checkout.stripe.com" || host == "billing.stripe.com" {
        return true;
    }
    reqwest::Url::parse(service_base)
        .ok()
        .and_then(|base| base.host_str().map(|base_host| base_host == host))
        .unwrap_or(false)
}

#[tauri::command]
async fn desktop_hosted_sign_out(
    context: tauri::State<'_, DesktopCommandContext>,
) -> Result<desktop_settings::DesktopSettingsView, String> {
    let previous = context
        .preferences
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    // End the session on the server too, so a copied token stops working at once. Best effort:
    // offline sign-out must still work, and the token expires on its own regardless.
    if let Err(error) = hosted_call(
        &previous,
        reqwest::Method::POST,
        "auth/logout",
        Some(serde_json::json!({})),
        std::time::Duration::from_secs(8),
    )
    .await
    {
        tracing::debug!(%error, "server-side sign-out did not complete");
    }
    desktop_settings::set_hosted_token(None)?;
    // Going back to offline also disconnects the cloud sync that signing in turned on. A sync
    // token the user pasted themselves is left alone.
    let mut disconnect_sync = false;
    if previous.sync_from_sign_in {
        if let Ok(Some(sync_token)) = desktop_settings::get_webapp_token() {
            if let Some(account) = &previous.hosted_account {
                revoke_token(&account.base_url, &sync_token).await;
            }
            disconnect_sync = desktop_settings::set_webapp_token(None).is_ok();
        }
    }
    let preferences = desktop_settings::DesktopPreferences {
        processing: desktop_settings::ProcessingChoice::Local,
        hosted_account: None,
        sync_from_sign_in: previous.sync_from_sign_in && !disconnect_sync,
        ..previous
    };
    preferences.save(&context.app.data_dir)?;
    apply_preferences(context.inner(), preferences).await
}

async fn apply_preferences(
    context: &DesktopCommandContext,
    preferences: desktop_settings::DesktopPreferences,
) -> Result<desktop_settings::DesktopSettingsView, String> {
    *context
        .preferences
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = preferences.clone();
    let keys = desktop_settings::load_api_keys()?;
    let webapp = desktop_settings::wire_webapp_config(&preferences.webapp_url)?;
    handle_message(
        context.app.clone(),
        context.tray.clone(),
        make_settings_message(&preferences, keys.clone(), webapp),
        context.output.clone(),
    )
    .await;
    let has_webapp_token =
        desktop_settings::get_webapp_token()?.is_some_and(|token| !token.trim().is_empty());
    Ok(desktop_settings::settings_view(
        preferences,
        &keys,
        has_webapp_token,
    ))
}

#[tauri::command]
async fn desktop_import_transfer(
    context: tauri::State<'_, DesktopCommandContext>,
    contents: String,
) -> Result<desktop_migration::MigrationImportReport, String> {
    let archive = desktop_migration::parse_archive_json(&contents)?;
    let imported_preferences = archive.settings.clone();
    let store = context.app.store.clone();
    let report =
        tokio::task::spawn_blocking(move || desktop_migration::import_archive(archive, &store))
            .await
            .map_err(|_| "Desktop transfer import stopped unexpectedly.".to_string())??;

    apply_imported_desktop_preferences(context.inner(), imported_preferences).await?;
    Ok(report)
}

#[tauri::command]
async fn desktop_import_audio_transfer(
    context: tauri::State<'_, DesktopCommandContext>,
) -> Result<Option<desktop_migration::MigrationImportReport>, String> {
    let (selected_tx, selected_rx) = tokio::sync::oneshot::channel();
    context
        .ui_app
        .dialog()
        .file()
        .add_filter("AI Notetaker archive", &["ntarchive"])
        .pick_file(move |path| {
            let _ = selected_tx.send(path);
        });
    let Some(selected) = selected_rx
        .await
        .map_err(|_| "The archive picker could not open.".to_string())?
    else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|_| "The selected archive path is invalid.".to_string())?;
    let store = context.app.store.clone();
    let (report, imported_preferences) = tokio::task::spawn_blocking(move || {
        desktop_migration::import_audio_archive_file(&path, &store)
    })
    .await
    .map_err(|_| "Audio archive import stopped unexpectedly.".to_string())??;
    apply_imported_desktop_preferences(context.inner(), imported_preferences).await?;
    Ok(Some(report))
}

async fn apply_imported_desktop_preferences(
    context: &DesktopCommandContext,
    imported_preferences: desktop_migration::MigrationSettings,
) -> Result<(), String> {
    let current = context
        .preferences
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    let preferences = desktop_settings::DesktopPreferences {
        transcription_provider: imported_preferences.transcription_provider,
        summarization_provider: imported_preferences.summarization_provider,
        default_meeting_mode: imported_preferences.default_meeting_mode,
        custom_vocabulary: imported_preferences
            .custom_vocabulary
            .into_iter()
            .map(|term| term.trim().to_string())
            .filter(|term| !term.is_empty())
            .collect(),
        custom_summary_instructions: imported_preferences
            .custom_summary_instructions
            .trim()
            .to_string(),
        // The archive deliberately contains no web-app URL or token.
        webapp_url: current.webapp_url,
        processing: current.processing,
        hosted_account: current.hosted_account,
        sync_from_sign_in: current.sync_from_sign_in,
    };
    preferences.save(&context.app.data_dir)?;
    *context
        .preferences
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = preferences.clone();
    let keys = desktop_settings::load_api_keys()?;
    let webapp = desktop_settings::wire_webapp_config(&preferences.webapp_url)?;
    handle_message(
        context.app.clone(),
        context.tray.clone(),
        make_settings_message(&preferences, keys, webapp),
        context.output.clone(),
    )
    .await;
    Ok(())
}

#[tauri::command]
async fn desktop_start_recording(
    context: tauri::State<'_, DesktopCommandContext>,
    title: String,
    consent_acknowledged: bool,
) -> Result<String, String> {
    if !consent_acknowledged {
        return Err("Confirm that everyone has been told recording is starting.".into());
    }
    let title = title.trim();
    if title.chars().count() > 200 || title.chars().any(char::is_control) {
        return Err("Meeting title must be 200 characters or fewer.".into());
    }
    let preferences = context
        .preferences
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    let keys = desktop_settings::load_api_keys()?;
    processing_ready(&preferences, &keys)?;
    let processing_mode = match desktop_settings::hosted_service(&preferences) {
        Some(service) => ProcessingMode::Managed {
            account_id: service.account_id,
            workspace_id: service.workspace_id,
            plan: service.plan,
        },
        None => ProcessingMode::LocalByok,
    };

    let meeting_id = Uuid::new_v4();
    handle_message(
        context.app.clone(),
        context.tray.clone(),
        ExtensionToHelper::StartRecording {
            meeting_id,
            title: (!title.is_empty()).then(|| title.to_string()),
            meeting_mode: preferences.default_meeting_mode,
            capture_source: CaptureSource::DesktopLoopback,
            processing_mode,
        },
        context.output.clone(),
    )
    .await;
    if !context.app.active.lock().await.contains_key(&meeting_id) {
        return Err(
            "Recording did not start. Check audio permissions and the audio setup message.".into(),
        );
    }
    Ok(meeting_id.to_string())
}

#[tauri::command]
async fn desktop_stop_recording(
    context: tauri::State<'_, DesktopCommandContext>,
    meeting_id: String,
) -> Result<(), String> {
    let meeting_id = Uuid::parse_str(&meeting_id).map_err(|_| "Invalid meeting id.".to_string())?;
    handle_message(
        context.app.clone(),
        context.tray.clone(),
        ExtensionToHelper::StopRecording {
            meeting_id,
            flagged_moments: Vec::new(),
        },
        context.output.clone(),
    )
    .await;
    Ok(())
}

#[tauri::command]
async fn desktop_recover_meeting(
    context: tauri::State<'_, DesktopCommandContext>,
    meeting_id: String,
) -> Result<(), String> {
    let meeting_id = Uuid::parse_str(&meeting_id).map_err(|_| "Invalid meeting id.".to_string())?;
    start_desktop_recovery(context.inner().clone(), meeting_id).await
}

#[tauri::command]
async fn desktop_reprocess_extension_audio(
    context: tauri::State<'_, DesktopCommandContext>,
    meeting_id: String,
) -> Result<String, String> {
    let source_id = Uuid::parse_str(&meeting_id).map_err(|_| "Invalid meeting id.".to_string())?;
    let preferences = context
        .preferences
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    let keys = desktop_settings::load_api_keys()?;
    resolve_keys(
        preferences.transcription_provider,
        preferences.summarization_provider,
        &keys,
    )?;
    {
        let mut recovering = context.app.recovering.lock().await;
        if !recovering.insert(source_id) {
            return Err("Audio is already being prepared for notes.".into());
        }
    }
    let store = context.app.store.clone();
    let copy_result =
        tokio::task::spawn_blocking(move || store.create_extension_audio_reprocess_copy(source_id))
            .await;
    context.app.recovering.lock().await.remove(&source_id);
    let copy_id = copy_result
        .map_err(|_| "The desktop copy could not be created.".to_string())?
        .map_err(|_| {
            "The imported audio could not be copied. The original note is unchanged.".to_string()
        })?;
    let copy_meta = context
        .app
        .store
        .load_meta(copy_id)
        .map_err(|_| "The desktop copy could not be opened.".to_string())?;
    if copy_meta.state == notetaker_core::storage::MeetingState::Recording {
        start_desktop_recovery(context.inner().clone(), copy_id).await?;
    }
    Ok(copy_id.to_string())
}

async fn start_desktop_recovery(
    context: DesktopCommandContext,
    meeting_id: Uuid,
) -> Result<(), String> {
    if context.app.active.lock().await.contains_key(&meeting_id) {
        return Err("This recording is already in progress.".into());
    }
    let meta = context
        .app
        .store
        .load_meta(meeting_id)
        .map_err(|_| "This saved recording could not be found.".to_string())?;
    if meta.state != notetaker_core::storage::MeetingState::Recording || meta.text_only_import {
        return Err("This meeting has no recoverable desktop recording.".into());
    }
    let has_audio = ["mic.pcm", "speaker.pcm"].iter().any(|channel| {
        std::fs::metadata(context.app.store.audio_path(meeting_id, channel))
            .is_ok_and(|file| file.len() > 0)
    });
    if !has_audio {
        return Err("No saved audio was found for this recording.".into());
    }
    if context
        .app
        .retry_tasks
        .lock()
        .await
        .get(&meeting_id)
        .is_some_and(|worker| !worker._task.is_finished())
    {
        return Err("Recovery is already processing this recording.".into());
    }
    let preferences = context
        .preferences
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    let keys = desktop_settings::load_api_keys()?;
    resolve_keys(
        preferences.transcription_provider,
        preferences.summarization_provider,
        &keys,
    )?;
    if meta.managed_pending {
        // Hosted processing is not offered any more; the saved audio is processed with the
        // user's own keys instead of waiting for a service that will not run it.
        context
            .app
            .store
            .release_managed_to_local(meeting_id)
            .map_err(|error| error.to_string())?;
    }
    let mut recovering = context.app.recovering.lock().await;
    if !recovering.insert(meeting_id) {
        return Err("Recovery is already running for this recording.".into());
    }
    drop(recovering);

    let app = context.app.clone();
    let tray = context.tray.clone();
    let output = context.output.clone();
    let recovering = app.clone();
    let settings = make_settings_message(&preferences, keys, None);
    tokio::spawn(async move {
        handle_message(app.clone(), tray.clone(), settings, output.clone()).await;
        handle_message(
            app.clone(),
            tray,
            ExtensionToHelper::ResumeRecording { meeting_id },
            output,
        )
        .await;
        recovering.recovering.lock().await.remove(&meeting_id);
    });
    Ok(())
}

#[tauri::command]
async fn desktop_get_meeting(
    context: tauri::State<'_, DesktopCommandContext>,
    meeting_id: String,
) -> Result<DesktopMeetingDetail, String> {
    let meeting_id = Uuid::parse_str(&meeting_id).map_err(|_| "Invalid meeting id.".to_string())?;
    let folder_id = context
        .library
        .snapshot()
        .ok()
        .and_then(|library| library.placements.get(&meeting_id).map(ToString::to_string));
    let store = context.app.store.clone();
    let active = context.app.active.lock().await.contains_key(&meeting_id);
    tokio::task::spawn_blocking(move || {
        let meta = store
            .load_meta(meeting_id)
            .map_err(|error| format!("Meeting could not be opened: {error}"))?;
        let transcript = store
            .load_transcript(meeting_id)
            .map_err(|error| format!("Transcript could not be opened: {error}"))?;
        let summary = store
            .load_summary(meeting_id)
            .map_err(|error| format!("Summary could not be opened: {error}"))?;
        let reprocessed_sources = store
            .scan_meetings()
            .map_err(|error| format!("Meeting history could not be read: {error}"))?
            .readable
            .into_iter()
            .filter_map(|candidate| candidate.reprocessed_from)
            .collect::<HashSet<_>>();
        let reprocessed_from = meta.reprocessed_from;
        let can_reprocess_extension_audio = !meta.text_only_import
            && meta.extension_source_status.is_some()
            && reprocessed_from.is_none()
            && !reprocessed_sources.contains(&meta.id)
            && (store.audio_len(meta.id, "mic.pcm").unwrap_or(0) > 0
                || store.audio_len(meta.id, "speaker.pcm").unwrap_or(0) > 0);
        let status = if active {
            "recording"
        } else if meta.state == notetaker_core::storage::MeetingState::Recording {
            "recovered"
        } else if summary.is_some() {
            "complete"
        } else if meta.summary_pending || meta.managed_pending {
            "processing"
        } else {
            "saved"
        };
        Ok(DesktopMeetingDetail {
            meeting: DesktopMeetingSummary {
                id: meta.id.to_string(),
                title: meta.title.unwrap_or_else(|| {
                    format!("Meeting on {}", meta.started_at.format("%b %-d, %Y"))
                }),
                started_at: meta.started_at.to_rfc3339(),
                ended_at: meta.ended_at.map(|ended| ended.to_rfc3339()),
                status: status.to_string(),
                summary: summary.as_ref().map(|value| value.summary.clone()),
                action_items: summary.map_or_else(Vec::new, |value| value.action_items),
                active,
                text_only_import: meta.text_only_import,
                extension_source_status: meta.extension_source_status,
                reprocessed_from: reprocessed_from.map(|id| id.to_string()),
                can_reprocess_extension_audio,
                folder_id,
            },
            transcript,
        })
    })
    .await
    .map_err(|error| format!("Meeting detail request failed: {error}"))?
}

#[tauri::command]
async fn desktop_delete_meeting(
    context: tauri::State<'_, DesktopCommandContext>,
    meeting_id: String,
) -> Result<(), String> {
    let meeting_id = Uuid::parse_str(&meeting_id).map_err(|_| "Invalid meeting id.".to_string())?;
    delete_meeting_data(&context.app, &context.tray, meeting_id)
        .await
        .map_err(|error| format!("Recording could not be deleted: {error}"))?;
    let _ = context.sync.remove(meeting_id);
    if let Err(error) = context.sync.dismiss(meeting_id) {
        tracing::warn!(%error, "could not remember a deleted note for sync");
    }
    Ok(())
}

fn optional_folder_id(value: Option<String>) -> Result<Option<Uuid>, String> {
    value
        .map(|id| Uuid::parse_str(&id).map_err(|_| "Invalid folder id.".to_string()))
        .transpose()
}

#[tauri::command]
async fn desktop_create_folder(
    context: tauri::State<'_, DesktopCommandContext>,
    name: String,
    parent_id: Option<String>,
) -> Result<desktop_library::Folder, String> {
    let parent_id = optional_folder_id(parent_id)?;
    let library = context.library.clone();
    tokio::task::spawn_blocking(move || library.create(parent_id, &name))
        .await
        .map_err(|error| format!("Folder could not be created: {error}"))?
}

#[tauri::command]
async fn desktop_rename_folder(
    context: tauri::State<'_, DesktopCommandContext>,
    folder_id: String,
    name: String,
) -> Result<(), String> {
    let id = Uuid::parse_str(&folder_id).map_err(|_| "Invalid folder id.".to_string())?;
    let library = context.library.clone();
    tokio::task::spawn_blocking(move || library.rename(id, &name))
        .await
        .map_err(|error| format!("Folder could not be renamed: {error}"))?
}

#[tauri::command]
async fn desktop_move_folder(
    context: tauri::State<'_, DesktopCommandContext>,
    folder_id: String,
    parent_id: Option<String>,
) -> Result<(), String> {
    let id = Uuid::parse_str(&folder_id).map_err(|_| "Invalid folder id.".to_string())?;
    let parent_id = optional_folder_id(parent_id)?;
    let library = context.library.clone();
    tokio::task::spawn_blocking(move || library.move_folder(id, parent_id))
        .await
        .map_err(|error| format!("Folder could not be moved: {error}"))?
}

#[tauri::command]
async fn desktop_delete_folder(
    context: tauri::State<'_, DesktopCommandContext>,
    folder_id: String,
) -> Result<(), String> {
    let id = Uuid::parse_str(&folder_id).map_err(|_| "Invalid folder id.".to_string())?;
    let library = context.library.clone();
    tokio::task::spawn_blocking(move || library.delete_empty(id))
        .await
        .map_err(|error| format!("Folder could not be deleted: {error}"))?
}

#[tauri::command]
async fn desktop_move_meeting(
    context: tauri::State<'_, DesktopCommandContext>,
    meeting_id: String,
    folder_id: Option<String>,
) -> Result<(), String> {
    let id = Uuid::parse_str(&meeting_id).map_err(|_| "Invalid meeting id.".to_string())?;
    let folder_id = optional_folder_id(folder_id)?;
    let store = context.app.store.clone();
    let library = context.library.clone();
    tokio::task::spawn_blocking(move || {
        store
            .load_meta(id)
            .map_err(|_| "The recording no longer exists.".to_string())?;
        library.move_meeting(id, folder_id)
    })
    .await
    .map_err(|error| format!("Recording could not be moved: {error}"))?
}

#[tauri::command]
async fn desktop_sync_existing_notes(
    context: tauri::State<'_, DesktopCommandContext>,
) -> Result<usize, String> {
    let store = context.app.store.clone();
    let sync = context.sync.clone();
    let ids = tokio::task::spawn_blocking(move || {
        let scan = store
            .scan_meetings()
            .map_err(|e| format!("Meeting history could not be read: {e}"))?;
        let mut ids = Vec::new();
        for meta in scan.readable {
            if meta.state == notetaker_core::storage::MeetingState::Processed
                && meta.managed_account_id.is_none()
                && meta.managed_workspace_id.is_none()
                && !meta.workspace_import
                && !sync.is_legacy_workspace_import(meta.id)
                && store.load_summary(meta.id).ok().flatten().is_some()
            {
                ids.push(meta.id);
            }
        }
        Ok::<_, String>(ids)
    })
    .await
    .map_err(|_| "Meeting history scan failed.".to_string())??;
    let count = ids.len();
    for id in ids {
        context.sync.enqueue(id)?;
    }
    spawn_desktop_sync(
        context.app.clone(),
        context.preferences.clone(),
        context.sync.clone(),
        context.ui_app.clone(),
    );
    Ok(count)
}

/// Marks one action item done or open in `summary` and returns the item's workspace id, if it has one.
fn set_action_status(
    summary: &mut notetaker_core::providers::Summary,
    index: usize,
    done: bool,
) -> Result<Option<String>, String> {
    let item = summary
        .action_items
        .get_mut(index)
        .ok_or_else(|| "That action item is no longer in this note.".to_string())?;
    item.status = Some(if done { "done" } else { "open" }.to_string());
    item.completed_at = done.then(|| chrono::Utc::now().to_rfc3339());
    Ok(item.id.clone())
}

/// Ticks an action item on or off, the same as on the web Actions page. Notes that live in the
/// workspace (hosted, or copied from it) are updated there first so every device agrees; notes
/// that only exist on this device change locally and sync like any other edit once signed in.
#[tauri::command]
async fn desktop_set_action_item(
    context: tauri::State<'_, DesktopCommandContext>,
    meeting_id: String,
    index: usize,
    done: bool,
) -> Result<(), String> {
    let id = Uuid::parse_str(&meeting_id).map_err(|_| "Invalid note id.".to_string())?;
    let store = context.app.store.clone();
    let (meta, mut summary) = {
        let store = store.clone();
        tokio::task::spawn_blocking(move || -> Result<_, String> {
            let meta = store
                .load_meta(id)
                .map_err(|_| "This note is no longer available.".to_string())?;
            let summary = store
                .load_summary(id)
                .map_err(|_| "This note's action items could not be read.".to_string())?
                .ok_or_else(|| "This note has no action items yet.".to_string())?;
            Ok((meta, summary))
        })
        .await
        .map_err(|_| "Action items could not be read.".to_string())??
    };
    let item_id = set_action_status(&mut summary, index, done)?;
    let preferences = current_preferences(&context);
    let webapp = desktop_settings::wire_webapp_config(&preferences.webapp_url)?;
    let workspace_owned = meta.workspace_import || meta.managed_workspace_id.is_some();
    if workspace_owned {
        let webapp = webapp.as_ref().ok_or_else(|| {
            "Sign in to update action items on a note that lives in your workspace.".to_string()
        })?;
        let item_id = item_id.ok_or_else(|| {
            "This action item has not reached your workspace yet. Sync, then try again.".to_string()
        })?;
        let client = notetaker_core::providers::http_client_builder()
            .connect_timeout(std::time::Duration::from_secs(8))
            .timeout(std::time::Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "Could not start the request.".to_string())?;
        let response = client
            .patch(format!(
                "{}/api/v1/desktop-sync/action-items/{}",
                webapp.url.trim_end_matches('/'),
                item_id
            ))
            .bearer_auth(&webapp.token)
            .json(&serde_json::json!({ "status": if done { "done" } else { "open" } }))
            .send()
            .await
            .map_err(|_| "Could not reach your workspace. Connect to the internet to change this action item.".to_string())?;
        match response.status().as_u16() {
            200..=299 => {}
            401 | 403 => return Err(
                "Your sign-in no longer has access to this workspace. Sign in again in Settings."
                    .into(),
            ),
            404 => return Err("That action item is no longer in your workspace.".into()),
            status => {
                return Err(format!(
                    "Your workspace could not update the action item ({status}). Try again."
                ))
            }
        }
    }
    tokio::task::spawn_blocking(move || store.write_summary(id, &summary))
        .await
        .map_err(|_| "The action item could not be saved.".to_string())?
        .map_err(|_| "The action item could not be saved on this device.".to_string())?;
    if !workspace_owned && webapp.is_some() {
        context.sync.enqueue(id)?;
        spawn_desktop_sync(
            context.app.clone(),
            context.preferences.clone(),
            context.sync.clone(),
            context.ui_app.clone(),
        );
    }
    Ok(())
}

/// Saves a note export through the system's save dialog. The text comes from the app's own
/// screen; the user picks the destination. Returns false when the dialog is dismissed.
#[tauri::command]
async fn desktop_save_text_file(
    context: tauri::State<'_, DesktopCommandContext>,
    file_name: String,
    contents: String,
) -> Result<bool, String> {
    if contents.len() > 20 * 1024 * 1024 {
        return Err("This note is too large to export as one file.".into());
    }
    let safe_name: String = file_name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | ' ') {
                c
            } else {
                '-'
            }
        })
        .take(120)
        .collect();
    let extension = if safe_name.ends_with(".md") {
        "md"
    } else {
        "txt"
    };
    let (tx, rx) = tokio::sync::oneshot::channel();
    context
        .ui_app
        .dialog()
        .file()
        .set_file_name(&safe_name)
        .add_filter(
            if extension == "md" {
                "Markdown"
            } else {
                "Text"
            },
            &[extension],
        )
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    let Some(chosen) = rx
        .await
        .map_err(|_| "The save dialog could not open.".to_string())?
    else {
        return Ok(false);
    };
    let path = chosen
        .into_path()
        .map_err(|_| "That location cannot be used.".to_string())?;
    tokio::task::spawn_blocking(move || std::fs::write(path, contents))
        .await
        .map_err(|_| "The file could not be saved.".to_string())?
        .map_err(|error| format!("The file could not be saved: {error}"))?;
    Ok(true)
}

#[tauri::command]
async fn desktop_retry_webapp_sync(
    context: tauri::State<'_, DesktopCommandContext>,
) -> Result<(), String> {
    spawn_desktop_sync(
        context.app.clone(),
        context.preferences.clone(),
        context.sync.clone(),
        context.ui_app.clone(),
    );
    Ok(())
}

fn spawn_desktop_sync(
    app: Arc<AppState>,
    preferences: Arc<std::sync::Mutex<desktop_settings::DesktopPreferences>>,
    sync: Arc<DesktopSync>,
    ui_app: tauri::AppHandle<tauri::Wry>,
) {
    tauri::async_runtime::spawn(async move {
        let _ = run_desktop_sync(app, preferences, sync, ui_app).await;
    });
}

#[tauri::command]
async fn desktop_test_audio(
    context: tauri::State<'_, DesktopCommandContext>,
) -> Result<(), String> {
    context.app.audio_diagnostics.invalidate();
    handle_message(
        context.app.clone(),
        context.tray.clone(),
        ExtensionToHelper::AudioProbe,
        context.output.clone(),
    )
    .await;
    Ok(())
}

/// Opens the operating system's own page for fixing audio access: Screen Recording on
/// macOS, microphone privacy on Windows, and the sound settings on Linux.
#[tauri::command]
fn desktop_open_screen_recording_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        open_external(
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        )
    }
    #[cfg(target_os = "windows")]
    {
        open_external("ms-settings:privacy-microphone")
    }
    #[cfg(target_os = "linux")]
    {
        for (program, args) in [
            ("gnome-control-center", &["sound"][..]),
            ("systemsettings", &["kcm_pulseaudio"][..]),
            ("pavucontrol", &[][..]),
        ] {
            if std::process::Command::new(program)
                .args(args)
                .spawn()
                .is_ok()
            {
                return Ok(());
            }
        }
        Err("Open your system's sound settings to choose a microphone and output.".into())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        Err("Open your operating system's sound settings.".into())
    }
}

#[tauri::command]
fn desktop_open_about_link(page: String) -> Result<(), String> {
    let site = desktop_settings::DEFAULT_WEBAPP_URL;
    let url = match page.as_str() {
        "privacy" => format!("{site}/privacy"),
        "terms" => format!("{site}/terms"),
        "license" => "https://github.com/apercallc/ai-notetaker/blob/main/LICENSE".to_string(),
        "third-party" => {
            "https://github.com/apercallc/ai-notetaker/blob/main/docs/third-party-licenses.md"
                .to_string()
        }
        "source" => "https://github.com/apercallc/ai-notetaker".to_string(),
        "issues" => "https://github.com/apercallc/ai-notetaker/issues".to_string(),
        _ => return Err("Unknown link.".into()),
    };
    open_external(&url)
}

#[tauri::command]
fn desktop_open_blackhole_download() -> Result<(), String> {
    open_external("https://existential.audio/blackhole/")
}

async fn run_desktop_sync(
    app: Arc<AppState>,
    preferences: Arc<std::sync::Mutex<desktop_settings::DesktopPreferences>>,
    sync: Arc<DesktopSync>,
    ui_app: tauri::AppHandle<tauri::Wry>,
) -> Result<bool, String> {
    let preferences = preferences
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    let url = desktop_settings::normalize_webapp_url(&preferences.webapp_url)?;
    let token = desktop_settings::get_webapp_token()?;
    // True when the service answered an upload with 402: the workspace has no active plan. Uploads
    // wait (nothing is lost), but downloading workspace notes below still runs, so a lapsed
    // account can always bring its cloud notes to this device.
    let mut plan_blocked = false;
    if let (Some(url), Some(token)) = (url, token.filter(|token| !token.trim().is_empty())) {
        if let Err(error) = sync.sync_pending(app.store.clone(), &url, &token).await {
            plan_blocked = error.contains("HTTP 402");
            tracing::warn!(%error, "desktop note sync attempt failed");
        }
        if let Err(error) = sync
            .pull_workspace_notes(app.store.clone(), &url, &token)
            .await
        {
            sync.record_sync_error(error.clone());
            tracing::warn!(%error, "workspace note pull failed");
        }
    }
    let configured = !preferences.webapp_url.is_empty()
        && desktop_settings::get_webapp_token()?.is_some_and(|token| !token.trim().is_empty());
    if let Err(error) = ui_app.emit("webapp-sync-updated", sync.status(configured)) {
        tracing::debug!(%error, "desktop sync status event could not be emitted");
    }
    Ok(plan_blocked)
}

#[tauri::command]
fn desktop_open_notes_folder(
    context: tauri::State<'_, DesktopCommandContext>,
) -> Result<(), String> {
    let path = context.app.data_dir.join("meetings");
    std::fs::create_dir_all(&path)
        .map_err(|error| format!("Notes folder could not be opened: {error}"))?;
    open_external(path.to_string_lossy().as_ref())
}

#[tauri::command]
fn desktop_open_webapp(context: tauri::State<'_, DesktopCommandContext>) -> Result<(), String> {
    let preferences = context
        .preferences
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let url = desktop_settings::normalize_webapp_url(&preferences.webapp_url)?
        .unwrap_or_else(|| desktop_settings::DEFAULT_WEBAPP_URL.to_string());
    open_external(&url)
}

/// The web page, relative to the web app, for a named place in the desktop app. The UI only ever
/// names the place; the path is chosen here so it can never point somewhere else.
fn web_page_path(page: &str) -> Option<&'static str> {
    match page {
        "library" => Some("/meetings"),
        "account" | "devices" | "data" => Some("/account"),
        "billing" | "plan" => Some("/billing"),
        "team" => Some("/team"),
        _ => None,
    }
}

/// Opens the matching page of the web app the user is signed in to (or the default service).
#[tauri::command]
fn desktop_open_web_page(
    context: tauri::State<'_, DesktopCommandContext>,
    page: String,
) -> Result<(), String> {
    let path = web_page_path(&page).ok_or_else(|| "Unknown web page.".to_string())?;
    let preferences = current_preferences(&context);
    let base = preferences
        .hosted_account
        .as_ref()
        .map(|account| account.base_url.clone())
        .or_else(|| {
            desktop_settings::normalize_webapp_url(&preferences.webapp_url)
                .ok()
                .flatten()
        })
        .unwrap_or_else(|| desktop_settings::DEFAULT_WEBAPP_URL.to_string());
    open_external(&format!("{}{path}", base.trim_end_matches('/')))
}

#[tauri::command]
fn desktop_open_webapp_conflict(
    context: tauri::State<'_, DesktopCommandContext>,
    conflict_key: String,
) -> Result<(), String> {
    let (conflict_meeting_id, source_url, reason) = context
        .sync
        .conflict_webapp_target(&conflict_key)
        .ok_or_else(|| "This sync conflict is no longer available.".to_string())?;
    let base_url = desktop_settings::normalize_webapp_url(&source_url)?
        .ok_or_else(|| "The web-app address for this conflict is unavailable.".to_string())?;
    let path = match reason {
        SyncConflictReason::Updated => format!("/meetings/{conflict_meeting_id}"),
        SyncConflictReason::Trashed => "/trash".to_string(),
        SyncConflictReason::Removed => {
            return Err("This web note was removed. Choose whether to recreate it or keep the desktop copy here.".into());
        }
    };
    let target = reqwest::Url::parse(&base_url)
        .and_then(|url| url.join(&path))
        .map_err(|_| "The web version could not be opened.".to_string())?;
    open_external(target.as_str())
}

#[tauri::command]
fn desktop_resolve_webapp_conflict(
    context: tauri::State<'_, DesktopCommandContext>,
    conflict_key: String,
    resolution: String,
) -> Result<(), String> {
    let keep_desktop = match resolution.as_str() {
        "use_desktop" => true,
        "keep_separate" => false,
        _ => return Err("Choose a valid sync conflict resolution.".into()),
    };
    context.sync.resolve_conflict(&conflict_key, keep_desktop)?;
    spawn_desktop_sync(
        context.app.clone(),
        context.preferences.clone(),
        context.sync.clone(),
        context.ui_app.clone(),
    );
    Ok(())
}

fn open_external(target: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(target).spawn();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("explorer").arg(target).spawn();
    #[cfg(target_os = "linux")]
    let result = std::process::Command::new("xdg-open").arg(target).spawn();
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    let result: Result<std::process::Child, std::io::Error> = Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "opening external locations is unsupported on this platform",
    ));
    result
        .map(|_| ())
        .map_err(|error| format!("Could not open this location: {error}"))
}

fn validate_secret(value: Option<String>) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.chars().count() > 10_000 || value.chars().any(char::is_control) {
        return Err("Credential is too long or contains unsupported control characters.".into());
    }
    let value = value.trim().to_string();
    Ok((!value.is_empty()).then_some(value))
}

fn apply_secret_update(target: &mut Option<String>, update: Option<String>) -> Result<(), String> {
    if let Some(update) = update {
        *target = validate_secret(Some(update))?;
    }
    Ok(())
}

fn make_settings_message(
    preferences: &desktop_settings::DesktopPreferences,
    api_keys: ApiKeys,
    webapp: Option<native_messaging::WebappConfig>,
) -> ExtensionToHelper {
    let hosted = desktop_settings::hosted_service(preferences);
    ExtensionToHelper::Settings {
        transcription_provider: preferences.transcription_provider,
        summarization_provider: preferences.summarization_provider,
        api_keys,
        webapp,
        default_meeting_mode: preferences.default_meeting_mode,
        custom_vocabulary: preferences.custom_vocabulary.clone(),
        custom_summary_instructions: (!preferences.custom_summary_instructions.is_empty())
            .then(|| preferences.custom_summary_instructions.clone()),
        processing_mode: match &hosted {
            Some(service) => ProcessingMode::Managed {
                account_id: service.account_id.clone(),
                workspace_id: service.workspace_id.clone(),
                plan: service.plan.clone(),
            },
            None => ProcessingMode::LocalByok,
        },
        managed_service: hosted,
    }
}

async fn delete_meeting_data(
    state: &AppState,
    tray: &tray::TrayController,
    meeting_id: Uuid,
) -> Result<(), notetaker_core::storage::StorageError> {
    if let Some(active) = state.active.lock().await.remove(&meeting_id) {
        if let Some(audio) = active.audio {
            let _ = audio.stop_capture().await;
        }
        active.audio_processing.finish().await;
        tray.set_recording(false);
    }
    if let Some(worker) = state.retry_tasks.lock().await.remove(&meeting_id) {
        worker.abort();
    }
    state.pipelines.lock().await.remove(&meeting_id);
    state.store.delete_meeting(meeting_id)?;
    let _ = std::fs::remove_file(state.data_dir.join(format!("retry-{meeting_id}.json")));
    if let Err(error) = state.library.forget_meeting(meeting_id) {
        tracing::warn!(%error, %meeting_id, "deleted recording remains in local folder index");
    }
    Ok(())
}

async fn handle_message(
    state: Arc<AppState>,
    tray: Arc<tray::TrayController>,
    msg: ExtensionToHelper,
    out_tx: ipc::OutSender,
) -> bool {
    match msg {
        ExtensionToHelper::Hello { pairing_token } => {
            let mut current = state.pairing_token.lock().await;
            if should_issue_pairing_token(current.as_deref(), pairing_token.as_deref()) {
                // First-ever pairing, a reinstall, or a fresh Chrome profile
                // whose local storage no longer contains the browser copy —
                // issue a new token rather than forcing manual app-data
                // surgery. Native Messaging has already allowlisted this
                // extension origin before this code runs.
                let token = native_messaging::generate_pairing_token();
                if let Err(error) =
                    write_pairing_token(&pairing_token_path(&state.data_dir), &token)
                {
                    let _ = out_tx.send(HelperToExtension::Error {
                        meeting_id: None,
                        code: ErrorCode::StorageError,
                        message: format!("could not persist pairing token: {error}"),
                    });
                    return false;
                }
                *current = Some(token.clone());
                let _ = out_tx.send(HelperToExtension::Paired {
                    pairing_token: token,
                });
            } else if let (Some(expected), Some(provided)) = (&*current, pairing_token.as_deref()) {
                if !pairing_token_matches(expected, provided) {
                    let _ = out_tx.send(HelperToExtension::Error {
                        meeting_id: None,
                        code: ErrorCode::HelperNotPaired,
                        message: "pairing token missing or mismatched".into(),
                    });
                    return false;
                }
                // Already paired and the token matches — nothing to send yet;
                // recoverable-meeting notices go out next.
            } else {
                let _ = out_tx.send(HelperToExtension::Error {
                    meeting_id: None,
                    code: ErrorCode::HelperNotPaired,
                    message: "pairing token missing or mismatched. \
                              If this browser lost its token, use the helper's tray menu: \
                              Pair New Browser, then reconnect."
                        .into(),
                });
                return false;
            }
            drop(current);

            let _ = out_tx.send(HelperToExtension::HelperInfo {
                helper_version: env!("CARGO_PKG_VERSION").to_string(),
                protocol_version: native_messaging::PROTOCOL_VERSION,
                platform: current_platform().to_string(),
            });

            // Crash recovery: surface any meeting left in `Recording`
            // state by an unclean shutdown, once per new connection.
            let active_ids: HashSet<Uuid> = state.active.lock().await.keys().copied().collect();
            for meeting_id in &active_ids {
                subscribe_meeting(&state, *meeting_id, out_tx.clone());
                let _ = out_tx.send(HelperToExtension::RecordingStarted {
                    meeting_id: *meeting_id,
                });
            }
            if let Ok(interrupted) = state.store.find_interrupted_meetings_excluding(&active_ids) {
                for meta in interrupted {
                    let _ = out_tx.send(HelperToExtension::RecoveredRecording {
                        meeting_id: meta.id,
                        started_at: meta.started_at,
                    });
                }
            }
            true
        }

        ExtensionToHelper::Settings { .. } => {
            let settings = Settings { inner: msg };
            *state.settings.lock().await = Some(settings.clone());
            start_pending_retry_workers(state.clone(), settings, out_tx.clone()).await;
            if let Ok(service) = managed_service_from_state(&state).await {
                start_pending_managed_workers(state.clone(), service, out_tx.clone()).await;
            }
            true
        }

        ExtensionToHelper::StartRecording {
            meeting_id,
            title,
            meeting_mode,
            capture_source,
            processing_mode,
        } => {
            // One desktop capture session at a time: starting a second would stop the first's
            // capture (the session is shared) while it still looks active, silently losing its audio.
            // The extension retries a start it did not hear back about; the second one must not
            // build a second pipeline and audio queue over the same files.
            if state.active.lock().await.contains_key(&meeting_id)
                || StopGuard::is_in_flight(meeting_id)
            {
                return true;
            }
            if capture_source != CaptureSource::Meet
                && state
                    .active
                    .lock()
                    .await
                    .iter()
                    .any(|(id, active)| *id != meeting_id && active.audio.is_some())
            {
                let _ = out_tx.send(HelperToExtension::Error {
                    meeting_id: Some(meeting_id),
                    code: ErrorCode::DeviceNotFound,
                    message: "Another desktop recording is already in progress. Stop it before starting a new one.".into(),
                });
                return true;
            }
            subscribe_meeting(&state, meeting_id, out_tx.clone());
            let settings_guard = state.settings.lock().await;
            let Some(settings) = settings_guard.clone() else {
                let _ = out_tx.send(HelperToExtension::Error {
                    meeting_id: Some(meeting_id),
                    code: ErrorCode::ProviderAuthFailed,
                    message: "no provider settings configured yet".into(),
                });
                return true;
            };
            drop(settings_guard);

            let ExtensionToHelper::Settings {
                transcription_provider,
                summarization_provider,
                api_keys,
                custom_vocabulary,
                custom_summary_instructions,
                ..
            } = settings.inner
            else {
                unreachable!("Settings.inner is always the Settings variant");
            };

            let (transcription, summarization): (
                Box<dyn TranscriptionProvider>,
                Box<dyn SummarizationProvider>,
            ) = if matches!(processing_mode, ProcessingMode::Managed { .. }) {
                (
                    Box::new(ManagedCaptureTranscription),
                    Box::new(ManagedCaptureSummarization),
                )
            } else {
                let (transcription_key, summarization_key) =
                    match resolve_keys(transcription_provider, summarization_provider, &api_keys) {
                        Ok(keys) => keys,
                        Err(message) => {
                            let _ = out_tx.send(HelperToExtension::Error {
                                meeting_id: Some(meeting_id),
                                code: ErrorCode::ProviderAuthFailed,
                                message,
                            });
                            return true;
                        }
                    };
                (
                    build_transcription_provider(transcription_provider, transcription_key),
                    build_summarization_provider(summarization_provider, summarization_key),
                )
            };

            let retry_path = state.data_dir.join(format!("retry-{meeting_id}.json"));
            let retry_queue: RetryQueue<RetryableChunk> =
                match RetryQueue::load_or_create(retry_path) {
                    Ok(q) => q,
                    Err(e) => {
                        let _ = out_tx.send(HelperToExtension::Error {
                            meeting_id: Some(meeting_id),
                            code: ErrorCode::StorageError,
                            message: e.to_string(),
                        });
                        return true;
                    }
                };
            let mut pipeline = Pipeline::new(
                state.store.as_ref().clone(),
                transcription,
                summarization,
                retry_queue,
            )
            .with_summary_options(summary_options(
                meeting_mode,
                custom_vocabulary,
                custom_summary_instructions,
            ));

            let started_message = match pipeline.start_recording(meeting_id) {
                Ok(started_msg) => started_msg,
                Err(e) => {
                    tray.set_recording(false);
                    let _ = state.store.mark_stopped(meeting_id, chrono::Utc::now());
                    // A start that failed before any audio was captured leaves
                    // an empty meeting directory that would haunt history and
                    // "Open Latest Note". Remove it — but only while it holds
                    // no recoverable audio; a directory with bytes on disk is
                    // never deleted.
                    remove_meeting_if_no_audio(&state.store, meeting_id);
                    let _ = out_tx.send(HelperToExtension::Error {
                        meeting_id: Some(meeting_id),
                        code: ErrorCode::DeviceNotFound,
                        message: e.to_string(),
                    });
                    return true;
                }
            };

            if matches!(processing_mode, ProcessingMode::Managed { .. }) {
                let identity = match &processing_mode {
                    ProcessingMode::Managed {
                        account_id,
                        workspace_id,
                        ..
                    } => Some((account_id.as_str(), workspace_id.as_str())),
                    ProcessingMode::LocalByok => None,
                };
                let mark_result = identity.map_or_else(
                    || state.store.mark_managed_pending(meeting_id),
                    |(account_id, workspace_id)| {
                        state.store.mark_managed_pending_for_identity(
                            meeting_id,
                            account_id,
                            workspace_id,
                        )
                    },
                );
                if let Err(error) = mark_result {
                    let _ = out_tx.send(HelperToExtension::Error {
                        meeting_id: Some(meeting_id),
                        code: ErrorCode::StorageError,
                        message: format!("could not persist managed processing state: {error}"),
                    });
                    let _ = pipeline.stop_capture_only(meeting_id);
                    tray.set_recording(false);
                    return true;
                }
            }

            if let Some(title) = title.as_deref() {
                if let Err(error) = state.store.set_title(meeting_id, title) {
                    tracing::warn!(%meeting_id, %error, "could not persist meeting title");
                }
            }

            let pipeline = Arc::new(Mutex::new(pipeline));
            state
                .pipelines
                .lock()
                .await
                .insert(meeting_id, pipeline.clone());
            let retry_task = spawn_retry_worker(meeting_id, pipeline.clone(), state.clone());
            state
                .retry_tasks
                .lock()
                .await
                .insert(meeting_id, retry_task);
            let audio_processing =
                spawn_audio_processing_queue(meeting_id, pipeline.clone(), state.clone());

            if capture_source == CaptureSource::Meet {
                state.active.lock().await.insert(
                    meeting_id,
                    ActiveRecording {
                        audio: None,
                        audio_processing,
                        capture_source,
                        processing_mode: processing_mode.clone(),
                    },
                );
                let _ = out_tx.send(started_message);
                tray.set_recording(true);
                return true;
            }

            let audio = state.audio.clone();
            let state_for_audio = state.clone();
            let audio_processing_for_audio = audio_processing.clone();
            let audio_errors = out_tx.clone();
            // One error per failure streak, not one per ~10 ms frame: a full
            // disk would otherwise flood the extension with ~100 errors/s.
            let storage_error_reported = AtomicBool::new(false);
            let live_writer = std::sync::Mutex::new(LiveAudioWriter::new(
                state.store.open_audio_appender(meeting_id),
            ));
            // A full disk cannot be recorded through: keep capturing and every frame is dropped
            // while the tray still says "recording". Stop the capture instead and leave the meeting
            // unfinished, so the next start offers to resume once space is freed.
            let disk_full_handle = tokio::runtime::Handle::current();
            let disk_full_state = state.clone();
            let disk_full_tray = tray.clone();
            let disk_full_audio = audio.clone();
            let disk_full_stopped = AtomicBool::new(false);
            let result = audio
                .start_capture(Box::new(move |frame| {
                    // Backends deliver frames on one dispatcher thread. Write
                    // synchronously there so stop joins every write, and queue
                    // provider work only after the append completes.
                    let written = live_writer
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .write(
                            &state_for_audio.store,
                            meeting_id,
                            frame.channel,
                            &frame.pcm16,
                            frame.sample_rate_hz,
                        );
                    let (existing_len, written_len, written_rate) = match written {
                        Ok(frame) => {
                            storage_error_reported.store(false, Ordering::Relaxed);
                            (frame.start, frame.len, frame.sample_rate_hz)
                        }
                        Err((code, message)) => {
                            if code == ErrorCode::DiskFull
                                && !disk_full_stopped.swap(true, Ordering::Relaxed)
                            {
                                let state = disk_full_state.clone();
                                let tray = disk_full_tray.clone();
                                let audio = disk_full_audio.clone();
                                disk_full_handle.spawn(async move {
                                    let _ = audio.stop_capture().await;
                                    if let Some(active) =
                                        state.active.lock().await.remove(&meeting_id)
                                    {
                                        active.audio_processing.finish().await;
                                    }
                                    tray.set_recording(false);
                                    tray.set_attention(true);
                                });
                            }
                            if !storage_error_reported.swap(true, Ordering::Relaxed) {
                                let _ = audio_errors.send(HelperToExtension::Error {
                                    meeting_id: Some(meeting_id),
                                    code,
                                    message,
                                });
                            }
                            return;
                        }
                    };
                    let _ = audio_processing_for_audio.enqueue(PersistedAudioChunk {
                        channel: frame.channel,
                        sample_rate_hz: written_rate,
                        existing_len,
                        end: existing_len + written_len,
                    });
                }))
                .await;

            match result {
                Ok(()) => {
                    spawn_capture_health_forwarder(
                        state.clone(),
                        meeting_id,
                        audio.subscribe_health(),
                        out_tx.clone(),
                    );
                    state.active.lock().await.insert(
                        meeting_id,
                        ActiveRecording {
                            audio: Some(audio),
                            audio_processing,
                            capture_source,
                            processing_mode: processing_mode.clone(),
                        },
                    );
                    let _ = out_tx.send(started_message);
                    tray.set_recording(true);
                }
                Err(e) => {
                    audio_processing.finish().await;
                    if let Some(worker) = state.retry_tasks.lock().await.remove(&meeting_id) {
                        worker.abort();
                    }
                    state.pipelines.lock().await.remove(&meeting_id);
                    let _ = state.store.mark_stopped(meeting_id, chrono::Utc::now());
                    tray.set_recording(false);
                    let _ = out_tx.send(HelperToExtension::Error {
                        meeting_id: Some(meeting_id),
                        code: ErrorCode::DeviceNotFound,
                        message: e.to_string(),
                    });
                }
            }
            true
        }

        ExtensionToHelper::AudioChunk {
            meeting_id,
            channel,
            sample_rate_hz,
            pcm16_base64,
        } => {
            let is_external = state
                .active
                .lock()
                .await
                .get(&meeting_id)
                .is_some_and(|active| active.capture_source == CaptureSource::Meet);
            if !is_external {
                let _ = out_tx.send(HelperToExtension::Error {
                    meeting_id: Some(meeting_id),
                    code: ErrorCode::StorageError,
                    message: "browser audio arrived for a meeting that is not using Meet capture"
                        .into(),
                });
                return true;
            }
            let pcm16 = match decode_browser_audio_chunk(&pcm16_base64, sample_rate_hz) {
                Ok(bytes) => bytes,
                Err(message) => {
                    // Bad browser payloads are a protocol/payload problem, not
                    // a missing device — DeviceNotFound sends the user
                    // device-hunting for a bug in the capture path.
                    let _ = out_tx.send(HelperToExtension::Error {
                        meeting_id: Some(meeting_id),
                        code: ErrorCode::ProtocolMismatch,
                        message,
                    });
                    return true;
                }
            };
            let Some(active) = state.active.lock().await.get(&meeting_id).cloned() else {
                let _ = out_tx.send(HelperToExtension::Error {
                    meeting_id: Some(meeting_id),
                    code: ErrorCode::StorageError,
                    message: "Meet capture pipeline is no longer active".into(),
                });
                return true;
            };
            let provider_channel = match channel {
                BrowserAudioChannel::Mic => notetaker_core::providers::AudioChannel::Mic,
                BrowserAudioChannel::Speaker => notetaker_core::providers::AudioChannel::Speaker,
            };
            let existing_len = match persist_audio_frame(
                &state.store,
                meeting_id,
                provider_channel,
                &pcm16,
                sample_rate_hz,
            ) {
                Ok(existing_len) => existing_len,
                Err((code, message)) => {
                    // A failed disk write is a storage failure (or a full
                    // disk), not a missing audio device.
                    let _ = out_tx.send(HelperToExtension::Error {
                        meeting_id: Some(meeting_id),
                        code,
                        message,
                    });
                    return true;
                }
            };
            let _ = active.audio_processing.enqueue(PersistedAudioChunk {
                channel: provider_channel,
                sample_rate_hz,
                existing_len,
                end: existing_len + pcm16.len(),
            });
            true
        }

        ExtensionToHelper::StopRecording {
            meeting_id,
            flagged_moments,
        } => {
            // A second Stop for the same meeting (double click, a retrying extension) while the
            // first is still finishing must not run the whole stop pipeline twice.
            let Some(stop_guard) = StopGuard::acquire(meeting_id) else {
                return true;
            };
            let active_recording = state.active.lock().await.remove(&meeting_id);
            if active_recording.is_none() && !state.pipelines.lock().await.contains_key(&meeting_id)
            {
                let _ = out_tx.send(HelperToExtension::Error {
                    meeting_id: Some(meeting_id), code: ErrorCode::StorageError,
                    message: "This recording is not active. Recover it from the interrupted recordings list.".into(),
                });
                return true;
            }
            let audio_processing_task = if let Some(active) = &active_recording {
                if let Some(audio) = &active.audio {
                    let _ = audio.stop_capture().await;
                }
                send_meeting_message(
                    &state,
                    meeting_id,
                    HelperToExtension::RecordingStopped { meeting_id },
                );
                active.audio_processing.close().await
            } else {
                None
            };
            // Audio frames have already been persisted before they enter this
            // queue. Detach its provider work from the IPC loop, then finalize
            // in the background after it drains so Stop returns promptly
            // without losing the transcript tail or the recovery path.
            tray.set_recording(false);
            let state = state.clone();
            let out_tx_for_stop = out_tx.clone();
            tokio::spawn(async move {
                let _stop_guard = stop_guard;
                if let Some(task) = audio_processing_task {
                    let _ = task.await;
                }
                if let Some(pipeline) = state.pipelines.lock().await.get(&meeting_id).cloned() {
                    if !flagged_moments.is_empty() {
                        let moments: Vec<FlaggedMoment> = flagged_moments
                            .into_iter()
                            .map(|moment| FlaggedMoment {
                                offset_ms: moment.offset_ms,
                                note: moment.note,
                                position_percent: moment.position_percent,
                            })
                            .collect();
                        // A summary without flags is still a good summary, so a
                        // failure to store them must never block stopping.
                        if let Err(error) = pipeline
                            .lock()
                            .await
                            .record_flagged_moments(meeting_id, &moments)
                        {
                            tracing::warn!(%meeting_id, %error, "could not store flagged moments");
                        }
                    }
                    let managed = active_recording.as_ref().is_some_and(|active| {
                        matches!(active.processing_mode, ProcessingMode::Managed { .. })
                    });
                    let messages = if managed {
                        pipeline
                            .lock()
                            .await
                            .stop_capture_only(meeting_id)
                            .map(|message| vec![message])
                    } else {
                        pipeline.lock().await.stop_recording(meeting_id).await
                    };
                    match messages {
                        Ok(messages) => {
                            for m in messages {
                                if !matches!(&m, HelperToExtension::RecordingStopped { .. }) {
                                    send_meeting_message(&state, meeting_id, m);
                                }
                            }
                            if managed {
                                match managed_service_from_state(&state).await {
                                    Ok(service) => match retry_managed_upload(|| {
                                        upload_managed_recording(&state.store, meeting_id, &service)
                                    })
                                    .await
                                    {
                                        Ok(job_id) => {
                                            if let Err(error) =
                                                state.store.set_managed_job_id(meeting_id, &job_id)
                                            {
                                                tracing::error!(%meeting_id, %error, "could not persist managed job id");
                                            }
                                            start_managed_worker(
                                                state.clone(),
                                                service,
                                                meeting_id,
                                                Some(job_id),
                                            )
                                            .await;
                                        }
                                        Err(error) => send_meeting_message(
                                            &state,
                                            meeting_id,
                                            HelperToExtension::ManagedJobStatus {
                                                meeting_id,
                                                job_id: String::new(),
                                                status: "error".into(),
                                                message: Some(error),
                                                summary: None,
                                                action_items: None,
                                            },
                                        ),
                                    },
                                    Err(error) => send_meeting_message(
                                        &state,
                                        meeting_id,
                                        HelperToExtension::ManagedJobStatus {
                                            meeting_id,
                                            job_id: String::new(),
                                            status: "error".into(),
                                            message: Some(error),
                                            summary: None,
                                            action_items: None,
                                        },
                                    ),
                                }
                            }
                        }
                        Err(e) => {
                            let _ = out_tx_for_stop.send(HelperToExtension::Error {
                                meeting_id: Some(meeting_id),
                                code: ErrorCode::ProviderUnreachable,
                                message: e.to_string(),
                            });
                        }
                    }
                }
                // Keep the worker alive after capture stops so persisted failed
                // chunks still retry. It exits once the queue drains (or the
                // connection disappears), rather than being abandoned here.
                if let Some(worker) = state.retry_tasks.lock().await.get(&meeting_id) {
                    worker.request_stop();
                }
            });
            true
        }

        // Resuming a crash-recovered meeting: finalize whatever transcript
        // was already captured before the interruption, then transcribe the
        // durable raw-audio tail before summarizing it.
        ExtensionToHelper::ResumeRecording { meeting_id } => {
            // Resuming a meeting that is recording right now would stamp it stopped under a live
            // capture and build a second pipeline over the same retry queue.
            if state.active.lock().await.contains_key(&meeting_id) {
                let _ = out_tx.send(HelperToExtension::Error {
                    meeting_id: Some(meeting_id),
                    code: ErrorCode::StorageError,
                    message: "This recording is already in progress.".into(),
                });
                return true;
            }
            if let Ok(meta) = state.store.load_meta(meeting_id) {
                if meta.managed_pending {
                    subscribe_meeting(&state, meeting_id, out_tx.clone());
                    match managed_service_from_state(&state).await {
                        Ok(service) if managed_identity_matches(&meta, &service) => {
                            match state.store.mark_stopped(meeting_id, chrono::Utc::now()) {
                                Ok(()) => {
                                    let _ = out_tx
                                        .send(HelperToExtension::RecordingStopped { meeting_id });
                                    start_managed_worker(
                                        state.clone(),
                                        service,
                                        meeting_id,
                                        meta.managed_job_id,
                                    )
                                    .await;
                                }
                                Err(error) => {
                                    let _ = out_tx.send(HelperToExtension::Error {
                                        meeting_id: Some(meeting_id),
                                        code: ErrorCode::StorageError,
                                        message: error.to_string(),
                                    });
                                }
                            }
                        }
                        _ => {
                            let _ = out_tx.send(HelperToExtension::Error { meeting_id: Some(meeting_id), code: ErrorCode::ProviderAuthFailed, message: "Sign in to the hosted workspace that owns this recording to recover it.".into() });
                        }
                    }
                    return true;
                }
            }
            let Some(settings) = state.settings.lock().await.clone() else {
                let _ = out_tx.send(HelperToExtension::Error {
                    meeting_id: Some(meeting_id),
                    code: ErrorCode::ProviderAuthFailed,
                    message: "provider settings are required to recover this recording".into(),
                });
                return true;
            };
            let pipeline = match build_retry_pipeline(&state.data_dir, meeting_id, &settings) {
                Ok(pipeline) => Arc::new(Mutex::new(pipeline)),
                Err(message) => {
                    let _ = out_tx.send(HelperToExtension::Error {
                        meeting_id: Some(meeting_id),
                        code: ErrorCode::ProviderAuthFailed,
                        message,
                    });
                    return true;
                }
            };
            subscribe_meeting(&state, meeting_id, out_tx.clone());
            match pipeline.lock().await.recover_recording(meeting_id).await {
                Ok(messages) => {
                    for message in messages {
                        send_meeting_message(&state, meeting_id, message);
                    }
                }
                Err(error) => {
                    let _ = out_tx.send(HelperToExtension::Error {
                        meeting_id: Some(meeting_id),
                        code: ErrorCode::StorageError,
                        message: error.to_string(),
                    });
                }
            }
            let has_pending = {
                let pipeline = pipeline.lock().await;
                pipeline.retry_queue_len() > 0 || pipeline.has_pending_summary(meeting_id)
            };
            if has_pending {
                state
                    .pipelines
                    .lock()
                    .await
                    .insert(meeting_id, pipeline.clone());
                let worker = spawn_retry_worker(meeting_id, pipeline, state.clone());
                worker.request_stop();
                state.retry_tasks.lock().await.insert(meeting_id, worker);
            }
            true
        }

        ExtensionToHelper::DiscardRecording { meeting_id } => {
            if let Some(active) = state.active.lock().await.remove(&meeting_id) {
                if let Some(audio) = active.audio {
                    let _ = audio.stop_capture().await;
                }
                active.audio_processing.finish().await;
                tray.set_recording(false);
            }
            if let Some(worker) = state.retry_tasks.lock().await.remove(&meeting_id) {
                worker.abort();
            }
            state.pipelines.lock().await.remove(&meeting_id);
            let _ = std::fs::remove_file(state.data_dir.join(format!("retry-{meeting_id}.json")));
            if let Err(error) = state.store.delete_meeting(meeting_id) {
                let _ = out_tx.send(HelperToExtension::Error {
                    meeting_id: Some(meeting_id),
                    code: ErrorCode::StorageError,
                    message: format!("could not delete recovered recording: {error}"),
                });
            }
            true
        }

        ExtensionToHelper::DeleteMeeting { meeting_id } => {
            if let Err(error) = delete_meeting_data(&state, &tray, meeting_id).await {
                let _ = out_tx.send(HelperToExtension::Error {
                    meeting_id: Some(meeting_id),
                    code: ErrorCode::StorageError,
                    message: format!("could not delete meeting data: {error}"),
                });
            }
            true
        }

        // Settings-page "Test" button, routed through the helper rather
        // than called directly from the extension — see extension/CLAUDE.md
        // and docs/native-messaging-protocol.md.
        ExtensionToHelper::TestProviderKey { provider, key } => {
            let (valid, message) = test_provider_key(provider, &key).await;
            let _ = out_tx.send(HelperToExtension::ProviderKeyTestResult {
                provider,
                valid,
                message,
            });
            true
        }

        ExtensionToHelper::AudioPreflight => {
            let audio = state.audio.clone();
            let prepare_error = audio.prepare().err().map(|error| error.to_string());
            state.audio_diagnostics.invalidate();
            let diagnostics_snapshot = state.audio_diagnostics.get(audio).await;
            let diagnostics = diagnostics_snapshot.diagnostics;
            let _ = out_tx.send(audio_status_message(diagnostics.clone(), prepare_error));
            let _ = out_tx.send(HelperToExtension::CaptureCapabilities {
                capabilities: CaptureCapabilitiesMessage {
                    platform: diagnostics.platform,
                    native_loopback: diagnostics.native_loopback,
                    microphone: diagnostics.microphone.is_some(),
                    virtual_device_fallback: diagnostics.virtual_device_fallback,
                    permission_required: diagnostics.permission_required,
                    guidance: diagnostics.guidance,
                },
            });
            true
        }

        ExtensionToHelper::AudioProbe => {
            // The probe starts and stops the shared capture session. Running it during a live
            // desktop recording would silently end that recording's capture.
            if state
                .active
                .lock()
                .await
                .values()
                .any(|active| active.audio.is_some())
            {
                let _ = out_tx.send(HelperToExtension::AudioProbeResult {
                    mic_frames: 0,
                    speaker_frames: 0,
                    passed: false,
                    message: "A recording is in progress. Run the audio test after it ends.".into(),
                });
                return true;
            }
            let audio = state.audio.clone();
            match audio.probe().await {
                Ok(result) => {
                    let _ = out_tx.send(HelperToExtension::AudioProbeResult {
                        mic_frames: result.mic_frames,
                        speaker_frames: result.speaker_frames,
                        passed: result.passed,
                        message: result.message,
                    });
                }
                Err(error) => {
                    let _ = out_tx.send(HelperToExtension::AudioProbeResult {
                        mic_frames: 0,
                        speaker_frames: 0,
                        passed: false,
                        message: format!("Audio test could not start: {error}"),
                    });
                }
            }
            true
        }
    }
}

#[cfg(target_os = "macos")]
fn current_platform() -> &'static str {
    "macos"
}

#[cfg(target_os = "windows")]
fn current_platform() -> &'static str {
    "windows"
}

#[cfg(target_os = "linux")]
fn current_platform() -> &'static str {
    "linux"
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn current_platform() -> &'static str {
    "unknown"
}

fn audio_status_message(
    diagnostics: AudioDiagnostics,
    prepare_error: Option<String>,
) -> HelperToExtension {
    let (ready, guidance) = match prepare_error {
        Some(error) => (
            false,
            format!("The helper could not prepare the audio devices: {error}"),
        ),
        None => (diagnostics.ready, diagnostics.guidance),
    };
    HelperToExtension::AudioStatus {
        platform: diagnostics.platform,
        driver: diagnostics.driver,
        driver_installed: diagnostics.driver_installed,
        microphone: diagnostics.microphone,
        speaker: diagnostics.speaker,
        ready,
        guidance,
        native_loopback: diagnostics.native_loopback,
        virtual_device_fallback: diagnostics.virtual_device_fallback,
        permission_required: diagnostics.permission_required,
    }
}

fn spawn_retry_worker(
    meeting_id: Uuid,
    pipeline: Arc<Mutex<Pipeline>>,
    state: Arc<AppState>,
) -> RetryWorker {
    let stop_when_empty = Arc::new(AtomicBool::new(false));
    let stop_signal = stop_when_empty.clone();
    let task = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(5));
        // Attempt budget for a pending summary that keeps failing (e.g. a
        // revoked key). Without a cap the worker re-called the paid API
        // every 5 seconds forever and the meeting never reached a terminal
        // state. Backoff doubles per failure up to a 10-minute floor between
        // attempts, and after MAX_SUMMARY_ATTEMPTS the meeting is marked
        // failed with a user-visible error instead of retrying endlessly.
        const MAX_SUMMARY_ATTEMPTS: u32 = 6;
        let mut summary_attempts = 0u32;
        let mut summary_backoff_until: Option<tokio::time::Instant> = None;
        loop {
            ticker.tick().await;
            // Retries hold the per-meeting pipeline mutex while provider calls
            // run. Defer them during capture so they cannot stall live chunk
            // transcription behind a slow network request; audio ranges stay
            // durable and are retried as soon as capture stops.
            if state.active.lock().await.contains_key(&meeting_id)
                || StopGuard::is_in_flight(meeting_id)
            {
                continue;
            }
            if let Some(until) = summary_backoff_until {
                if tokio::time::Instant::now() >= until {
                    // Backoff elapsed — allow a fresh summary attempt.
                    summary_backoff_until = None;
                }
            }
            // Retry and summary calls still serialize on the pipeline mutex,
            // but they are gated above while capture is active or Stop is
            // draining persisted audio. This prevents a slow network attempt
            // from blocking the live audio consumer.
            let work = {
                let mut pipeline = pipeline.lock().await;
                let now = chrono::Utc::now();
                let mut messages = pipeline.process_due_retries(now).await;
                // The summary waits for the transcript queue to drain, so a tick that only retried
                // chunks is not a failed summary attempt. Counting it burned the whole budget during
                // a transcription outage and then dropped the pending summary for good.
                if summary_backoff_until.is_none() && pipeline.retry_queue_len() == 0 {
                    messages.extend(pipeline.process_pending_summary(meeting_id).await);
                    summary_attempts = summary_attempts.saturating_add(1);
                }
                (
                    messages,
                    pipeline.retry_queue_len() == 0,
                    pipeline.has_pending_summary(meeting_id),
                )
            };
            for message in work.0 {
                send_meeting_message(&state, meeting_id, message);
            }
            let (queue_empty, summary_pending) = (work.1, work.2);
            if summary_pending && summary_attempts >= MAX_SUMMARY_ATTEMPTS {
                let _ = state.store.clear_summary_pending(meeting_id);
                send_meeting_message(
                    &state,
                    meeting_id,
                    HelperToExtension::Error {
                        meeting_id: Some(meeting_id),
                        code: ErrorCode::ProviderAuthFailed,
                        message: "The summary could not be generated after several attempts. \
                                  Check the summarization provider key in Settings and stop again \
                                  or re-summarize to retry."
                            .into(),
                    },
                );
                summary_attempts = 0;
            } else if summary_pending {
                // Exponential backoff: 5s, 10s, 20s, 40s, 80s, capped at 10 min.
                let delay_secs = std::cmp::min(5u64 * (1 << summary_attempts.min(7)), 600);
                summary_backoff_until =
                    Some(tokio::time::Instant::now() + std::time::Duration::from_secs(delay_secs));
            } else {
                summary_attempts = 0;
                summary_backoff_until = None;
            }
            if stop_signal.load(Ordering::Acquire) && queue_empty && !summary_pending {
                state.pipelines.lock().await.remove(&meeting_id);
                state.retry_tasks.lock().await.remove(&meeting_id);
                return;
            }
        }
    });
    RetryWorker {
        stop_when_empty,
        _task: task,
    }
}

fn spawn_audio_processing_queue(
    meeting_id: Uuid,
    pipeline: Arc<Mutex<Pipeline>>,
    state: Arc<AppState>,
) -> Arc<AudioProcessingQueue> {
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel::<PersistedAudioChunk>();
    let task = tokio::spawn(async move {
        while let Some(chunk) = receiver.recv().await {
            let pcm16 = match chunk.read(&state.store, meeting_id) {
                Ok(pcm16) => pcm16,
                Err(message) => {
                    send_meeting_message(
                        &state,
                        meeting_id,
                        HelperToExtension::Error {
                            meeting_id: Some(meeting_id),
                            code: ErrorCode::StorageError,
                            message,
                        },
                    );
                    continue;
                }
            };
            let messages = pipeline
                .lock()
                .await
                .handle_persisted_audio_chunk(
                    meeting_id,
                    chunk.channel,
                    &pcm16,
                    chunk.sample_rate_hz,
                    chunk.existing_len,
                )
                .await;
            for message in messages {
                send_meeting_message(&state, meeting_id, message);
            }
        }
    });
    Arc::new(AudioProcessingQueue {
        sender: std::sync::Mutex::new(Some(sender)),
        task: Mutex::new(Some(task)),
    })
}

/// Tells the extension when a capture channel goes quiet (headset unplugged,
/// `parec` exited, endpoint invalidated), so the UI does not claim a healthy
/// recording while one side records silence. Ends once the meeting stops being
/// active or the capture drops its health hub.
fn spawn_capture_health_forwarder(
    state: Arc<AppState>,
    meeting_id: Uuid,
    mut health: tokio::sync::broadcast::Receiver<notetaker_audio::CaptureHealthEvent>,
    out_tx: tokio::sync::mpsc::UnboundedSender<HelperToExtension>,
) {
    use tokio::sync::broadcast::error::RecvError;
    tokio::spawn(async move {
        loop {
            match tokio::time::timeout(std::time::Duration::from_secs(30), health.recv()).await {
                Ok(Ok(event)) => {
                    if event.kind.is_degraded() {
                        let _ = out_tx.send(HelperToExtension::Error {
                            meeting_id: Some(meeting_id),
                            code: ErrorCode::CaptureLost,
                            message: event.message,
                        });
                    }
                }
                Ok(Err(RecvError::Lagged(_))) => continue,
                Ok(Err(RecvError::Closed)) => break,
                Err(_) => {
                    if !state.active.lock().await.contains_key(&meeting_id) {
                        break;
                    }
                }
            }
        }
    });
}

/// The live desktop-capture write path. Keeps both channel files open and `fsync`s about
/// once a second instead of once per ~10 ms frame (which saturated slow disks and let the
/// frame queue grow), and rewrites `meta.json` only when a channel's sample rate changes.
/// The window this opens is an OS crash or power loss costing up to a second of the newest
/// audio; a process crash loses nothing, because every frame is already in the file.
struct LiveAudioWriter {
    appender: notetaker_core::storage::AudioAppender,
    /// The rate each channel file holds, fixed when the channel's first frame arrives.
    sample_rates: [Option<u32>; 2],
}

/// What one frame became on disk: where it starts, how many bytes, and at what rate.
struct WrittenFrame {
    start: usize,
    len: usize,
    sample_rate_hz: u32,
}

const LIVE_AUDIO_SYNC_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);

/// Linear-interpolation resample of little-endian PCM16. Used when a device switch changes the
/// capture rate mid-call: the file holds one rate (the metadata records one), so later frames are
/// converted to it rather than leaving a file whose first half plays at the wrong speed.
fn resample_pcm16(pcm16: &[u8], from_hz: u32, to_hz: u32) -> Vec<u8> {
    let samples: Vec<i16> = pcm16
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| i16::from_le_bytes(*pair))
        .collect();
    if from_hz == to_hz || samples.is_empty() || from_hz == 0 || to_hz == 0 {
        return pcm16.to_vec();
    }
    let out_len = ((samples.len() as u64 * u64::from(to_hz)) / u64::from(from_hz)).max(1) as usize;
    let step = f64::from(from_hz) / f64::from(to_hz);
    let mut out = Vec::with_capacity(out_len * 2);
    for index in 0..out_len {
        let position = index as f64 * step;
        let left = (position.floor() as usize).min(samples.len() - 1);
        let right = (left + 1).min(samples.len() - 1);
        let fraction = position - position.floor();
        let value =
            f64::from(samples[left]) * (1.0 - fraction) + f64::from(samples[right]) * fraction;
        out.extend_from_slice(&(value.round() as i16).to_le_bytes());
    }
    out
}

impl LiveAudioWriter {
    fn new(appender: notetaker_core::storage::AudioAppender) -> Self {
        Self {
            appender,
            sample_rates: [None, None],
        }
    }

    /// Appends one frame (converted to the channel file's rate when the device rate changed).
    fn write(
        &mut self,
        store: &MeetingStore,
        meeting_id: Uuid,
        channel: notetaker_core::providers::AudioChannel,
        pcm16: &[u8],
        sample_rate_hz: u32,
    ) -> Result<WrittenFrame, (ErrorCode, String)> {
        let (channel_file, slot) = match channel {
            notetaker_core::providers::AudioChannel::Mic => (notetaker_core::storage::MIC_FILE, 0),
            notetaker_core::providers::AudioChannel::Speaker => {
                (notetaker_core::storage::SPEAKER_FILE, 1)
            }
        };
        let storage_error = |error: notetaker_core::storage::StorageError, what: &str| {
            (
                error.error_code(),
                format!("failed to persist audio {what}: {error}"),
            )
        };
        let established = match self.sample_rates[slot] {
            Some(rate) => rate,
            None => {
                // First frame of this channel in this session. A resumed meeting already has audio
                // at some rate: keep it. A new one takes the rate of its first frame.
                let has_audio = store.audio_len(meeting_id, channel_file).unwrap_or(0) > 0;
                let rate = if has_audio {
                    store
                        .load_meta(meeting_id)
                        .map(|meta| {
                            if slot == 0 {
                                meta.mic_sample_rate_hz
                            } else {
                                meta.speaker_sample_rate_hz
                            }
                        })
                        .unwrap_or(sample_rate_hz)
                } else {
                    sample_rate_hz
                };
                store
                    .mark_audio_sample_rate(meeting_id, channel_file, rate)
                    .map_err(|error| storage_error(error, "metadata"))?;
                self.sample_rates[slot] = Some(rate);
                rate
            }
        };
        let converted;
        let data: &[u8] = if sample_rate_hz == established {
            pcm16
        } else {
            converted = resample_pcm16(pcm16, sample_rate_hz, established);
            &converted
        };
        let start = self
            .appender
            .append(channel_file, data)
            .map_err(|error| storage_error(error, "to disk"))?;
        // A failed flush is reported like any storage failure, but the frame itself is in the
        // file, so it still goes on to transcription.
        if let Err(error) = self.appender.sync_if_due(LIVE_AUDIO_SYNC_INTERVAL) {
            tracing::warn!(%error, "audio flush failed");
        }
        Ok(WrittenFrame {
            start,
            len: data.len(),
            sample_rate_hz: established,
        })
    }
}

fn persist_audio_frame(
    store: &MeetingStore,
    meeting_id: Uuid,
    channel: notetaker_core::providers::AudioChannel,
    pcm16: &[u8],
    sample_rate_hz: u32,
) -> Result<usize, (ErrorCode, String)> {
    let channel_file = match channel {
        notetaker_core::providers::AudioChannel::Mic => notetaker_core::storage::MIC_FILE,
        notetaker_core::providers::AudioChannel::Speaker => notetaker_core::storage::SPEAKER_FILE,
    };
    let existing_len = std::fs::metadata(store.audio_path(meeting_id, channel_file))
        .map(|metadata| metadata.len() as usize)
        .unwrap_or(0);
    store
        .append_audio(meeting_id, channel_file, pcm16)
        .map_err(|error| {
            (
                error.error_code(),
                format!("failed to persist audio to disk: {error}"),
            )
        })?;
    store
        .mark_audio_sample_rate(meeting_id, channel_file, sample_rate_hz)
        .map_err(|error| {
            (
                error.error_code(),
                format!("failed to persist audio metadata: {error}"),
            )
        })?;
    Ok(existing_len)
}

/// Removes a meeting directory that a failed start left behind — but only
/// while both audio channels are provably empty. A directory holding any
/// captured bytes is recoverable audio and is never deleted, whatever the
/// start failure was.
fn remove_meeting_if_no_audio(store: &MeetingStore, meeting_id: Uuid) {
    let empty = [
        notetaker_core::storage::MIC_FILE,
        notetaker_core::storage::SPEAKER_FILE,
    ]
    .iter()
    .all(|file| {
        store
            .audio_len(meeting_id, file)
            .map(|len| len == 0)
            .unwrap_or(false)
    });
    if !empty {
        return;
    }
    if let Err(error) = store.delete_meeting(meeting_id) {
        tracing::warn!(%meeting_id, %error, "could not remove the empty meeting left by a failed start");
    }
}

async fn start_pending_retry_workers(
    state: Arc<AppState>,
    settings: Settings,
    out_tx: ipc::OutSender,
) {
    for meeting_id in pending_processing_meeting_ids(&state.data_dir) {
        subscribe_meeting(&state, meeting_id, out_tx.clone());
        if let Some(pipeline) = state.pipelines.lock().await.get(&meeting_id).cloned() {
            let worker_running = state
                .retry_tasks
                .lock()
                .await
                .get(&meeting_id)
                .is_some_and(|worker| !worker._task.is_finished());
            if worker_running {
                continue;
            }
            if let Some(worker) = state.retry_tasks.lock().await.remove(&meeting_id) {
                worker.abort();
            }
            let has_pending = {
                let pipeline = pipeline.lock().await;
                pipeline.retry_queue_len() > 0 || pipeline.has_pending_summary(meeting_id)
            };
            if has_pending {
                let worker = spawn_retry_worker(meeting_id, pipeline, state.clone());
                worker.request_stop();
                state.retry_tasks.lock().await.insert(meeting_id, worker);
            }
            continue;
        }

        let pipeline = match build_retry_pipeline(&state.data_dir, meeting_id, &settings) {
            Ok(pipeline)
                if pipeline.retry_queue_len() > 0 || pipeline.has_pending_summary(meeting_id) =>
            {
                Arc::new(Mutex::new(pipeline))
            }
            Ok(_) => continue,
            Err(message) => {
                let _ = out_tx.send(HelperToExtension::Error {
                    meeting_id: Some(meeting_id),
                    code: ErrorCode::ProviderAuthFailed,
                    message,
                });
                continue;
            }
        };

        state
            .pipelines
            .lock()
            .await
            .insert(meeting_id, pipeline.clone());
        let worker = spawn_retry_worker(meeting_id, pipeline, state.clone());
        worker.request_stop();
        state.retry_tasks.lock().await.insert(meeting_id, worker);
    }
}

fn subscribe_meeting(state: &Arc<AppState>, meeting_id: Uuid, out_tx: ipc::OutSender) {
    let mut subscribers = lock_subscribers(state);
    let entries = subscribers.entry(meeting_id).or_default();
    entries.retain(|sender| !sender.is_closed());
    if !entries.iter().any(|sender| sender.same_channel(&out_tx)) {
        entries.push(out_tx);
    }
}

/// Removes every registry entry that belongs to the disconnected
/// connection's channel. Called synchronously from the IPC layer right
/// before the connection's writer task is awaited, so the writer's
/// `recv()` can return None instead of being held open forever by stale
/// registry clones.
fn prune_subscribers(state: &Arc<AppState>, disconnected: ipc::OutSender) {
    let mut subscribers = lock_subscribers(state);
    subscribers.retain(|_, entries| {
        entries.retain(|sender| !sender.same_channel(&disconnected));
        !entries.is_empty()
    });
}

fn send_meeting_message(state: &Arc<AppState>, meeting_id: Uuid, message: HelperToExtension) {
    let mut subscribers = lock_subscribers(state);
    let Some(entries) = subscribers.get_mut(&meeting_id) else {
        return;
    };
    entries.retain(|sender| !sender.is_closed() && sender.send(message.clone()).is_ok());
    if entries.is_empty() {
        subscribers.remove(&meeting_id);
    }
}

/// Unpoisonable lock helper for the short, await-free subscriber registry
/// critical sections.
fn lock_subscribers(
    state: &Arc<AppState>,
) -> std::sync::MutexGuard<'_, HashMap<Uuid, Vec<ipc::OutSender>>> {
    state
        .subscribers
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn pending_processing_meeting_ids(root: &Path) -> Vec<Uuid> {
    let mut ids = HashSet::new();

    // Queued retry chunks live as `<root>/retry-<uuid>.json`.
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.filter_map(Result::ok) {
            if let Some(id) = entry.file_name().to_str().and_then(|name| {
                let value = name.strip_prefix("retry-")?.strip_suffix(".json")?;
                Uuid::parse_str(value).ok()
            }) {
                ids.insert(id);
            }
        }
    }

    // A meeting can owe a summary with no retry file at all — every chunk
    // transcribed fine but summarization itself failed, so `summary_pending`
    // is the only trace. Meeting metadata lives one level down, under
    // `<root>/meetings/<uuid>/meta.json` (see MeetingStore's layout); scanning
    // `<root>` directly, as this used to, never found a single one of them and
    // left those summaries stranded across a helper restart.
    if let Ok(entries) = std::fs::read_dir(root.join("meetings")) {
        for entry in entries.filter_map(Result::ok) {
            let Ok(bytes) = std::fs::read(entry.path().join("meta.json")) else {
                continue;
            };
            if let Ok(meta) = serde_json::from_slice::<notetaker_core::storage::MeetingMeta>(&bytes)
            {
                if meta.summary_pending {
                    ids.insert(meta.id);
                }
            }
        }
    }

    ids.into_iter().collect()
}

/// Hands every recording that was waiting on hosted processing back to the local pipeline,
/// whatever state it was left in, and returns how many were released.
fn release_stranded_managed_recordings(root: &Path, store: &MeetingStore) -> usize {
    let Ok(entries) = std::fs::read_dir(root.join("meetings")) else {
        return 0;
    };
    let mut released = 0;
    for entry in entries.filter_map(Result::ok) {
        let Ok(bytes) = std::fs::read(entry.path().join("meta.json")) else {
            continue;
        };
        let Ok(meta) = serde_json::from_slice::<notetaker_core::storage::MeetingMeta>(&bytes)
        else {
            continue;
        };
        if meta.managed_pending {
            match store.release_managed_to_local(meta.id) {
                Ok(()) => released += 1,
                Err(error) => {
                    tracing::warn!(%meta.id, %error, "could not release a hosted-pending recording");
                }
            }
        }
    }
    released
}

fn pending_managed_meetings(root: &Path) -> Vec<notetaker_core::storage::MeetingMeta> {
    let mut meetings = Vec::new();
    let Ok(entries) = std::fs::read_dir(root.join("meetings")) else {
        return meetings;
    };
    for entry in entries.filter_map(Result::ok) {
        let Ok(bytes) = std::fs::read(entry.path().join("meta.json")) else {
            continue;
        };
        let Ok(meta) = serde_json::from_slice::<notetaker_core::storage::MeetingMeta>(&bytes)
        else {
            continue;
        };
        if meta.managed_pending && meta.state == notetaker_core::storage::MeetingState::Stopped {
            meetings.push(meta);
        }
    }
    meetings.sort_by_key(|meta| meta.started_at);
    meetings
}

async fn start_pending_managed_workers(
    state: Arc<AppState>,
    service: ManagedServiceConfig,
    out_tx: ipc::OutSender,
) {
    for meta in pending_managed_meetings(&state.data_dir) {
        if !managed_identity_matches(&meta, &service) {
            tracing::warn!(
                %meta.id,
                "skipping pending managed recording for a different hosted workspace"
            );
            continue;
        }
        subscribe_meeting(&state, meta.id, out_tx.clone());
        start_managed_worker(
            state.clone(),
            service.clone(),
            meta.id,
            meta.managed_job_id.clone(),
        )
        .await;
    }
}

fn build_retry_pipeline(
    data_dir: &Path,
    meeting_id: Uuid,
    settings: &Settings,
) -> Result<Pipeline, String> {
    let ExtensionToHelper::Settings {
        transcription_provider,
        summarization_provider,
        api_keys,
        default_meeting_mode,
        custom_vocabulary,
        custom_summary_instructions,
        ..
    } = settings.inner.clone()
    else {
        return Err("invalid settings message".into());
    };
    let (transcription_key, summarization_key) =
        resolve_keys(transcription_provider, summarization_provider, &api_keys)?;
    let retry_path = data_dir.join(format!("retry-{meeting_id}.json"));
    let retry_queue: RetryQueue<RetryableChunk> =
        RetryQueue::load_or_create(retry_path).map_err(|error| error.to_string())?;
    let store = MeetingStore::new(data_dir).map_err(|error| error.to_string())?;
    Ok(Pipeline::new(
        store,
        build_transcription_provider(transcription_provider, transcription_key),
        build_summarization_provider(summarization_provider, summarization_key),
        retry_queue,
    )
    .with_summary_options(summary_options(
        default_meeting_mode,
        custom_vocabulary,
        custom_summary_instructions,
    )))
}

fn summary_options(
    mode: MeetingMode,
    vocabulary: Vec<String>,
    instructions: Option<String>,
) -> SummaryOptions {
    SummaryOptions {
        mode,
        vocabulary: vocabulary
            .into_iter()
            .map(|term| term.trim().to_string())
            .filter(|term| !term.is_empty())
            .map(|term| term.chars().take(100).collect())
            .take(100)
            .collect(),
        custom_instructions: instructions
            .filter(|value| !value.trim().is_empty())
            .map(|value| value.chars().take(4_000).collect()),
        flagged_moments: vec![],
    }
}

/// Notes are made with the user's own provider keys.
fn processing_ready(
    preferences: &desktop_settings::DesktopPreferences,
    keys: &native_messaging::ApiKeys,
) -> Result<(), String> {
    resolve_keys(
        preferences.transcription_provider,
        preferences.summarization_provider,
        keys,
    )
    .map(|_| ())
}

fn resolve_keys(
    transcription: native_messaging::TranscriptionProviderId,
    summarization: native_messaging::SummarizationProviderId,
    keys: &native_messaging::ApiKeys,
) -> Result<(String, String), String> {
    use native_messaging::{SummarizationProviderId, TranscriptionProviderId};
    let t = match transcription {
        TranscriptionProviderId::Deepgram => keys.deepgram.clone(),
        TranscriptionProviderId::Groq => keys.groq.clone(),
    }
    .ok_or_else(|| format!("no API key configured for {transcription:?}"))?;
    let s = match summarization {
        SummarizationProviderId::Claude => keys.claude.clone(),
        SummarizationProviderId::Gemini => keys.gemini.clone(),
        SummarizationProviderId::Deepseek => keys.deepseek.clone(),
    }
    .ok_or_else(|| format!("no API key configured for {summarization:?}"))?;
    Ok((t, s))
}

fn build_audio_backend() -> Arc<dyn AudioCapture> {
    #[cfg(target_os = "linux")]
    {
        Arc::new(notetaker_audio::linux::LinuxAudioCapture::new())
    }
    #[cfg(target_os = "macos")]
    {
        Arc::new(notetaker_audio::macos::MacosAudioCapture::new())
    }
    #[cfg(target_os = "windows")]
    {
        Arc::new(notetaker_audio::windows::WindowsAudioCapture::new())
    }
}

#[cfg(desktop)]
fn apply_default_autostart<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    data_dir: &std::path::Path,
) {
    use tauri_plugin_autostart::ManagerExt;
    let marker = data_dir.join("autostart-default-applied");
    if marker.exists() {
        return;
    }
    if let Err(error) = app.autolaunch().enable() {
        tracing::warn!(%error, "could not enable launch at login by default");
        return;
    }
    if let Err(error) = std::fs::write(&marker, b"1") {
        tracing::warn!(%error, "could not record the launch-at-login default");
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn ticking_an_action_item_records_status_and_time_and_reports_its_workspace_id() {
        let mut summary = notetaker_core::providers::Summary {
            summary: "s".into(),
            action_items: vec![
                notetaker_core::native_messaging::ActionItem {
                    text: "a".into(),
                    id: Some("item-1".into()),
                    ..Default::default()
                },
                notetaker_core::native_messaging::ActionItem {
                    text: "b".into(),
                    ..Default::default()
                },
            ],
        };
        assert_eq!(
            super::set_action_status(&mut summary, 0, true)
                .unwrap()
                .as_deref(),
            Some("item-1")
        );
        assert_eq!(summary.action_items[0].status.as_deref(), Some("done"));
        assert!(summary.action_items[0].completed_at.is_some());
        assert_eq!(
            super::set_action_status(&mut summary, 1, true).unwrap(),
            None
        );
        super::set_action_status(&mut summary, 0, false).unwrap();
        assert_eq!(summary.action_items[0].status.as_deref(), Some("open"));
        assert!(summary.action_items[0].completed_at.is_none());
        assert!(super::set_action_status(&mut summary, 9, true).is_err());
    }

    #[test]
    fn hosted_responses_show_refusals_and_report_an_ended_session() {
        use super::interpret_hosted_response as interpret;
        let ok = serde_json::json!({ "ok": true, "answer": "x" });
        assert_eq!(interpret(200, ok.clone()).unwrap(), ok);
        // A refusal such as "question limit reached" is data for the screen, not a crash.
        let refused = serde_json::json!({ "ok": false, "error": "Limit reached" });
        assert_eq!(interpret(422, refused.clone()).unwrap(), refused);
        // A live plan sends checkout to the billing portal.
        assert!(interpret(409, serde_json::json!({ "portalRequired": true })).is_ok());
        assert!(interpret(401, serde_json::Value::Null)
            .unwrap_err()
            .contains("session ended"));
        assert_eq!(
            interpret(500, serde_json::json!({ "error": "boom" })).unwrap_err(),
            "boom"
        );
        assert!(interpret(502, serde_json::Value::Null)
            .unwrap_err()
            .contains("502"));
    }

    use super::*;
    use notetaker_core::storage::MeetingStore;

    #[test]
    fn a_second_stop_for_the_same_meeting_is_refused_until_the_first_ends() {
        let id = Uuid::new_v4();
        let first = StopGuard::acquire(id).expect("first stop proceeds");
        assert!(StopGuard::acquire(id).is_none());
        assert!(StopGuard::acquire(Uuid::new_v4()).is_some());
        drop(first);
        assert!(StopGuard::acquire(id).is_some());
    }

    #[tokio::test]
    async fn closing_audio_queue_detaches_provider_work_without_waiting_for_it() {
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let worker = tokio::spawn(async move {
            let _ = receiver.recv().await;
            let _ = started_tx.send(());
            let _ = release_rx.await;
            while receiver.recv().await.is_some() {}
        });
        sender
            .send(PersistedAudioChunk {
                channel: notetaker_core::providers::AudioChannel::Mic,
                sample_rate_hz: 16_000,
                existing_len: 0,
                end: 0,
            })
            .unwrap();
        let queue = AudioProcessingQueue {
            sender: std::sync::Mutex::new(Some(sender)),
            task: Mutex::new(Some(worker)),
        };

        started_rx.await.unwrap();
        let drain_task = queue.close().await.expect("worker handle is detached");
        assert!(!drain_task.is_finished());

        release_tx.send(()).unwrap();
        drain_task.await.unwrap();
        assert!(queue.close().await.is_none());
    }

    #[test]
    fn a_grown_recording_gets_its_own_upload_key_but_a_replay_keeps_it() {
        let id = Uuid::new_v4();
        assert_eq!(managed_upload_key(id, 1_000), managed_upload_key(id, 1_000));
        assert_ne!(managed_upload_key(id, 1_000), managed_upload_key(id, 2_000));
        assert!(managed_upload_key(id, 1_000).starts_with(&format!("meeting:{id}")));
    }

    #[test]
    fn hosted_job_polling_slows_down_but_keeps_going_for_about_half_an_hour() {
        assert_eq!(managed_poll_delay(1), std::time::Duration::from_secs(2));
        assert_eq!(managed_poll_delay(299), std::time::Duration::from_secs(2));
        assert_eq!(managed_poll_delay(300), std::time::Duration::from_secs(10));
        let total: u64 = (1..MANAGED_POLL_ATTEMPTS)
            .map(|attempt| managed_poll_delay(attempt).as_secs())
            .sum();
        assert!((25 * 60..=35 * 60).contains(&total), "{total}s");
    }

    #[test]
    fn hosted_urls_must_be_https_or_true_loopback() {
        for allowed in [
            "https://notes.example.com",
            "http://localhost:3000",
            "http://127.0.0.1:8080/x",
            "http://[::1]:3000",
            "HTTP://LOCALHOST",
        ] {
            assert!(hosted_url_is_allowed(allowed), "{allowed}");
        }
        for denied in [
            "http://notes.example.com",
            "http://localhost.evil.com",
            "http://127.0.0.1.attacker.net",
            "http://localhost@evil.com",
            "ftp://notes.example.com",
            "not a url",
            "",
        ] {
            assert!(!hosted_url_is_allowed(denied), "{denied}");
        }
    }

    #[test]
    fn live_writer_appends_in_order_and_flushes_everything_when_dropped() {
        use notetaker_core::providers::AudioChannel;
        let dir = tempfile::tempdir().unwrap();
        let store = MeetingStore::new(dir.path()).unwrap();
        let id = Uuid::new_v4();
        store.create_meeting(id, chrono::Utc::now()).unwrap();
        let mut writer = LiveAudioWriter::new(store.open_audio_appender(id));

        let first = writer
            .write(&store, id, AudioChannel::Mic, &[1, 2], 48_000)
            .unwrap();
        assert_eq!(
            (first.start, first.len, first.sample_rate_hz),
            (0, 2, 48_000)
        );
        let speaker = writer
            .write(&store, id, AudioChannel::Speaker, &[9, 9], 44_100)
            .unwrap();
        assert_eq!((speaker.start, speaker.sample_rate_hz), (0, 44_100));
        let second = writer
            .write(&store, id, AudioChannel::Mic, &[3, 4, 5, 6], 48_000)
            .unwrap();
        assert_eq!(second.start, 2);
        // Readers see the bytes immediately (they are in the file), before any flush is due.
        assert_eq!(
            store
                .audio_len(id, notetaker_core::storage::MIC_FILE)
                .unwrap(),
            6
        );
        drop(writer);

        let meta = store.load_meta(id).unwrap();
        assert_eq!(meta.mic_sample_rate_hz, 48_000);
        assert_eq!(meta.speaker_sample_rate_hz, 44_100);
    }

    #[test]
    fn a_device_switch_mid_call_keeps_the_channel_file_at_one_rate() {
        use notetaker_core::providers::AudioChannel;
        let dir = tempfile::tempdir().unwrap();
        let store = MeetingStore::new(dir.path()).unwrap();
        let id = Uuid::new_v4();
        store.create_meeting(id, chrono::Utc::now()).unwrap();
        let mut writer = LiveAudioWriter::new(store.open_audio_appender(id));

        let one_second_48k = vec![0u8; 48_000 * 2];
        let first = writer
            .write(&store, id, AudioChannel::Mic, &one_second_48k, 48_000)
            .unwrap();
        // The headset changes: the same second now arrives at 16 kHz.
        let one_second_16k = vec![0u8; 16_000 * 2];
        let second = writer
            .write(&store, id, AudioChannel::Mic, &one_second_16k, 16_000)
            .unwrap();

        assert_eq!(second.sample_rate_hz, 48_000, "stays at the file's rate");
        assert_eq!(
            second.len,
            one_second_48k.len(),
            "one second is still one second"
        );
        assert_eq!(second.start, first.len);
        assert_eq!(store.load_meta(id).unwrap().mic_sample_rate_hz, 48_000);
    }

    #[test]
    fn a_resumed_meeting_keeps_the_rate_already_on_disk() {
        use notetaker_core::providers::AudioChannel;
        let dir = tempfile::tempdir().unwrap();
        let store = MeetingStore::new(dir.path()).unwrap();
        let id = Uuid::new_v4();
        store.create_meeting(id, chrono::Utc::now()).unwrap();
        {
            let mut before = LiveAudioWriter::new(store.open_audio_appender(id));
            before
                .write(&store, id, AudioChannel::Mic, &vec![0u8; 960], 48_000)
                .unwrap();
        }
        let mut after = LiveAudioWriter::new(store.open_audio_appender(id));
        let resumed = after
            .write(&store, id, AudioChannel::Mic, &vec![0u8; 320], 16_000)
            .unwrap();
        assert_eq!(resumed.sample_rate_hz, 48_000);
        assert_eq!(resumed.len, 960);
    }

    #[test]
    fn resampling_preserves_duration_and_endpoints() {
        let ramp: Vec<u8> = (0..100i16)
            .flat_map(|value| (value * 100).to_le_bytes())
            .collect();
        let up = resample_pcm16(&ramp, 16_000, 48_000);
        assert_eq!(up.len(), 300 * 2);
        let first = i16::from_le_bytes([up[0], up[1]]);
        assert_eq!(first, 0);
        let down = resample_pcm16(&up, 48_000, 16_000);
        assert_eq!(down.len(), ramp.len());
        assert_eq!(resample_pcm16(&[], 16_000, 48_000), Vec::<u8>::new());
        assert_eq!(resample_pcm16(&ramp, 16_000, 16_000), ramp);
        assert_eq!(resample_pcm16(&ramp, 0, 48_000), ramp);
    }

    #[test]
    fn queued_audio_reads_exact_durable_ranges_after_capture_advances() {
        let dir = tempfile::tempdir().unwrap();
        let store = MeetingStore::new(dir.path()).unwrap();
        let id = Uuid::new_v4();
        store.create_meeting(id, chrono::Utc::now()).unwrap();
        let mut queued = Vec::new();
        for (channel, bytes) in [
            (notetaker_core::providers::AudioChannel::Mic, vec![1, 2]),
            (notetaker_core::providers::AudioChannel::Speaker, vec![3, 4]),
            (notetaker_core::providers::AudioChannel::Mic, vec![5, 6]),
        ] {
            let start = persist_audio_frame(&store, id, channel, &bytes, 48_000).unwrap();
            queued.push(PersistedAudioChunk {
                channel,
                sample_rate_hz: 48_000,
                existing_len: start,
                end: start + bytes.len(),
            });
        }
        // Provider work starts only after more frames have reached disk. Each
        // reference still addresses its own channel and original frame.
        assert_eq!(queued[0].read(&store, id).unwrap(), vec![1, 2]);
        assert_eq!(queued[1].read(&store, id).unwrap(), vec![3, 4]);
        assert_eq!(queued[2].read(&store, id).unwrap(), vec![5, 6]);
        std::fs::write(store.audio_path(id, notetaker_core::storage::MIC_FILE), []).unwrap();
        assert!(queued[0].read(&store, id).is_err());
    }

    #[test]
    fn a_truncated_pairing_token_file_reads_as_never_paired() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pairing_token.txt");

        // A crash between truncate and write leaves a zero-byte file. It is
        // treated as an unpaired helper so the next hello can repair it.
        std::fs::write(&path, "").unwrap();
        assert_eq!(load_pairing_token(&path), None);

        std::fs::write(&path, "   \n").unwrap();
        assert_eq!(load_pairing_token(&path), None);

        // A trailing newline (an editor, a shell redirect) must still pair.
        std::fs::write(&path, "abc123\n").unwrap();
        assert_eq!(load_pairing_token(&path), Some("abc123".to_string()));
    }

    #[test]
    fn missing_pairing_token_file_reads_as_never_paired() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load_pairing_token(&dir.path().join("absent.txt")), None);
    }

    #[test]
    fn pairing_token_comparison_accepts_only_an_exact_match() {
        let token = native_messaging::generate_pairing_token();
        assert!(pairing_token_matches(&token, &token.clone()));
        assert!(!pairing_token_matches(&token, &token[..token.len() - 1]));
        assert!(!pairing_token_matches(&token, &format!("{token}x")));
        assert!(!pairing_token_matches(&token, ""));

        // Differs only in the last byte: a length-only check would pass it.
        let mut nearly = token.clone();
        nearly.pop();
        nearly.push(if token.ends_with('0') { '1' } else { '0' });
        assert!(!pairing_token_matches(&token, &nearly));
    }

    #[test]
    fn a_missing_browser_token_does_not_repair_an_existing_helper_pairing() {
        // First-ever pairing: no token on disk → auto-mint.
        assert!(should_issue_pairing_token(None, None));
        // An existing token is never re-issued on a null presented token —
        // that is exactly the rogue same-user-process path the token guards
        // against. Re-pairing requires the tray's "Pair New Browser" item,
        // which deletes the token file (so `existing` becomes None).
        assert!(!should_issue_pairing_token(Some("helper-token"), None));
        assert!(!should_issue_pairing_token(
            Some("helper-token"),
            Some("helper-token")
        ));
        assert!(!should_issue_pairing_token(
            Some("helper-token"),
            Some("stale-token")
        ));
    }

    #[test]
    fn pending_processing_finds_a_meeting_that_only_owes_a_summary() {
        // Every chunk transcribed but summarization itself failed: there is
        // no retry-<id>.json, and meta.json lives under <root>/meetings/<id>/,
        // not <root>/<id>/. Scanning the root directly found none of these.
        let dir = tempfile::tempdir().unwrap();
        let store = MeetingStore::new(dir.path()).unwrap();
        let id = Uuid::new_v4();
        store.create_meeting(id, chrono::Utc::now()).unwrap();
        store.mark_stopped(id, chrono::Utc::now()).unwrap();
        store.mark_summary_pending(id).unwrap();

        assert_eq!(pending_processing_meeting_ids(dir.path()), vec![id]);
    }

    #[test]
    fn pending_processing_finds_queued_retry_chunks_and_ignores_finished_meetings() {
        let dir = tempfile::tempdir().unwrap();
        let store = MeetingStore::new(dir.path()).unwrap();

        let retrying = Uuid::new_v4();
        std::fs::write(dir.path().join(format!("retry-{retrying}.json")), "[]").unwrap();

        let finished = Uuid::new_v4();
        store.create_meeting(finished, chrono::Utc::now()).unwrap();
        store.mark_stopped(finished, chrono::Utc::now()).unwrap();
        store.mark_processed(finished).unwrap();

        // Unrelated files in the data dir must not be mistaken for meetings.
        std::fs::write(dir.path().join("pairing_token.txt"), "token").unwrap();
        std::fs::write(dir.path().join("retry-not-a-uuid.json"), "[]").unwrap();

        assert_eq!(pending_processing_meeting_ids(dir.path()), vec![retrying]);
    }

    #[test]
    fn pending_processing_on_a_fresh_data_dir_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert!(pending_processing_meeting_ids(dir.path()).is_empty());
    }

    #[test]
    fn web_pages_map_to_fixed_paths_and_unknown_names_are_refused() {
        assert_eq!(web_page_path("library"), Some("/meetings"));
        assert_eq!(web_page_path("account"), Some("/account"));
        assert_eq!(web_page_path("billing"), Some("/billing"));
        assert_eq!(web_page_path("team"), Some("/team"));
        assert_eq!(web_page_path("https://evil.example"), None);
        assert_eq!(web_page_path("../login"), None);
    }

    #[test]
    fn billing_pages_open_only_on_stripe_or_the_service() {
        assert!(billing_url_is_allowed(
            "https://checkout.stripe.com/c/pay/abc",
            "https://notes.example.com"
        ));
        assert!(billing_url_is_allowed(
            "https://billing.stripe.com/p/session/x",
            "https://notes.example.com"
        ));
        assert!(billing_url_is_allowed(
            "https://notes.example.com/billing",
            "https://notes.example.com"
        ));
        assert!(!billing_url_is_allowed(
            "https://evil.example/billing",
            "https://notes.example.com"
        ));
        assert!(!billing_url_is_allowed(
            "http://checkout.stripe.com/c",
            "https://notes.example.com"
        ));
        assert!(!billing_url_is_allowed(
            "https://checkout.stripe.com.evil.example/c",
            "https://notes.example.com"
        ));
        assert!(!billing_url_is_allowed(
            "https://user:pw@checkout.stripe.com/c",
            "https://notes.example.com"
        ));
    }

    #[test]
    fn stranded_hosted_recordings_are_released_in_every_state() {
        let dir = tempfile::tempdir().unwrap();
        let store = MeetingStore::new(dir.path()).unwrap();
        let stopped = Uuid::new_v4();
        store.create_meeting(stopped, chrono::Utc::now()).unwrap();
        store.mark_stopped(stopped, chrono::Utc::now()).unwrap();
        store.mark_managed_pending(stopped).unwrap();
        let recording = Uuid::new_v4();
        store.create_meeting(recording, chrono::Utc::now()).unwrap();
        store.mark_managed_pending(recording).unwrap();
        let local = Uuid::new_v4();
        store.create_meeting(local, chrono::Utc::now()).unwrap();

        assert_eq!(release_stranded_managed_recordings(dir.path(), &store), 2);

        assert!(!store.load_meta(stopped).unwrap().managed_pending);
        assert!(!store.load_meta(recording).unwrap().managed_pending);
        assert_eq!(release_stranded_managed_recordings(dir.path(), &store), 0);
    }

    #[test]
    fn pending_managed_meetings_include_stopped_uploads_but_not_recording_or_complete() {
        let dir = tempfile::tempdir().unwrap();
        let store = MeetingStore::new(dir.path()).unwrap();

        let stopped = Uuid::new_v4();
        store.create_meeting(stopped, chrono::Utc::now()).unwrap();
        store.mark_stopped(stopped, chrono::Utc::now()).unwrap();
        store.mark_managed_pending(stopped).unwrap();
        store.set_managed_job_id(stopped, "job-1").unwrap();

        let recording = Uuid::new_v4();
        store.create_meeting(recording, chrono::Utc::now()).unwrap();
        store.mark_managed_pending(recording).unwrap();

        let complete = Uuid::new_v4();
        store.create_meeting(complete, chrono::Utc::now()).unwrap();
        store.mark_stopped(complete, chrono::Utc::now()).unwrap();
        store.mark_managed_pending(complete).unwrap();
        store.mark_managed_complete(complete).unwrap();

        let pending = pending_managed_meetings(dir.path());
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, stopped);
        assert_eq!(pending[0].managed_job_id.as_deref(), Some("job-1"));
    }

    #[test]
    fn managed_upload_retry_backoff_is_bounded_and_exponential() {
        assert_eq!(managed_retry_delay(0), std::time::Duration::from_secs(2));
        assert_eq!(managed_retry_delay(1), std::time::Duration::from_secs(4));
        assert_eq!(managed_retry_delay(20), std::time::Duration::from_secs(30));
    }

    #[test]
    fn hosted_access_failures_reset_only_the_managed_job_cursor() {
        assert!(should_reset_managed_job_cursor(
            reqwest::StatusCode::UNAUTHORIZED
        ));
        assert!(should_reset_managed_job_cursor(
            reqwest::StatusCode::FORBIDDEN
        ));
        assert!(should_reset_managed_job_cursor(
            reqwest::StatusCode::NOT_FOUND
        ));
        assert!(!should_reset_managed_job_cursor(
            reqwest::StatusCode::SERVICE_UNAVAILABLE
        ));
    }

    #[test]
    fn managed_retry_requires_the_original_workspace_identity() {
        let dir = tempfile::tempdir().unwrap();
        let store = MeetingStore::new(dir.path()).unwrap();
        let meeting_id = Uuid::new_v4();
        store
            .create_meeting(meeting_id, chrono::Utc::now())
            .unwrap();
        store
            .mark_managed_pending_for_identity(meeting_id, "account-1", "workspace-1")
            .unwrap();
        let meta = store.load_meta(meeting_id).unwrap();
        let matching = ManagedServiceConfig {
            base_url: "https://notes.example.com".into(),
            access_token: "session".into(),
            account_id: "account-1".into(),
            workspace_id: "workspace-1".into(),
            plan: "hosted_pro".into(),
        };
        let different = ManagedServiceConfig {
            workspace_id: "workspace-2".into(),
            ..matching.clone()
        };

        assert!(managed_identity_matches(&meta, &matching));
        assert!(!managed_identity_matches(&meta, &different));
    }

    #[tokio::test]
    async fn managed_upload_retries_transient_failures_before_reporting_error() {
        let mut attempts = 0;
        let mut waits = Vec::new();
        let result = retry_managed_upload_with_wait(
            || {
                attempts += 1;
                let current = attempts;
                async move {
                    if current < 3 {
                        Err(format!("temporary failure {current}"))
                    } else {
                        Ok("job-123".to_string())
                    }
                }
            },
            |delay| {
                waits.push(delay);
                async {}
            },
        )
        .await;

        assert_eq!(result.as_deref(), Ok("job-123"));
        assert_eq!(attempts, 3);
        assert_eq!(
            waits,
            vec![
                std::time::Duration::from_secs(2),
                std::time::Duration::from_secs(4),
            ]
        );
    }
}
