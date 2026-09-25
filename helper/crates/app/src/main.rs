//! `notetaker-helper` — the persistent tray app. Owns the AI pipeline, the
//! audio capture lifecycle, and crash recovery, per the non-negotiable
//! constraint that the helper (not the extension) owns the pipeline.
//!
//! Talks to `notetaker-nm-host` shim instances over a local socket (see
//! `ipc.rs`); those shims are what Chrome actually spawns per
//! `docs/native-messaging-protocol.md`.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ipc;
mod ipc_endpoint;
mod logging;
mod notify;
mod paths;
mod single_instance;
mod tray;

use async_trait::async_trait;
use notetaker_audio::{AudioCapture, AudioDiagnostics};
use notetaker_core::native_messaging::{
    decode_browser_audio_chunk, ActionItem, BrowserAudioChannel, CaptureCapabilitiesMessage,
    CaptureSource, ErrorCode, ExtensionToHelper, HelperToExtension, ManagedServiceConfig,
    MeetingMode, ProcessingMode,
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
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

const MAX_MANAGED_UPLOAD_ATTEMPTS: u32 = 3;
const MANAGED_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const MANAGED_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

fn managed_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
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
    pcm16: Vec<u8>,
    sample_rate_hz: u32,
    existing_len: usize,
}

/// Separates durable audio ingress from provider work. The sender is removed
/// during `finish`, so the worker drains every already-enqueued frame and then
/// exits; a slow provider can no longer block the Native Messaging reader from
/// persisting the next frame.
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

    async fn finish(&self) {
        let sender = self.sender.lock().ok().and_then(|mut sender| sender.take());
        drop(sender);
        if let Some(task) = self.task.lock().await.take() {
            let _ = task.await;
        }
    }
}

struct AppState {
    store: Arc<MeetingStore>,
    data_dir: std::path::PathBuf,
    audio: Arc<dyn AudioCapture>,
    pairing_token: Mutex<Option<String>>,
    settings: Mutex<Option<Settings>>,
    active: Mutex<HashMap<Uuid, ActiveRecording>>,
    pipelines: Mutex<HashMap<Uuid, Arc<Mutex<Pipeline>>>>,
    retry_tasks: Mutex<HashMap<Uuid, RetryWorker>>,
    managed_tasks: Mutex<HashMap<Uuid, tokio::task::JoinHandle<()>>>,
    subscribers: Mutex<HashMap<Uuid, Vec<ipc::OutSender>>>,
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

    let idempotency_key = format!("meeting:{meeting_id}");
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
            let checksum = format!("{:x}", Sha256::digest(&chunk));
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
            )
            .await;
            return;
        }
    };
    let base = service.base_url.trim_end_matches('/');
    let url = format!("{base}/api/v1/jobs/{job_id}");
    let mut last_status = "queued".to_string();

    for attempt in 0..150 {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
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
            )
            .await;
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
            )
            .await;
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
                            Some(ActionItem { text, owner })
                        })
                        .collect::<Vec<_>>()
                });
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
            )
            .await;
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
            )
            .await;
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
    )
    .await;
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
                )
                .await;
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
    )
    .await;
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

