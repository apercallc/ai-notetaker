//! Optional text-only synchronization from the local meeting store.
//! Provider keys and raw audio never enter this module or its requests.

use chrono::{DateTime, Utc};
use notetaker_core::native_messaging::{ActionItem, MeetingMode};
use notetaker_core::providers::{http_client_builder, Summary, TranscriptSegment};
use notetaker_core::storage::{ImportedMeetingNote, MeetingState, MeetingStore};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

const OUTBOX_FILE: &str = "desktop-webapp-outbox.json";
const MAX_REQUEST_BYTES: usize = 16 * 1024 * 1024;
const MAX_TITLE_LENGTH: usize = 200;
const MAX_SUMMARY_LENGTH: usize = 100_000;
const MAX_TRANSCRIPT_SEGMENTS: usize = 25_000;
const MAX_TRANSCRIPT_LENGTH: usize = 5_000_000;
const MAX_SEGMENT_LENGTH: usize = 20_000;
const MAX_SPEAKER_LENGTH: usize = 100;
const MAX_ACTION_ITEMS: usize = 1_000;
const MAX_ACTION_TEXT_LENGTH: usize = 2_000;
const MAX_OWNER_LENGTH: usize = 200;
const MAX_ACTION_ID_LENGTH: usize = 128;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedSyncState {
    pending: Vec<Uuid>,
    last_error: Option<String>,
    last_success_at: Option<DateTime<Utc>>,
    #[serde(default)]
    remote_cursor: Option<RemoteCursor>,
    // Read only for compatibility with local builds that stored workspace
    // provenance in the sync state before it moved into MeetingMeta.
    #[serde(default)]
    workspace_import_ids: HashSet<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteCursor {
    updated_at: DateTime<Utc>,
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemotePage {
    meetings: Vec<RemoteMeeting>,
    has_more: bool,
    next_cursor: Option<RemoteCursor>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteMeeting {
    id: Uuid,
    title: String,
    mode: MeetingMode,
    started_at: DateTime<Utc>,
    ended_at: DateTime<Utc>,
    summary: String,
    updated_at: DateTime<Utc>,
    transcript: Vec<RemoteTranscriptSegment>,
    action_items: Vec<ActionItem>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteTranscriptSegment {
    speaker: String,
    text: String,
    timestamp: Option<DateTime<Utc>>,
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

    pub fn is_legacy_workspace_import(&self, meeting_id: Uuid) -> bool {
        self.lock_state().workspace_import_ids.contains(&meeting_id)
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
        let client = http_client_builder()
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

    /// Imports workspace notes as local copies. Existing local meeting IDs are
    /// left untouched, so pulling cannot overwrite an active local note.
    pub async fn pull_workspace_notes(
        &self,
        store: Arc<MeetingStore>,
        base_url: &str,
        token: &str,
    ) -> Result<usize, String> {
        if let Some(error) = &self.load_error {
            return Err(error.clone());
        }
        let _worker = self.worker.lock().await;
        let client = http_client_builder()
            .connect_timeout(std::time::Duration::from_secs(5))
            .timeout(std::time::Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "Web-app connection could not be configured.".to_string())?;
        let saved_cursor = self.lock_state().remote_cursor.clone();
        // Re-read a small overlap so edits that land on the same database
        // timestamp as the previous checkpoint are not skipped by ID order.
        let mut cursor = saved_cursor.map(|saved| RemoteCursor {
            updated_at: saved.updated_at - chrono::Duration::seconds(1),
            id: String::new(),
        });
        let mut imported = 0usize;
        let mut pages = 0usize;
        loop {
            pages += 1;
            if pages > 10_000 {
                return Err(
                    "Workspace note sync reached its safety limit. Retry to continue.".into(),
                );
            }
            let mut endpoint = reqwest::Url::parse(&format!(
                "{}/api/v1/desktop-sync/meetings",
                base_url.trim_end_matches('/')
            ))
            .map_err(|_| "Web-app URL is invalid.".to_string())?;
            if let Some(current) = &cursor {
                endpoint
                    .query_pairs_mut()
                    .append_pair("updatedAt", &current.updated_at.to_rfc3339());
                if !current.id.is_empty() {
                    endpoint.query_pairs_mut().append_pair("id", &current.id);
                }
            }
            let response = client
                .get(endpoint)
                .bearer_auth(token)
                .send()
                .await
                .map_err(|_| {
                    "Could not reach the web app. Workspace notes remain available online."
                        .to_string()
                })?;
            if !response.status().is_success() {
                let status = response.status();
                let message = match status.as_u16() {
                    401 => "The web-app token is invalid, expired, or revoked. Create a new desktop sync token and save it again.",
                    403 => "The desktop sync token no longer has access to its workspace.",
                    404 => "This web-app version does not support workspace note sync yet.",
                    429 => "The web app is receiving too many requests. Sync will retry later.",
                    _ => "The web app could not return workspace notes.",
                };
                return Err(format!("{message} (HTTP {status})"));
            }
            let mut response = response;
            if response
                .content_length()
                .is_some_and(|length| length > MAX_REQUEST_BYTES as u64)
            {
                return Err("A workspace note page is too large to import. Reduce the page size in the web app and retry.".into());
            }
            let mut body = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| "Workspace notes could not be downloaded.".to_string())?
            {
                if body.len().saturating_add(chunk.len()) > MAX_REQUEST_BYTES {
                    return Err("A workspace note page is too large to import. Reduce the page size in the web app and retry.".into());
                }
                body.extend_from_slice(&chunk);
            }
            let page: RemotePage = serde_json::from_slice(&body).map_err(|_| {
                "The web app returned an unsupported workspace note page.".to_string()
            })?;
            if page.meetings.len() > 50 {
                return Err("The web app returned too many notes in one page.".into());
            }
            let next_cursor = page.next_cursor;
            let has_more = page.has_more;
            if has_more && next_cursor.is_none() {
                return Err(
                    "The web app returned an incomplete sync cursor. Retry sync later.".into(),
                );
            }
            let store_for_import = store.clone();
            let page_imported = tokio::task::spawn_blocking(move || -> Result<usize, String> {
                let mut count = 0;
                for meeting in page.meetings {
                    validate_remote_meeting(&meeting)?;
                    let _remote_updated_at = meeting.updated_at;
                    let action_items = meeting.action_items;
                    let summary = (!meeting.summary.trim().is_empty() || !action_items.is_empty()).then_some(Summary {
                        summary: meeting.summary,
                        action_items,
                    });
                    let note = ImportedMeetingNote {
                        id: meeting.id,
                        workspace_import: true,
                        title: meeting.title,
                        started_at: meeting.started_at,
                        ended_at: Some(meeting.ended_at),
                        extension_source_status: "complete".into(),
                        mode: meeting.mode,
                        transcript: meeting.transcript.into_iter().map(|segment| TranscriptSegment {
                            speaker: segment.speaker,
                            text: segment.text,
                            is_final: true,
                            timestamp: segment.timestamp.map(|timestamp| timestamp.to_rfc3339()),
                        }).collect(),
                        summary,
                    };
                    if store_for_import.import_text_only_note(note)
                        .map_err(|_| "A workspace note could not be saved locally. Retry sync; existing notes are safe.".to_string())?
                    {
                        count += 1;
                    }
                }
                Ok(count)
            }).await.map_err(|_| "Workspace notes could not be imported.".to_string())??;
            imported += page_imported;
            if let Some(next) = next_cursor {
                if cursor.as_ref().is_some_and(|old| {
                    next.updated_at < old.updated_at
                        || (next.updated_at == old.updated_at && next.id <= old.id)
                }) {
                    return Err(
                        "The web app returned a stale sync cursor. Retry sync later.".into(),
                    );
                }
                cursor = Some(next);
                let mut state = self.lock_state();
                state.remote_cursor = cursor.clone();
                if state.pending.is_empty() {
                    state.last_error = None;
                }
                self.persist(&state)?;
            }
            if !has_more {
                let mut state = self.lock_state();
                if state.pending.is_empty() {
                    state.last_error = None;
                }
                self.persist(&state)?;
                return Ok(imported);
            }
        }
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

    pub fn record_sync_error(&self, error: String) {
        self.record_error(error);
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

fn validate_remote_meeting(meeting: &RemoteMeeting) -> Result<(), String> {
    let title_len = meeting.title.encode_utf16().count();
    let summary_len = meeting.summary.encode_utf16().count();
    let transcript_len = meeting
        .transcript
        .iter()
        .map(|segment| segment.text.encode_utf16().count())
        .sum::<usize>();
    let transcript_invalid = meeting.transcript.len() > MAX_TRANSCRIPT_SEGMENTS
        || transcript_len > MAX_TRANSCRIPT_LENGTH
        || meeting.transcript.iter().any(|segment| {
            segment.text.encode_utf16().count() > MAX_SEGMENT_LENGTH
                || segment.speaker.encode_utf16().count() > MAX_SPEAKER_LENGTH
        });
    let actions_invalid = meeting.action_items.len() > MAX_ACTION_ITEMS
        || meeting.action_items.iter().any(|item| {
            item.text.encode_utf16().count() > MAX_ACTION_TEXT_LENGTH
                || item
                    .status
                    .as_deref()
                    .is_some_and(|status| !matches!(status, "open" | "done"))
                || item
                    .owner
                    .as_ref()
                    .is_some_and(|owner| owner.encode_utf16().count() > MAX_OWNER_LENGTH)
                || item.id.as_ref().is_some_and(String::is_empty)
                || item
                    .id
                    .as_ref()
                    .is_some_and(|id| id.encode_utf16().count() > MAX_ACTION_ID_LENGTH)
        });

    if meeting.title.trim().is_empty()
        || title_len > MAX_TITLE_LENGTH
        || summary_len > MAX_SUMMARY_LENGTH
        || meeting.ended_at < meeting.started_at
        || transcript_invalid
        || actions_invalid
    {
        return Err("The web app returned a note outside desktop import limits.".into());
    }
    Ok(())
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
    fn old_outbox_files_load_without_reverse_sync_fields() {
        let directory = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4();
        std::fs::write(
            directory.path().join(OUTBOX_FILE),
            serde_json::json!({ "pending": [id], "lastError": null, "lastSuccessAt": null })
                .to_string(),
        )
        .unwrap();

        let sync = DesktopSync::load(directory.path());
        assert_eq!(sync.status(true).pending, 1);
    }

    #[test]
    fn older_workspace_import_index_remains_available_for_upgrade_compatibility() {
        let directory = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4();
        std::fs::write(
            directory.path().join(OUTBOX_FILE),
            serde_json::json!({ "pending": [], "workspaceImportIds": [id] }).to_string(),
        )
        .unwrap();

        assert!(DesktopSync::load(directory.path()).is_legacy_workspace_import(id));
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

    #[tokio::test]
    async fn workspace_pull_imports_text_and_persists_its_cursor() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        let directory = tempfile::tempdir().unwrap();
        let store = Arc::new(MeetingStore::new(directory.path()).unwrap());
        let sync = DesktopSync::load(directory.path());
        let id = Uuid::new_v4();
        let updated_at = Utc::now();
        let page = serde_json::json!({
            "meetings": [{
                "id": id,
                "title": "Workspace planning",
                "mode": "general",
                "startedAt": "2026-10-04T10:00:00Z",
                "endedAt": "2026-10-04T10:30:00Z",
                "summary": "Ship the sync flow.",
                "updatedAt": updated_at,
                "transcript": [
                    {"speaker": "you", "text": "Let's ship it.", "timestamp": null, "confidence": 0.99},
                    {"speaker": "you", "text": "😀".repeat(10_000), "timestamp": null}
                ],
                "actionItems": [{"id": "action-1", "text": "Write migration notes", "owner": null, "status": "open", "dueAt": null, "completedAt": null}]
            }],
            "hasMore": false,
            "nextCursor": {"updatedAt": updated_at, "id": id.to_string()},
            "serverCursorVersion": 2
        }).to_string();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let expected_page = page.clone();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut stream = BufReader::new(stream);
            let mut headers = String::new();
            loop {
                let mut line = String::new();
                let count = stream.read_line(&mut line).await.unwrap();
                if count == 0 || line == "\r\n" {
                    break;
                }
                headers.push_str(&line);
            }
            assert!(headers
                .to_ascii_lowercase()
                .contains("authorization: bearer sync-token"));
            let mut stream = stream.into_inner();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                expected_page.len(), expected_page
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });

        let imported = sync
            .pull_workspace_notes(store.clone(), &format!("http://{address}"), "sync-token")
            .await
            .unwrap();
        server.await.unwrap();
        assert_eq!(imported, 1);
        assert_eq!(
            store.load_summary(id).unwrap().unwrap().summary,
            "Ship the sync flow."
        );
        assert_eq!(
            store.load_transcript(id).unwrap()[1]
                .text
                .encode_utf16()
                .count(),
            20_000
        );
        assert!(store.load_meta(id).unwrap().workspace_import);
        let reopened = DesktopSync::load(directory.path());
        assert_eq!(
            reopened.lock_state().remote_cursor.as_ref().unwrap().id,
            id.to_string()
        );
    }
}
