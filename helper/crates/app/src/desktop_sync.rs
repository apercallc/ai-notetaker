//! Optional text-only synchronization from the local meeting store.
//! Provider keys and raw audio never enter this module or its requests.

use chrono::{DateTime, Utc};
use notetaker_core::native_messaging::{ActionItem, MeetingMode};
use notetaker_core::storage::{MeetingState, MeetingStore};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

const OUTBOX_FILE: &str = "desktop-webapp-outbox.json";
const MAX_REQUEST_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedSyncState {
    pending: Vec<Uuid>,
    last_error: Option<String>,
    last_success_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSyncStatus {
    pub configured: bool,
    pub pending: usize,
    pub last_error: Option<String>,
    pub last_success_at: Option<String>,
}

pub struct DesktopSync {
    path: PathBuf,
    state: Mutex<PersistedSyncState>,
    load_error: Option<String>,
    // One sequential worker prevents duplicate concurrent uploads from event,
    // retry, and settings-save triggers. The server upsert is idempotent too.
    worker: tokio::sync::Mutex<()>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncPayload {
    id: String,
    title: String,
    mode: MeetingMode,
    started_at: DateTime<Utc>,
    ended_at: DateTime<Utc>,
    transcript: Vec<SyncTranscriptSegment>,
    summary: String,
    action_items: Vec<ActionItem>,
    capture_source: &'static str,
    processing_mode: &'static str,
}

#[derive(Serialize)]
struct SyncTranscriptSegment {
    speaker: String,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    timestamp: Option<String>,
}

impl DesktopSync {
    pub fn load(data_dir: &Path) -> Arc<Self> {
        let path = data_dir.join(OUTBOX_FILE);
        let (state, load_error) = match std::fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice(&bytes) {
                Ok(state) => (state, None),
                Err(error) => (
                    PersistedSyncState::default(),
                    Some(format!(
                        "Saved web-app sync queue could not be read: {error}"
                    )),
                ),
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                (PersistedSyncState::default(), None)
            }
            Err(error) => (
                PersistedSyncState::default(),
                Some(format!(
                    "Saved web-app sync queue could not be read: {error}"
                )),
            ),
        };
        Arc::new(Self {
            path,
            state: Mutex::new(state),
            load_error,
            worker: tokio::sync::Mutex::new(()),
        })
    }

    pub fn status(&self, configured: bool) -> DesktopSyncStatus {
        let state = self.lock_state();
        DesktopSyncStatus {
            configured,
            pending: state.pending.len(),
            last_error: self.load_error.clone().or_else(|| state.last_error.clone()),
            last_success_at: state.last_success_at.map(|at| at.to_rfc3339()),
        }
    }

    pub fn enqueue(&self, meeting_id: Uuid) -> Result<(), String> {
        if let Some(error) = &self.load_error {
            return Err(error.clone());
        }
        let mut state = self.lock_state();
        if state.pending.contains(&meeting_id) {
            return Ok(());
        }
        state.pending.push(meeting_id);
        state.last_error = None;
        self.persist(&state)
    }

    pub fn remove(&self, meeting_id: Uuid) -> Result<(), String> {
        if self.load_error.is_some() {
            return Ok(());
        }
        let mut state = self.lock_state();
        state.pending.retain(|id| *id != meeting_id);
        self.persist(&state)
    }

    pub async fn sync_pending(
        &self,
        store: Arc<MeetingStore>,
        base_url: &str,
        token: &str,
    ) -> Result<(), String> {
        if let Some(error) = &self.load_error {
            return Err(error.clone());
        }
        let _worker = self.worker.lock().await;
        let pending = self.lock_state().pending.clone();
        if pending.is_empty() || token.trim().is_empty() {
            return Ok(());
        }

        let endpoint = format!(
            "{}/api/v1/desktop-sync/meetings",
            base_url.trim_end_matches('/')
        );
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(5))
            .timeout(std::time::Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "Web-app connection could not be configured.".to_string())?;

        for meeting_id in pending {
            let store = store.clone();
            let payload = tokio::task::spawn_blocking(move || build_payload(&store, meeting_id))
                .await
                .map_err(|_| "A saved note could not be prepared for sync.".to_string())?
                .inspect_err(|error| {
                    self.record_error(error.clone());
                })?;
            let body = serde_json::to_vec(&payload)
                .map_err(|_| "A saved note could not be encoded for sync.".to_string())?;
            if body.len() > MAX_REQUEST_BYTES {
                let error = "This note is too large for the web-app sync API.".to_string();
                self.record_error(error.clone());
                return Err(error);
            }

            let response = client
                .post(&endpoint)
                .bearer_auth(token)
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body)
                .send()
                .await;
            match response {
                Ok(response) if response.status().is_success() => {
                    self.record_success(meeting_id)?
                }
                Ok(response) => {
                    let status = response.status();
                    let message = match status.as_u16() {
                        400 | 413 | 422 => "The web app rejected a saved note. Update the web app, then retry sync.",
                        401 => "The web-app token is invalid, expired, or revoked. Create a new desktop sync token and save it again.",
                        403 => "The desktop sync token no longer has access to its workspace. Create a token for the correct workspace.",
                        404 => "This web-app version does not support desktop note sync yet.",
                        429 => "The web app is receiving too many requests. Sync will retry later.",
                        _ => "The web app could not save this note. Sync will retry later.",
                    };
                    let error = format!("{message} (HTTP {status})");
                    self.record_error(error.clone());
                    return Err(error);
                }
                Err(_) => {
                    let error = "Could not reach the web app. The note stays on this device and sync will retry.".to_string();
                    self.record_error(error.clone());
                    return Err(error);
                }
            }
        }
        Ok(())
    }

    fn record_success(&self, meeting_id: Uuid) -> Result<(), String> {
        let mut state = self.lock_state();
        state.pending.retain(|id| *id != meeting_id);
        state.last_error = None;
        state.last_success_at = Some(Utc::now());
        self.persist(&state)
    }

    fn record_error(&self, error: String) {
        let mut state = self.lock_state();
        state.last_error = Some(error);
        if let Err(persist_error) = self.persist(&state) {
            tracing::warn!(%persist_error, "web-app sync status could not be saved");
        }
    }

    fn persist(&self, state: &PersistedSyncState) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(state)
            .map_err(|_| "Web-app sync queue could not be encoded.".to_string())?;
        let temporary =
            self.path
                .with_file_name(format!(".{}.{}.tmp", OUTBOX_FILE, Uuid::new_v4()));
        let result = (|| {
            #[cfg(unix)]
            let mut file = {
                use std::os::unix::fs::OpenOptionsExt;
                std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(&temporary)?
            };
            #[cfg(not(unix))]
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            std::fs::rename(&temporary, &self.path)
        })();
        if let Err(error) = result {
            let _ = std::fs::remove_file(&temporary);
            return Err(format!("Web-app sync queue could not be saved: {error}"));
        }
        Ok(())
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, PersistedSyncState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn build_payload(store: &MeetingStore, meeting_id: Uuid) -> Result<SyncPayload, String> {
    let meta = store
        .load_meta(meeting_id)
        .map_err(|_| "A local note queued for sync is no longer available.".to_string())?;
    if meta.state != MeetingState::Processed {
        return Err(
            "A local note is not finished yet; it will sync when processing completes.".into(),
        );
    }
    if meta.managed_account_id.is_some() || meta.managed_workspace_id.is_some() {
        return Err("Only local BYOK notes can sync through this connection.".into());
    }
    let summary = store
        .load_summary(meeting_id)
        .map_err(|_| "A local note summary could not be read for sync.".to_string())?
        .ok_or_else(|| "A finished local note has no summary to sync.".to_string())?;
    let transcript = store
        .load_transcript(meeting_id)
        .map_err(|_| "A local transcript could not be read for sync.".to_string())?
        .into_iter()
        .map(|segment| SyncTranscriptSegment {
            speaker: segment.speaker,
            text: segment.text,
            timestamp: segment.timestamp,
        })
        .collect();
    let ended_at = meta
        .ended_at
        .ok_or_else(|| "A finished local note has no end time to sync.".to_string())?
        .max(meta.started_at);
    Ok(SyncPayload {
        id: meta.id.to_string(),
        title: meta
            .title
            .unwrap_or_else(|| format!("Meeting on {}", meta.started_at.format("%Y-%m-%d"))),
        mode: meta.summary_options.mode,
        started_at: meta.started_at,
        ended_at,
        transcript,
        summary: summary.summary,
        action_items: summary.action_items,
        capture_source: "desktop",
        processing_mode: "local_byok",
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use notetaker_core::providers::{Summary, TranscriptSegment};

    #[test]
    fn outbox_survives_restart_and_removes_completed_ids() {
        let directory = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4();
        let queue = DesktopSync::load(directory.path());
        queue.enqueue(id).unwrap();
        drop(queue);

        let reopened = DesktopSync::load(directory.path());
        assert_eq!(reopened.status(true).pending, 1);
        reopened.remove(id).unwrap();
        assert_eq!(DesktopSync::load(directory.path()).status(true).pending, 0);
    }

    #[test]
    fn sync_payload_contains_note_text_and_never_audio_or_provider_secrets() {
        let directory = tempfile::tempdir().unwrap();
        let store = MeetingStore::new(directory.path()).unwrap();
        let id = Uuid::new_v4();
        let started = Utc::now();
        store.create_meeting(id, started).unwrap();
        store.set_title(id, "Planning").unwrap();
        store
            .mark_stopped(id, started + chrono::Duration::minutes(10))
            .unwrap();
        store
            .append_transcript_segment(
                id,
                &TranscriptSegment {
                    speaker: "Speaker 1".into(),
                    text: "Next week.".into(),
                    is_final: true,
                    timestamp: None,
                },
            )
            .unwrap();
        store
            .write_summary(
                id,
                &Summary {
                    summary: "Plan next week.".into(),
                    action_items: vec![],
                },
            )
            .unwrap();
        store.mark_processed(id).unwrap();

        let payload = serde_json::to_value(build_payload(&store, id).unwrap()).unwrap();
        assert_eq!(payload["transcript"][0]["text"], "Next week.");
        assert!(payload["transcript"][0].get("timestamp").is_none());
        assert_eq!(payload["summary"], "Plan next week.");
        let encoded = payload.to_string();
        assert!(!encoded.contains("audio"));
        assert!(!encoded.contains("providerKey"));
    }
}