fn pairing_token_path(root: &std::path::Path) -> std::path::PathBuf {
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
fn should_issue_pairing_token(existing: Option<&str>, presented: Option<&str>) -> bool {
    existing.is_none() || presented.is_none()
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
    let root = paths::data_dir().expect("per-user data directory is required");
    secure_data_dir(&root).expect("could not secure app data directory");
    logging::init(&root);
    let _instance = match single_instance::acquire(&root) {
        Ok(single_instance::Acquired::Yes(lock)) => lock,
        Ok(single_instance::Acquired::AlreadyRunning) => {
            notify::Notifier::default().notify_deduped(
                "already-running",
                "AI Notetaker",
                "The helper is already running.",
            );
            return;
        }
        Err(error) => {
            tracing::error!(%error, "could not acquire helper lock");
            return;
        }
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(move |app| {
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                None,
            ))?;

            let root = root.clone();
            use tauri_plugin_autostart::ManagerExt;
            let autostart_marker = root.join("autostart-configured");
            if !autostart_marker.exists() && app.autolaunch().enable().is_ok() {
                std::fs::write(&autostart_marker, b"configured")?;
            }
            secure_data_dir(&root).map_err(|e| -> Box<dyn std::error::Error> { Box::new(e) })?;
            let store = Arc::new(
                MeetingStore::new(&root)
                    .map_err(|e| -> Box<dyn std::error::Error> { Box::new(e) })?,
            );
            let existing_token = load_pairing_token(&pairing_token_path(&root));
            let audio: Arc<dyn AudioCapture> = build_audio_backend();
            let state = Arc::new(AppState {
                store,
                data_dir: root.clone(),
                audio,
                pairing_token: Mutex::new(existing_token),
                settings: Mutex::new(None),
                active: Mutex::new(HashMap::new()),
                pipelines: Mutex::new(HashMap::new()),
                retry_tasks: Mutex::new(HashMap::new()),
                managed_tasks: Mutex::new(HashMap::new()),
                subscribers: Mutex::new(HashMap::new()),
            });
            let tray = tray::initialize(app.handle(), root.clone());
            if let Ok(interrupted) = state
                .store
                .find_interrupted_meetings_excluding(&HashSet::new())
            {
                tray.set_attention(!interrupted.is_empty());
            }
            let ipc_state = state.clone();
            let ipc_tray = tray.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = ipc::run_ipc_server(&root, move |msg, out_tx| {
                    let state = ipc_state.clone();
                    let tray = ipc_tray.clone();
                    async move { handle_message(state, tray, msg, out_tx).await }
                })
                .await
                {
                    tracing::error!("IPC server stopped: {error}");
                }
            });

            tracing::info!("notetaker-helper starting");
            Ok(())
        })
        .run(tauri::generate_context!())
        .unwrap_or_else(|error| {
            tracing::error!(%error, "AI Notetaker helper stopped during startup");
            std::process::exit(1);
        });
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
                        code: ErrorCode::DeviceNotFound,
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
                    message: "pairing token missing or mismatched".into(),
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
                subscribe_meeting(&state, *meeting_id, out_tx.clone()).await;
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
            subscribe_meeting(&state, meeting_id, out_tx.clone()).await;
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
                            code: ErrorCode::DeviceNotFound,
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

            match pipeline.start_recording(meeting_id) {
                Ok(started_msg) => {
                    let _ = out_tx.send(started_msg);
                    tray.set_recording(true);
                }
                Err(e) => {
                    tray.set_recording(false);
                    let _ = state.store.mark_stopped(meeting_id, chrono::Utc::now());
                    let _ = out_tx.send(HelperToExtension::Error {
                        meeting_id: Some(meeting_id),
                        code: ErrorCode::DeviceNotFound,
                        message: e.to_string(),
                    });
                    return true;
                }
            }

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
                        code: ErrorCode::DeviceNotFound,
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
                tray.set_recording(true);
                return true;
            }

            let audio = state.audio.clone();
            let state_for_audio = state.clone();
            let audio_processing_for_audio = audio_processing.clone();
            let audio_errors = out_tx.clone();
            let result = audio
                .start_capture(Box::new(move |frame| {
                    // Backends deliver frames on one dispatcher thread. Persist
                    // synchronously there so stop joins every write, and queue
                    // provider work only after the durable append completes.
                    let existing_len = match persist_audio_frame(
                        &state_for_audio.store,
                        meeting_id,
                        frame.channel,
                        &frame.pcm16,
                        frame.sample_rate_hz,
                    ) {
                        Ok(existing_len) => existing_len,
                        Err(message) => {
                            let _ = audio_errors.send(HelperToExtension::Error {
                                meeting_id: Some(meeting_id),
                                code: ErrorCode::StorageError,
                                message,
                            });
                            return;
                        }
                    };
                    let _ = audio_processing_for_audio.enqueue(PersistedAudioChunk {
                        channel: frame.channel,
                        pcm16: frame.pcm16,
                        sample_rate_hz: frame.sample_rate_hz,
                        existing_len,
                    });
                }))
                .await;

            match result {
                Ok(()) => {
                    state.active.lock().await.insert(
                        meeting_id,
                        ActiveRecording {
                            audio: Some(audio),
                            audio_processing,
                            capture_source,
                            processing_mode: processing_mode.clone(),
                        },
                    );
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
                    code: ErrorCode::DeviceNotFound,
                    message: "browser audio arrived for a meeting that is not using Meet capture"
                        .into(),
                });
                return true;
            }
            let pcm16 = match decode_browser_audio_chunk(&pcm16_base64, sample_rate_hz) {
                Ok(bytes) => bytes,
                Err(message) => {
                    let _ = out_tx.send(HelperToExtension::Error {
                        meeting_id: Some(meeting_id),
                        code: ErrorCode::DeviceNotFound,
                        message,
                    });
                    return true;
                }
            };
            let Some(active) = state.active.lock().await.get(&meeting_id).cloned() else {
                let _ = out_tx.send(HelperToExtension::Error {
                    meeting_id: Some(meeting_id),
                    code: ErrorCode::DeviceNotFound,
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
                Err(message) => {
                    let _ = out_tx.send(HelperToExtension::Error {
                        meeting_id: Some(meeting_id),
                        code: ErrorCode::DeviceNotFound,
                        message,
                    });
                    return true;
                }
            };
            let _ = active.audio_processing.enqueue(PersistedAudioChunk {
                channel: provider_channel,
                pcm16,
                sample_rate_hz,
                existing_len,
            });
            true
        }

        ExtensionToHelper::StopRecording {
            meeting_id,
            flagged_moments,
        } => {
            let active_recording = state.active.lock().await.remove(&meeting_id);
            if active_recording.is_none() && !state.pipelines.lock().await.contains_key(&meeting_id)
            {
                let _ = out_tx.send(HelperToExtension::Error {
                    meeting_id: Some(meeting_id), code: ErrorCode::StorageError,
                    message: "This recording is not active. Recover it from the interrupted recordings list.".into(),
                });
                return true;
            }
            if let Some(active) = &active_recording {
                if let Some(audio) = &active.audio {
                    let _ = audio.stop_capture().await;
                }
                active.audio_processing.finish().await;
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
                tray.set_recording(false);
                match messages {
                    Ok(messages) => {
                        for m in messages {
                            send_meeting_message(&state, meeting_id, m).await;
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
                                        )
                                        .await
                                    }
                                },
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
                                    )
                                    .await
                                }
                            }
                        }
                    }
                    Err(e) => {
                        let _ = out_tx.send(HelperToExtension::Error {
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
            true
        }

        // Resuming a crash-recovered meeting: finalize whatever transcript
        // was already captured before the interruption, then transcribe the
        // durable raw-audio tail before summarizing it.
        ExtensionToHelper::ResumeRecording { meeting_id } => {
            if let Ok(meta) = state.store.load_meta(meeting_id) {
                if meta.managed_pending {
                    subscribe_meeting(&state, meeting_id, out_tx.clone()).await;
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
            subscribe_meeting(&state, meeting_id, out_tx.clone()).await;
            match pipeline.lock().await.recover_recording(meeting_id).await {
                Ok(messages) => {
                    for message in messages {
                        send_meeting_message(&state, meeting_id, message).await;
                    }
                }
                Err(error) => {
                    let _ = out_tx.send(HelperToExtension::Error {
                        meeting_id: Some(meeting_id),
                        code: ErrorCode::DeviceNotFound,
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
                    code: ErrorCode::DeviceNotFound,
                    message: format!("could not delete recovered recording: {error}"),
                });
            }
            true
        }

        ExtensionToHelper::DeleteMeeting { meeting_id } => {
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
            if let Err(error) = state.store.delete_meeting(meeting_id) {
                let _ = out_tx.send(HelperToExtension::Error {
                    meeting_id: Some(meeting_id),
                    code: ErrorCode::DeviceNotFound,
                    message: format!("could not delete meeting data: {error}"),
                });
            }
            let _ = std::fs::remove_file(state.data_dir.join(format!("retry-{meeting_id}.json")));
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
            let diagnostics = audio.diagnostics();
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
        loop {
            ticker.tick().await;
            let (messages, queue_empty, summary_pending) = {
                let mut pipeline = pipeline.lock().await;
                let now = chrono::Utc::now();
                let mut messages = pipeline.process_due_retries(now).await;
                messages.extend(pipeline.process_pending_summary(meeting_id).await);
                (
                    messages,
                    pipeline.retry_queue_len() == 0,
                    pipeline.has_pending_summary(meeting_id),
                )
            };
            for message in messages {
                send_meeting_message(&state, meeting_id, message).await;
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
            let messages = pipeline
                .lock()
                .await
                .handle_persisted_audio_chunk(
                    meeting_id,
                    chunk.channel,
                    &chunk.pcm16,
                    chunk.sample_rate_hz,
                    chunk.existing_len,
                )
                .await;
            for message in messages {
                send_meeting_message(&state, meeting_id, message).await;
            }
        }
    });
    Arc::new(AudioProcessingQueue {
        sender: std::sync::Mutex::new(Some(sender)),
        task: Mutex::new(Some(task)),
    })
}

fn persist_audio_frame(
    store: &MeetingStore,
    meeting_id: Uuid,
    channel: notetaker_core::providers::AudioChannel,
    pcm16: &[u8],
    sample_rate_hz: u32,
) -> Result<usize, String> {
    let channel_file = match channel {
        notetaker_core::providers::AudioChannel::Mic => notetaker_core::storage::MIC_FILE,
        notetaker_core::providers::AudioChannel::Speaker => notetaker_core::storage::SPEAKER_FILE,
    };
    let existing_len = std::fs::metadata(store.audio_path(meeting_id, channel_file))
        .map(|metadata| metadata.len() as usize)
        .unwrap_or(0);
    store
        .append_audio(meeting_id, channel_file, pcm16)
        .map_err(|error| format!("failed to persist audio to disk: {error}"))?;
    store
        .mark_audio_sample_rate(meeting_id, channel_file, sample_rate_hz)
        .map_err(|error| format!("failed to persist audio metadata: {error}"))?;
    Ok(existing_len)
}

async fn start_pending_retry_workers(
    state: Arc<AppState>,
    settings: Settings,
    out_tx: ipc::OutSender,
) {
    for meeting_id in pending_processing_meeting_ids(&state.data_dir) {
        subscribe_meeting(&state, meeting_id, out_tx.clone()).await;
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

async fn subscribe_meeting(state: &Arc<AppState>, meeting_id: Uuid, out_tx: ipc::OutSender) {
    let mut subscribers = state.subscribers.lock().await;
    let entries = subscribers.entry(meeting_id).or_default();
    entries.retain(|sender| !sender.is_closed());
    if !entries.iter().any(|sender| sender.same_channel(&out_tx)) {
        entries.push(out_tx);
    }
}

async fn send_meeting_message(state: &Arc<AppState>, meeting_id: Uuid, message: HelperToExtension) {
    let mut subscribers = state.subscribers.lock().await;
    let Some(entries) = subscribers.get_mut(&meeting_id) else {
        return;
    };
    entries.retain(|sender| !sender.is_closed() && sender.send(message.clone()).is_ok());
    if entries.is_empty() {
        subscribers.remove(&meeting_id);
    }
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
        subscribe_meeting(&state, meta.id, out_tx.clone()).await;
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

#[cfg(test)]
mod tests {
    use super::*;
    use notetaker_core::storage::MeetingStore;

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
    fn a_missing_browser_token_can_repair_an_existing_helper_pairing() {
        assert!(should_issue_pairing_token(None, None));
        assert!(should_issue_pairing_token(Some("helper-token"), None));
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
