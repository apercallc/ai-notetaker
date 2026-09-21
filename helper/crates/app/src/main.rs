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
use notetaker_core::resilience::RetryQueue;
use notetaker_core::storage::MeetingStore;
use notetaker_core::providers::test_provider_key;
use notetaker_core::{build_summarization_provider, build_transcription_provider, native_messaging};
use std::collections::HashMap;
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
}

fn data_dir() -> std::path::PathBuf {
    dirs::data_dir().unwrap_or_else(std::env::temp_dir).join("ai-notetaker")
}

fn pairing_token_path(root: &std::path::Path) -> std::path::PathBuf {
    root.join("pairing_token.txt")
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_writer(std::io::stderr).init();

    let root = data_dir();
    std::fs::create_dir_all(&root)?;
    let store = Arc::new(MeetingStore::new(&root)?);

    let existing_token = std::fs::read_to_string(pairing_token_path(&root)).ok();

    let state = Arc::new(AppState {
        store,
        data_dir: root.clone(),
        pairing_token: Mutex::new(existing_token),
        settings: Mutex::new(None),
        active: Mutex::new(HashMap::new()),
        pipelines: Mutex::new(HashMap::new()),
    });

    tray::spawn_tray_icon(); // no-op stub in headless/CI environments, see tray.rs

    tracing::info!("notetaker-helper starting, data dir: {}", root.display());

    ipc::run_ipc_server(move |msg, out_tx| {
        let state = state.clone();
        async move {
            handle_message(state, msg, out_tx).await;
        }
    })
    .await?;

    Ok(())
}

async fn handle_message(state: Arc<AppState>, msg: ExtensionToHelper, out_tx: ipc::OutSender) {
    match msg {
        ExtensionToHelper::Hello { pairing_token } => {
            let mut current = state.pairing_token.lock().await;
            match (&*current, pairing_token) {
                (None, _) => {
                    // First ever pairing (or the token file didn't survive
                    // a reinstall) — issue a new one.
                    let token = native_messaging::generate_pairing_token();
                    let _ = std::fs::write(pairing_token_path(&state.data_dir), &token);
                    *current = Some(token.clone());
                    let _ = out_tx.send(HelperToExtension::Paired { pairing_token: token });
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
                    return;
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
        }

        ExtensionToHelper::Settings { .. } => {
            *state.settings.lock().await = Some(Settings { inner: msg });
        }

        ExtensionToHelper::StartRecording { meeting_id } => {
            let settings_guard = state.settings.lock().await;
            let Some(settings) = settings_guard.clone() else {
                let _ = out_tx.send(HelperToExtension::Error {
                    meeting_id: Some(meeting_id),
                    code: ErrorCode::ProviderAuthFailed,
                    message: "no provider settings configured yet".into(),
                });
                return;
            };
            drop(settings_guard);

            let ExtensionToHelper::Settings { transcription_provider, summarization_provider, api_keys, .. } = settings.inner else {
                unreachable!("Settings.inner is always the Settings variant");
            };

            let (transcription_key, summarization_key) = match resolve_keys(transcription_provider, summarization_provider, &api_keys) {
                Ok(keys) => keys,
                Err(message) => {
                    let _ = out_tx.send(HelperToExtension::Error { meeting_id: Some(meeting_id), code: ErrorCode::ProviderAuthFailed, message });
                    return;
                }
            };

            let retry_path = state.data_dir.join(format!("retry-{meeting_id}.json"));
            let retry_queue: RetryQueue<RetryableChunk> = match RetryQueue::load_or_create(retry_path) {
                Ok(q) => q,
                Err(e) => {
                    let _ = out_tx.send(HelperToExtension::Error { meeting_id: Some(meeting_id), code: ErrorCode::DeviceNotFound, message: e.to_string() });
                    return;
                }
            };
            let store = MeetingStore::new(&state.data_dir).expect("data dir already validated at startup");
            let pipeline = Pipeline::new(
                store,
                build_transcription_provider(transcription_provider, transcription_key),
                build_summarization_provider(summarization_provider, summarization_key),
                retry_queue,
            );

            match pipeline.start_recording(meeting_id) {
                Ok(started_msg) => {
                    let _ = out_tx.send(started_msg);
                }
                Err(e) => {
                    let _ = out_tx.send(HelperToExtension::Error { meeting_id: Some(meeting_id), code: ErrorCode::DeviceNotFound, message: e.to_string() });
                    return;
                }
            }

            let pipeline = Arc::new(Mutex::new(pipeline));
            state.pipelines.lock().await.insert(meeting_id, pipeline.clone());

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
                            .handle_audio_chunk(meeting_id, frame.channel, &frame.pcm16, frame.sample_rate_hz)
                            .await;
                        for m in messages {
                            let _ = out_tx.send(m);
                        }
                    });
                }))
                .await;

            match result {
                Ok(()) => {
                    state.active.lock().await.insert(meeting_id, ActiveRecording { audio });
                }
                Err(e) => {
                    let _ = out_tx.send(HelperToExtension::Error { meeting_id: Some(meeting_id), code: ErrorCode::DeviceNotFound, message: e.to_string() });
                }
            }
        }

        ExtensionToHelper::StopRecording { meeting_id } => {
            if let Some(active) = state.active.lock().await.remove(&meeting_id) {
                let _ = active.audio.stop_capture().await;
            }
            if let Some(pipeline) = state.pipelines.lock().await.remove(&meeting_id) {
                let messages = pipeline.lock().await.stop_recording(meeting_id).await;
                match messages {
                    Ok(messages) => {
                        for m in messages {
                            let _ = out_tx.send(m);
                        }
                    }
                    Err(e) => {
                        let _ = out_tx.send(HelperToExtension::Error { meeting_id: Some(meeting_id), code: ErrorCode::ProviderUnreachable, message: e.to_string() });
                    }
                }
            }
        }

        // Resuming a crash-recovered meeting: finalize whatever transcript
        // was already captured before the interruption. Re-transcribing
        // the raw-audio tail that was captured but never sent to the
        // transcription provider before the crash is NOT implemented in
        // this pass — flagged in the implementation report.
        ExtensionToHelper::ResumeRecording { meeting_id } => {
            let store = MeetingStore::new(&state.data_dir).expect("data dir already validated at startup");
            let _ = store.mark_stopped(meeting_id, chrono::Utc::now());
            let _ = out_tx.send(HelperToExtension::RecordingStopped { meeting_id });
        }

        ExtensionToHelper::DiscardRecording { meeting_id } => {
            let store = MeetingStore::new(&state.data_dir).expect("data dir already validated at startup");
            let _ = store.mark_processed(meeting_id);
        }

        // Settings-page "Test" button, routed through the helper rather
        // than called directly from the extension — see extension/CLAUDE.md
        // and docs/native-messaging-protocol.md.
        ExtensionToHelper::TestProviderKey { provider, key } => {
            let (valid, message) = test_provider_key(provider, &key).await;
            let _ = out_tx.send(HelperToExtension::ProviderKeyTestResult { provider, valid, message });
        }
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
