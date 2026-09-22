//! `notetaker-helper` — the persistent tray app. Owns the AI pipeline, the
//! audio capture lifecycle, and crash recovery, per the non-negotiable
//! constraint that the helper (not the extension) owns the pipeline.
//!
//! Talks to `notetaker-nm-host` shim instances over a local socket (see
//! `ipc.rs`); those shims are what Chrome actually spawns per
//! `docs/native-messaging-protocol.md`.

mod ipc;
mod tray;

use notetaker_audio::{AudioCapture, AudioDiagnostics};
use notetaker_core::native_messaging::{
    ErrorCode, ExtensionToHelper, HelperToExtension, MeetingMode,
};
use notetaker_core::pipeline::{Pipeline, RetryableChunk};
use notetaker_core::providers::test_provider_key;
use notetaker_core::providers::SummaryOptions;
use notetaker_core::resilience::RetryQueue;
use notetaker_core::storage::MeetingStore;
use notetaker_core::{
    build_summarization_provider, build_transcription_provider, native_messaging,
};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Clone)]
struct Settings {
    inner: native_messaging::ExtensionToHelper, // holds the Settings variant; validated on use
}

struct ActiveRecording {
    audio: Arc<dyn AudioCapture>,
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

fn data_dir() -> std::path::PathBuf {
    dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("ai-notetaker")
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
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                None,
            ))?;

            let root = data_dir();
            secure_data_dir(&root).map_err(|e| -> Box<dyn std::error::Error> { Box::new(e) })?;
            let store = Arc::new(
                MeetingStore::new(&root)
                    .map_err(|e| -> Box<dyn std::error::Error> { Box::new(e) })?,
            );
            let existing_token = std::fs::read_to_string(pairing_token_path(&root)).ok();
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
                subscribers: Mutex::new(HashMap::new()),
            });
            let tray = tray::initialize(app.handle(), root.clone())?;
            let ipc_state = state.clone();
            let ipc_tray = tray.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = ipc::run_ipc_server(move |msg, out_tx| {
                    let state = ipc_state.clone();
                    let tray = ipc_tray.clone();
                    async move { handle_message(state, tray, msg, out_tx).await }
                })
                .await
                {
                    tracing::error!("IPC server stopped: {error}");
                }
            });

            tracing::info!("notetaker-helper starting, data dir: {}", root.display());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running AI Notetaker helper");
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
            match (&*current, pairing_token) {
                (None, _) => {
                    // First ever pairing (or the token file didn't survive
                    // a reinstall) — issue a new one.
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
                }
                (Some(expected), Some(provided)) if *expected == provided => {
                    // Already paired and the token matches — nothing to
                    // send yet; recoverable-meeting notices go out next.
                }
                _ => {
                    let _ = out_tx.send(HelperToExtension::Error {
                        meeting_id: None,
                        code: ErrorCode::HelperNotPaired,
                        message: "pairing token missing or mismatched".into(),
                    });
                    return false;
                }
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
            true
        }

        ExtensionToHelper::StartRecording {
            meeting_id,
            meeting_mode,
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
            let store =
                MeetingStore::new(&state.data_dir).expect("data dir already validated at startup");
            let mut pipeline = Pipeline::new(
                store,
                build_transcription_provider(transcription_provider, transcription_key),
                build_summarization_provider(summarization_provider, summarization_key),
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

            let audio = state.audio.clone();
            let state_for_audio = state.clone();
            let pipeline_for_audio = pipeline.clone();
            let result = audio
                .start_capture(Box::new(move |frame| {
                    let state = state_for_audio.clone();
                    let pipeline = pipeline_for_audio.clone();
                    tokio::spawn(async move {
                        let messages = pipeline
                            .lock()
                            .await
                            .handle_audio_chunk(
                                meeting_id,
                                frame.channel,
                                &frame.pcm16,
                                frame.sample_rate_hz,
                            )
                            .await;
                        for m in messages {
                            send_meeting_message(&state, meeting_id, m).await;
                        }
                    });
                }))
                .await;

            match result {
                Ok(()) => {
                    state
                        .active
                        .lock()
                        .await
                        .insert(meeting_id, ActiveRecording { audio });
                }
                Err(e) => {
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

        ExtensionToHelper::StopRecording { meeting_id } => {
            if let Some(active) = state.active.lock().await.remove(&meeting_id) {
                let _ = active.audio.stop_capture().await;
            }
            if let Some(pipeline) = state.pipelines.lock().await.get(&meeting_id).cloned() {
                let messages = pipeline.lock().await.stop_recording(meeting_id).await;
                tray.set_recording(false);
                match messages {
                    Ok(messages) => {
                        for m in messages {
                            send_meeting_message(&state, meeting_id, m).await;
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
                let _ = active.audio.stop_capture().await;
                tray.set_recording(false);
            }
            if let Some(worker) = state.retry_tasks.lock().await.remove(&meeting_id) {
                worker.abort();
            }
            state.pipelines.lock().await.remove(&meeting_id);
            let _ = std::fs::remove_file(state.data_dir.join(format!("retry-{meeting_id}.json")));
            let store =
                MeetingStore::new(&state.data_dir).expect("data dir already validated at startup");
            if let Err(error) = store.delete_meeting(meeting_id) {
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
                let _ = active.audio.stop_capture().await;
                tray.set_recording(false);
            }
            if let Some(worker) = state.retry_tasks.lock().await.remove(&meeting_id) {
                worker.abort();
            }
            state.pipelines.lock().await.remove(&meeting_id);
            let store =
                MeetingStore::new(&state.data_dir).expect("data dir already validated at startup");
            if let Err(error) = store.delete_meeting(meeting_id) {
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
            let _ = out_tx.send(audio_status_message(diagnostics, prepare_error));
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
    let Ok(entries) = std::fs::read_dir(root) else {
        return vec![];
    };
    let mut ids = HashSet::new();
    for entry in entries.filter_map(Result::ok) {
        if let Some(id) = entry.file_name().to_str().and_then(|name| {
            let value = name.strip_prefix("retry-")?.strip_suffix(".json")?;
            Uuid::parse_str(value).ok()
        }) {
            ids.insert(id);
        }
        if let Ok(bytes) = std::fs::read(entry.path().join("meta.json")) {
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
