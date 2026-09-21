//! `notetaker-helper` — the persistent tray app. Owns the AI pipeline, the
//! audio capture lifecycle, and crash recovery, per the non-negotiable
//! constraint that the helper (not the extension) owns the pipeline.
//!
//! Talks to `notetaker-nm-host` shim instances over a local socket (see
//! `ipc.rs`); those shims are what Chrome actually spawns per
//! `docs/native-messaging-protocol.md`.

mod ipc;
mod tray;

use notetaker_audio::AudioCapture;
use notetaker_core::native_messaging::{ErrorCode, ExtensionToHelper, HelperToExtension};
use notetaker_core::pipeline::{Pipeline, RetryableChunk};
use notetaker_core::providers::test_provider_key;
use notetaker_core::resilience::RetryQueue;
use notetaker_core::storage::MeetingStore;
use notetaker_core::{
    build_summarization_provider, build_transcription_provider, native_messaging,
};
use std::collections::HashMap;
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
    pairing_token: Mutex<Option<String>>,
    settings: Mutex<Option<Settings>>,
    active: Mutex<HashMap<Uuid, ActiveRecording>>,
    pipelines: Mutex<HashMap<Uuid, Arc<Mutex<Pipeline>>>>,
    retry_tasks: Mutex<HashMap<Uuid, RetryWorker>>,
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
            let state = Arc::new(AppState {
                store,
                data_dir: root.clone(),
                pairing_token: Mutex::new(existing_token),
                settings: Mutex::new(None),
                active: Mutex::new(HashMap::new()),
                pipelines: Mutex::new(HashMap::new()),
                retry_tasks: Mutex::new(HashMap::new()),
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

            // Crash recovery: surface any meeting left in `Recording`
            // state by an unclean shutdown, once per new connection.
            if let Ok(interrupted) = state.store.find_interrupted_meetings() {
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

        ExtensionToHelper::StartRecording { meeting_id } => {
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
            let pipeline = Pipeline::new(
                store,
                build_transcription_provider(transcription_provider, transcription_key),
                build_summarization_provider(summarization_provider, summarization_key),
                retry_queue,
            );

            match pipeline.start_recording(meeting_id) {
                Ok(started_msg) => {
                    let _ = out_tx.send(started_msg);
                    tray.set_recording(true);
                }
                Err(e) => {
                    tray.set_recording(false);
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
            let retry_task = spawn_retry_worker(pipeline.clone(), out_tx.clone());
            state
                .retry_tasks
                .lock()
                .await
                .insert(meeting_id, retry_task);

            let audio: Arc<dyn AudioCapture> = build_audio_backend();
            let out_tx_for_audio = out_tx.clone();
            let pipeline_for_audio = pipeline.clone();
            let result = audio
                .start_capture(Box::new(move |frame| {
                    let out_tx = out_tx_for_audio.clone();
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
                            let _ = out_tx.send(m);
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
            let worker = state.retry_tasks.lock().await.remove(&meeting_id);
            if let Some(active) = state.active.lock().await.remove(&meeting_id) {
                let _ = active.audio.stop_capture().await;
            }
            if let Some(pipeline) = state.pipelines.lock().await.remove(&meeting_id) {
                let messages = pipeline.lock().await.stop_recording(meeting_id).await;
                tray.set_recording(false);
                match messages {
                    Ok(messages) => {
                        for m in messages {
                            let _ = out_tx.send(m);
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
            if let Some(worker) = worker {
                worker.request_stop();
            }
            true
        }

        // Resuming a crash-recovered meeting: finalize whatever transcript
        // was already captured before the interruption. Re-transcribing
        // the raw-audio tail that was captured but never sent to the
        // transcription provider before the crash is NOT implemented in
        // this pass — flagged in the implementation report.
        ExtensionToHelper::ResumeRecording { meeting_id } => {
            let store =
                MeetingStore::new(&state.data_dir).expect("data dir already validated at startup");
            let _ = store.mark_stopped(meeting_id, chrono::Utc::now());
            let _ = out_tx.send(HelperToExtension::RecordingStopped { meeting_id });
            if let Some(worker) = state.retry_tasks.lock().await.get(&meeting_id) {
                worker.request_stop();
            }
            true
        }

        ExtensionToHelper::DiscardRecording { meeting_id } => {
            if let Some(worker) = state.retry_tasks.lock().await.remove(&meeting_id) {
                worker.abort();
            }
            state.pipelines.lock().await.remove(&meeting_id);
            let _ = std::fs::remove_file(state.data_dir.join(format!("retry-{meeting_id}.json")));
            let store =
                MeetingStore::new(&state.data_dir).expect("data dir already validated at startup");
            let _ = store.mark_processed(meeting_id);
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
    }
}

fn spawn_retry_worker(pipeline: Arc<Mutex<Pipeline>>, out_tx: ipc::OutSender) -> RetryWorker {
    let stop_when_empty = Arc::new(AtomicBool::new(false));
    let stop_signal = stop_when_empty.clone();
    let task = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(5));
        loop {
            ticker.tick().await;
            let (messages, queue_empty) = {
                let mut pipeline = pipeline.lock().await;
                let messages = pipeline.process_due_retries(chrono::Utc::now()).await;
                (messages, pipeline.retry_queue_len() == 0)
            };
            for message in messages {
                if out_tx.send(message).is_err() {
                    return;
                }
            }
            if stop_signal.load(Ordering::Acquire) && queue_empty {
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
    for meeting_id in pending_retry_meeting_ids(&state.data_dir) {
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
            if pipeline.lock().await.retry_queue_len() > 0 {
                let worker = spawn_retry_worker(pipeline, out_tx.clone());
                state.retry_tasks.lock().await.insert(meeting_id, worker);
            }
            continue;
        }

        let pipeline = match build_retry_pipeline(&state.data_dir, meeting_id, &settings) {
            Ok(pipeline) if pipeline.retry_queue_len() > 0 => Arc::new(Mutex::new(pipeline)),
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
        let worker = spawn_retry_worker(pipeline, out_tx.clone());
        state.retry_tasks.lock().await.insert(meeting_id, worker);
    }
}

fn pending_retry_meeting_ids(root: &Path) -> Vec<Uuid> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return vec![];
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let value = name.strip_prefix("retry-")?.strip_suffix(".json")?;
            Uuid::parse_str(value).ok()
        })
        .collect()
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
    ))
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
