//! Optional text-only synchronization from the local meeting store.
//! Provider keys and raw audio never enter this module or its requests.

use chrono::{DateTime, Utc};
use notetaker_core::native_messaging::{ActionItem, MeetingMode};
use notetaker_core::providers::{http_client_builder, Summary, TranscriptSegment};
use notetaker_core::storage::{
    ImportedMeetingNote, MeetingState, MeetingStore, WorkspaceImportOutcome,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
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
const MAX_SYNC_CONFLICTS: usize = 100;

fn remote_version_key(meeting_id: Uuid, source_id: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(meeting_id.as_bytes());
    digest.update([0]);
    digest.update(source_id.as_bytes());
    digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

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
    #[serde(default)]
    remote_versions: HashMap<Uuid, DateTime<Utc>>,
    #[serde(default)]
    scoped_remote_versions: HashMap<String, DateTime<Utc>>,
    #[serde(default)]
    conflicts: Vec<SyncConflict>,
    #[serde(default)]
    separate_copies: HashSet<String>,
    /// Notes the user deleted on this device. Deleting removes a note from this device only, so
    /// the next pull must not quietly bring it back (which would look like a duplicate).
    #[serde(default)]
    dismissed: HashSet<Uuid>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncConflictReason {
    Updated,
    Removed,
    Trashed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncConflict {
    meeting_id: Uuid,
    webapp_url: String,
    workspace_id: String,
    #[serde(default = "default_conflict_reason")]
    reason: SyncConflictReason,
    #[serde(default)]
    remote_updated_at: Option<DateTime<Utc>>,
}

fn default_conflict_reason() -> SyncConflictReason {
    SyncConflictReason::Updated
}

impl SyncConflict {
    fn key(&self) -> String {
        sync_conflict_key(self.meeting_id, &self.webapp_url, &self.workspace_id)
    }
}

fn sync_conflict_key(meeting_id: Uuid, webapp_url: &str, workspace_id: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(meeting_id.as_bytes());
    digest.update([0]);
    digest.update(webapp_url.as_bytes());
    digest.update([0]);
    digest.update(workspace_id.as_bytes());
    digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSyncConflictStatus {
    pub meeting_id: String,
    pub key: String,
    pub reason: SyncConflictReason,
    pub remote_updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteCursor {
    updated_at: DateTime<Utc>,
    id: String,
}

struct WorkspacePageImport {
    imported: usize,
    versions: Vec<(Uuid, DateTime<Utc>)>,
    conflicts: Vec<(Uuid, DateTime<Utc>)>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemotePage {
    workspace_id: String,
    meetings: Vec<RemoteMeeting>,
    has_more: bool,
    next_cursor: Option<RemoteCursor>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadReceipt {
    updated_at: DateTime<Utc>,
    workspace_id: String,
}

#[derive(Deserialize)]
struct WorkspaceIdentityResponse {
    workspace: WorkspaceIdentity,
}

#[derive(Deserialize)]
struct WorkspaceIdentity {
    id: String,
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
    pub conflicts: Vec<DesktopSyncConflictStatus>,
    pub separate_copies: usize,
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
            conflicts: state
                .conflicts
                .iter()
                .map(|conflict| DesktopSyncConflictStatus {
                    meeting_id: conflict.meeting_id.to_string(),
                    key: conflict.key(),
                    reason: conflict.reason,
                    remote_updated_at: conflict.remote_updated_at.map(|at| at.to_rfc3339()),
                })
                .collect(),
            separate_copies: state.separate_copies.len(),
        }
    }

    pub fn conflict_webapp_target(
        &self,
        conflict_key: &str,
    ) -> Option<(Uuid, String, SyncConflictReason)> {
        self.lock_state()
            .conflicts
            .iter()
            .find(|conflict| conflict.key() == conflict_key)
            .map(|conflict| {
                (
                    conflict.meeting_id,
                    conflict.webapp_url.clone(),
                    conflict.reason,
                )
            })
    }

    pub fn resolve_conflict(&self, conflict_key: &str, keep_desktop: bool) -> Result<(), String> {
        let mut state = self.lock_state();
        let index = state
            .conflicts
            .iter()
            .position(|conflict| conflict.key() == conflict_key)
            .ok_or_else(|| "This sync conflict is no longer available.".to_string())?;
        let conflict = state.conflicts[index].clone();
        let source_id = format!(
            "{}/workspace/{}",
            conflict.webapp_url, conflict.workspace_id
        );
        let version_key = remote_version_key(conflict.meeting_id, &source_id);

        if keep_desktop {
            if conflict.reason == SyncConflictReason::Trashed {
                return Err(
                    "Restore this note in the web app before replacing its version.".into(),
                );
            }
            if conflict.reason == SyncConflictReason::Updated
                && conflict.remote_updated_at.is_none()
            {
                return Err(
                    "Sync again to retrieve the current web version before replacing it.".into(),
                );
            }
            if let Some(updated_at) = conflict.remote_updated_at {
                state.scoped_remote_versions.insert(version_key, updated_at);
            } else {
                // A removed remote note has no version. Sending `new` lets the
                // server recreate it, still under its normal workspace checks.
                state.scoped_remote_versions.remove(&version_key);
            }
            if !state.pending.contains(&conflict.meeting_id) {
                state.pending.push(conflict.meeting_id);
            }
            state.separate_copies.remove(conflict_key);
        } else {
            if let Some(updated_at) = conflict.remote_updated_at {
                state.scoped_remote_versions.insert(version_key, updated_at);
            }
            state.separate_copies.insert(conflict_key.to_owned());
        }

        state.conflicts.remove(index);
        state.last_error = None;
        self.persist(&state)
    }

    fn should_skip_upload(&self, meeting_id: Uuid, webapp_url: &str, workspace_id: &str) -> bool {
        let state = self.lock_state();
        state.conflicts.iter().any(|conflict| {
            conflict.meeting_id == meeting_id
                && conflict.webapp_url == webapp_url
                && conflict.workspace_id == workspace_id
        }) || state.separate_copies.contains(&sync_conflict_key(
            meeting_id,
            webapp_url,
            workspace_id,
        ))
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

    /// Remembers that the user deleted this note here, so workspace sync never re-creates it.
    pub fn dismiss(&self, meeting_id: Uuid) -> Result<(), String> {
        let mut state = self.lock_state();
        state.dismissed.insert(meeting_id);
        state.pending.retain(|id| *id != meeting_id);
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
        let identity_url = format!("{}/api/v1/desktop-sync", base_url.trim_end_matches('/'));
        let identity_response = client
            .get(identity_url)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|_| {
                "Could not reach the web app. The note stays on this device.".to_string()
            })?;
        if !identity_response.status().is_success() {
            let status = identity_response.status();
            let message = match status.as_u16() {
                401 => "The web-app token is invalid, expired, or revoked. Create a new desktop sync token and save it again.",
                402 => "Cloud sync needs an active plan. Your notes stay safe on this device and upload when a plan is active.",
                403 => "The desktop sync token no longer has access to its workspace.",
                404 => "This web-app version does not support desktop note sync yet.",
                429 => "The web app is receiving too many requests. Sync will retry later.",
                _ => "The web app could not confirm the selected workspace.",
            };
            return Err(format!("{message} (HTTP {status})"));
        }
        let workspace_id = identity_response
            .json::<WorkspaceIdentityResponse>()
            .await
            .map_err(|_| "The web app returned an unsupported workspace identity.".to_string())?
            .workspace
            .id;
        if workspace_id.trim().is_empty() || workspace_id.len() > 128 {
            return Err("The web app returned an invalid workspace identity.".into());
        }
        let source_base = reqwest::Url::parse(base_url)
            .map_err(|_| "Web-app URL is invalid.".to_string())?
            .to_string()
            .trim_end_matches('/')
            .to_owned();
        let source_id = format!("{source_base}/workspace/{workspace_id}");
        for meeting_id in pending {
            if self.should_skip_upload(meeting_id, &source_base, &workspace_id) {
                continue;
            }
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

            let expected_version = {
                self.lock_state()
                    .scoped_remote_versions
                    .get(&remote_version_key(meeting_id, &source_id))
                    .map(DateTime::to_rfc3339)
                    .unwrap_or_else(|| "new".to_string())
            };
            let response = client
                .post(&endpoint)
                .bearer_auth(token)
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .header("x-desktop-sync-version", expected_version)
                .body(body)
                .send()
                .await;
            match response {
                Ok(response) if response.status().is_success() => {
                    let receipt: UploadReceipt = match response.json().await {
                        Ok(receipt) => receipt,
                        Err(_) => {
                            let error = "The web app saved the note without returning its sync version. Retry sync to confirm it safely.".to_string();
                            self.record_error(error.clone());
                            return Err(error);
                        }
                    };
                    if receipt.workspace_id != workspace_id {
                        let error = "The web app changed workspaces during sync. The local note is safe; retry sync to confirm its destination.".to_string();
                        self.record_error(error.clone());
                        return Err(error);
                    }
                    self.record_success(meeting_id, receipt.updated_at, base_url, &workspace_id)?
                }
                Ok(response) => {
                    let status = response.status();
                    if status == reqwest::StatusCode::CONFLICT {
                        let conflict = response
                            .json::<serde_json::Value>()
                            .await
                            .unwrap_or_default();
                        let conflict_workspace_id = conflict
                            .get("workspaceId")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or(&workspace_id)
                            .to_owned();
                        let conflict_details = conflict.get("conflict");
                        let reason = match conflict_details
                            .and_then(|details| details.get("reason"))
                            .and_then(serde_json::Value::as_str)
                        {
                            Some("removed") => SyncConflictReason::Removed,
                            Some("trashed") => SyncConflictReason::Trashed,
                            _ => SyncConflictReason::Updated,
                        };
                        let remote_updated_at = conflict_details
                            .and_then(|details| details.get("remoteUpdatedAt"))
                            .and_then(serde_json::Value::as_str)
                            .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
                            .map(|value| value.with_timezone(&Utc));
                        self.record_conflict(
                            meeting_id,
                            base_url,
                            &conflict_workspace_id,
                            reason,
                            remote_updated_at,
                        )?;
                    }
                    let message = match status.as_u16() {
                        409 => "A web-app note conflicts with this desktop copy. Review the conflict in Settings → Web app sync.",
                        400 | 413 | 422 => "The web app rejected a saved note. Update the web app, then retry sync.",
                        401 => "The web-app token is invalid, expired, or revoked. Create a new desktop sync token and save it again.",
                        402 => "Cloud sync needs an active plan. Your notes stay safe on this device and upload when a plan is active.",
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
        let source_base = reqwest::Url::parse(base_url)
            .map_err(|_| "Web-app URL is invalid.".to_string())?
            .to_string()
            .trim_end_matches('/')
            .to_owned();
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
                    402 => "Cloud sync needs an active plan. Your notes stay safe on this device and upload when a plan is active.",
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
            if page.workspace_id.trim().is_empty() || page.workspace_id.len() > 128 {
                return Err("The web app returned an invalid workspace identity.".into());
            }
            let source_id = format!("{source_base}/workspace/{}", page.workspace_id);
            let page_workspace_id = page.workspace_id.clone();
            let next_cursor = page.next_cursor;
            let has_more = page.has_more;
            if has_more && next_cursor.is_none() {
                return Err(
                    "The web app returned an incomplete sync cursor. Retry sync later.".into(),
                );
            }
            let store_for_import = store.clone();
            let page_source_id = source_id.clone();
            let (known_versions, dismissed) = {
                let state = self.lock_state();
                (
                    state.scoped_remote_versions.clone(),
                    state.dismissed.clone(),
                )
            };
            let page_import = tokio::task::spawn_blocking(move || -> Result<WorkspacePageImport, String> {
                let mut count = 0;
                let mut versions = Vec::new();
                let mut conflicts = Vec::new();
                for meeting in page.meetings {
                    validate_remote_meeting(&meeting)?;
                    if dismissed.contains(&meeting.id) {
                        continue;
                    }
                    let remote_updated_at = meeting.updated_at;
                    let source_updated_at = meeting.updated_at;
                    let action_items = meeting.action_items;
                    let summary = (!meeting.summary.trim().is_empty() || !action_items.is_empty()).then_some(Summary {
                        summary: meeting.summary,
                        action_items,
                    });
                    let note = ImportedMeetingNote {
                        id: meeting.id,
                        workspace_import: true,
                        workspace_source_updated_at: Some(source_updated_at),
                        workspace_source_id: Some(page_source_id.clone()),
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
                    let meeting_id = note.id;
                    let outcome = store_for_import.refresh_workspace_import(note)
                        .map_err(|_| "A workspace note could not be saved locally. Retry sync; existing notes are safe.".to_string())?;
                    if matches!(outcome, WorkspaceImportOutcome::Created | WorkspaceImportOutcome::Updated) {
                        count += 1;
                    } else if outcome == WorkspaceImportOutcome::PreservedLocalNote
                        && known_versions
                            .get(&remote_version_key(meeting_id, &page_source_id))
                            .is_none_or(|known| remote_updated_at > *known)
                    {
                        conflicts.push((meeting_id, remote_updated_at));
                    }
                    if matches!(outcome, WorkspaceImportOutcome::Created | WorkspaceImportOutcome::Updated | WorkspaceImportOutcome::Unchanged) {
                        versions.push((meeting_id, remote_updated_at));
                    }
                }
                Ok(WorkspacePageImport {
                    imported: count,
                    versions,
                    conflicts,
                })
            }).await.map_err(|_| "Workspace notes could not be imported.".to_string())??;
            imported += page_import.imported;
            if !page_import.versions.is_empty() {
                let mut state = self.lock_state();
                for (meeting_id, updated_at) in page_import.versions {
                    state
                        .scoped_remote_versions
                        .insert(remote_version_key(meeting_id, &source_id), updated_at);
                }
                self.persist(&state)?;
            }
            for (meeting_id, remote_updated_at) in page_import.conflicts {
                self.record_conflict(
                    meeting_id,
                    base_url,
                    &page_workspace_id,
                    SyncConflictReason::Updated,
                    Some(remote_updated_at),
                )?;
            }
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

    fn record_success(
        &self,
        meeting_id: Uuid,
        updated_at: DateTime<Utc>,
        webapp_url: &str,
        workspace_id: &str,
    ) -> Result<(), String> {
        let normalized_url = reqwest::Url::parse(webapp_url)
            .map_err(|_| "Web-app URL is invalid.".to_string())?
            .to_string()
            .trim_end_matches('/')
            .to_owned();
        let source_id = format!("{normalized_url}/workspace/{workspace_id}");
        let mut state = self.lock_state();
        state.pending.retain(|id| *id != meeting_id);
        state.remote_versions.insert(meeting_id, updated_at);
        state
            .scoped_remote_versions
            .insert(remote_version_key(meeting_id, &source_id), updated_at);
        state.conflicts.retain(|conflict| {
            conflict.meeting_id != meeting_id
                || conflict.webapp_url != normalized_url
                || conflict.workspace_id != workspace_id
        });
        state.last_error = None;
        state.last_success_at = Some(Utc::now());
        self.persist(&state)
    }

    fn record_conflict(
        &self,
        meeting_id: Uuid,
        webapp_url: &str,
        workspace_id: &str,
        reason: SyncConflictReason,
        remote_updated_at: Option<DateTime<Utc>>,
    ) -> Result<(), String> {
        let normalized_url = reqwest::Url::parse(webapp_url)
            .map_err(|_| "Web-app URL is invalid.".to_string())?
            .to_string()
            .trim_end_matches('/')
            .to_owned();
        let mut state = self.lock_state();
        state.conflicts.retain(|conflict| {
            conflict.meeting_id != meeting_id
                || conflict.webapp_url != normalized_url
                || conflict.workspace_id != workspace_id
        });
        if state.conflicts.len() >= MAX_SYNC_CONFLICTS {
            return Err(
                "There are too many unresolved sync conflicts. Review and clear some before syncing more notes.".into(),
            );
        }
        state.conflicts.push(SyncConflict {
            meeting_id,
            webapp_url: normalized_url.clone(),
            workspace_id: workspace_id.to_owned(),
            reason,
            remote_updated_at,
        });
        state.separate_copies.remove(&sync_conflict_key(
            meeting_id,
            &normalized_url,
            workspace_id,
        ));
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
    fn older_conflict_records_load_with_safe_defaults() {
        let directory = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4();
        std::fs::write(
            directory.path().join(OUTBOX_FILE),
            serde_json::json!({
                "pending": [],
                "conflicts": [{
                    "meetingId": id,
                    "webappUrl": "https://notes.example.test",
                    "workspaceId": "workspace-a"
                }]
            })
            .to_string(),
        )
        .unwrap();

        let sync = DesktopSync::load(directory.path());

        assert_eq!(
            sync.status(true).conflicts[0].reason,
            SyncConflictReason::Updated
        );
        assert_eq!(sync.status(true).conflicts[0].remote_updated_at, None);
    }

    #[test]
    fn remote_upload_versions_survive_restart() {
        let directory = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4();
        let version = Utc::now();
        let queue = DesktopSync::load(directory.path());
        {
            let mut state = queue.lock_state();
            state.remote_versions.insert(id, version);
            queue.persist(&state).unwrap();
        }

        let reopened = DesktopSync::load(directory.path());
        assert_eq!(
            reopened.lock_state().remote_versions.get(&id),
            Some(&version)
        );
    }

    #[test]
    fn sync_conflicts_survive_restart_and_clear_after_an_upload_succeeds() {
        let directory = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4();
        let sync = DesktopSync::load(directory.path());
        sync.record_conflict(
            id,
            "https://notes.example.test",
            "workspace-a",
            SyncConflictReason::Updated,
            Some(Utc::now()),
        )
        .unwrap();
        sync.record_conflict(
            id,
            "https://notes.example.test",
            "workspace-b",
            SyncConflictReason::Updated,
            Some(Utc::now()),
        )
        .unwrap();
        let workspace_a_key = sync.status(true).conflicts[0].key.clone();
        let workspace_b_key = sync.status(true).conflicts[1].key.clone();
        assert_ne!(workspace_a_key, workspace_b_key);
        assert!(sync.should_skip_upload(id, "https://notes.example.test", "workspace-a"));
        assert!(sync.should_skip_upload(id, "https://notes.example.test", "workspace-b"));

        let reopened = DesktopSync::load(directory.path());
        assert_eq!(
            reopened.conflict_webapp_target(&workspace_a_key),
            Some((
                id,
                "https://notes.example.test".to_string(),
                SyncConflictReason::Updated,
            ))
        );
        assert_eq!(
            reopened.conflict_webapp_target(&workspace_b_key),
            Some((
                id,
                "https://notes.example.test".to_string(),
                SyncConflictReason::Updated,
            ))
        );
        assert_eq!(reopened.status(true).conflicts.len(), 2);

        reopened
            .record_success(id, Utc::now(), "https://notes.example.test", "workspace-b")
            .unwrap();
        let remaining = reopened.status(true).conflicts;
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].key, workspace_a_key);
    }

    #[test]
    fn choosing_desktop_version_retries_against_the_conflicted_web_version() {
        let directory = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4();
        let version = Utc::now();
        let sync = DesktopSync::load(directory.path());
        sync.record_conflict(
            id,
            "https://notes.example.test",
            "workspace-a",
            SyncConflictReason::Updated,
            Some(version),
        )
        .unwrap();
        let key = sync.status(true).conflicts[0].key.clone();

        sync.resolve_conflict(&key, true).unwrap();

        let state = sync.lock_state();
        let source_id = "https://notes.example.test/workspace/workspace-a";
        assert_eq!(state.pending, vec![id]);
        assert_eq!(state.conflicts.len(), 0);
        assert_eq!(
            state
                .scoped_remote_versions
                .get(&remote_version_key(id, source_id)),
            Some(&version)
        );
        assert!(state.separate_copies.is_empty());
    }

    #[test]
    fn observing_a_conflict_never_advances_the_upload_version_before_a_choice() {
        let directory = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4();
        let old_version = Utc::now() - chrono::Duration::minutes(1);
        let new_version = Utc::now();
        let sync = DesktopSync::load(directory.path());
        sync.enqueue(id).unwrap();
        let source_id = "https://notes.example.test/workspace/workspace-a";
        sync.lock_state()
            .scoped_remote_versions
            .insert(remote_version_key(id, source_id), old_version);

        sync.record_conflict(
            id,
            "https://notes.example.test",
            "workspace-a",
            SyncConflictReason::Updated,
            Some(new_version),
        )
        .unwrap();

        assert!(sync.should_skip_upload(id, "https://notes.example.test", "workspace-a"));
        assert_eq!(
            sync.lock_state()
                .scoped_remote_versions
                .get(&remote_version_key(id, source_id)),
            Some(&old_version)
        );
    }

    #[test]
    fn keeping_both_copies_suppresses_only_that_workspace_upload() {
        let directory = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4();
        let version = Utc::now();
        let sync = DesktopSync::load(directory.path());
        sync.enqueue(id).unwrap();
        sync.record_conflict(
            id,
            "https://notes.example.test",
            "workspace-a",
            SyncConflictReason::Updated,
            Some(version),
        )
        .unwrap();
        let key = sync.status(true).conflicts[0].key.clone();

        sync.resolve_conflict(&key, false).unwrap();

        assert!(sync.should_skip_upload(id, "https://notes.example.test", "workspace-a"));
        assert!(!sync.should_skip_upload(id, "https://notes.example.test", "workspace-b"));
        let state = sync.lock_state();
        let source_id = "https://notes.example.test/workspace/workspace-a";
        assert_eq!(state.pending, vec![id]);
        assert_eq!(state.conflicts.len(), 0);
        assert_eq!(state.separate_copies.len(), 1);
        assert_eq!(
            state
                .scoped_remote_versions
                .get(&remote_version_key(id, source_id)),
            Some(&version)
        );
        drop(state);
        let reopened = DesktopSync::load(directory.path());
        assert!(reopened.should_skip_upload(id, "https://notes.example.test", "workspace-a"));
    }

    #[test]
    fn removed_remote_note_can_be_explicitly_recreated() {
        let directory = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4();
        let sync = DesktopSync::load(directory.path());
        sync.record_conflict(
            id,
            "https://notes.example.test",
            "workspace-a",
            SyncConflictReason::Removed,
            None,
        )
        .unwrap();
        let key = sync.status(true).conflicts[0].key.clone();

        sync.resolve_conflict(&key, true).unwrap();

        let state = sync.lock_state();
        let source_id = "https://notes.example.test/workspace/workspace-a";
        assert_eq!(state.pending, vec![id]);
        assert!(!state
            .scoped_remote_versions
            .contains_key(&remote_version_key(id, source_id)));
    }

    #[test]
    fn trashed_remote_note_cannot_be_replaced_until_restored() {
        let directory = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4();
        let sync = DesktopSync::load(directory.path());
        sync.record_conflict(
            id,
            "https://notes.example.test",
            "workspace-a",
            SyncConflictReason::Trashed,
            Some(Utc::now()),
        )
        .unwrap();
        let key = sync.status(true).conflicts[0].key.clone();

        let error = sync.resolve_conflict(&key, true).unwrap_err();

        assert!(error.contains("Restore this note"));
        assert_eq!(sync.status(true).conflicts.len(), 1);
    }

    #[tokio::test]
    async fn upload_sends_first_write_version_and_saves_server_receipt() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        let directory = tempfile::tempdir().unwrap();
        let store = Arc::new(MeetingStore::new(directory.path()).unwrap());
        let id = Uuid::new_v4();
        let started = Utc::now();
        store.create_meeting(id, started).unwrap();
        store
            .mark_stopped(id, started + chrono::Duration::minutes(10))
            .unwrap();
        store
            .write_summary(
                id,
                &Summary {
                    summary: "Ready".into(),
                    action_items: vec![],
                },
            )
            .unwrap();
        store.mark_processed(id).unwrap();
        let sync = DesktopSync::load(directory.path());
        sync.enqueue(id).unwrap();

        let updated_at = Utc::now();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            async fn read_headers(
                stream: tokio::net::TcpStream,
            ) -> (String, tokio::net::TcpStream) {
                let mut reader = BufReader::new(stream);
                let mut headers = String::new();
                loop {
                    let mut line = String::new();
                    let count = reader.read_line(&mut line).await.unwrap();
                    if count == 0 || line == "\r\n" {
                        break;
                    }
                    headers.push_str(&line);
                }
                (headers, reader.into_inner())
            }

            let (stream, _) = listener.accept().await.unwrap();
            let (headers, mut stream) = read_headers(stream).await;
            assert!(headers.starts_with("GET /api/v1/desktop-sync "));
            let body = r#"{"workspace":{"id":"workspace-1","name":"Product"}}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(), body
            );
            stream.write_all(response.as_bytes()).await.unwrap();

            let (stream, _) = listener.accept().await.unwrap();
            let (headers, mut stream) = read_headers(stream).await;
            assert!(headers
                .to_ascii_lowercase()
                .contains("x-desktop-sync-version: new"));
            let body = serde_json::json!({ "updatedAt": updated_at, "workspaceId": "workspace-1" })
                .to_string();
            let response = format!(
                "HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(), body
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });

        sync.sync_pending(store, &format!("http://{address}"), "sync-token")
            .await
            .unwrap();
        server.await.unwrap();
        let state = sync.lock_state();
        assert_eq!(state.remote_versions.get(&id), Some(&updated_at));
        let source_id = format!("http://{address}/workspace/workspace-1");
        assert_eq!(
            state
                .scoped_remote_versions
                .get(&remote_version_key(id, &source_id)),
            Some(&updated_at)
        );
        assert!(!state.pending.contains(&id));
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
            "workspaceId": "workspace-1",
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
        let imported_meta = store.load_meta(id).unwrap();
        assert!(imported_meta.workspace_import);
        assert_eq!(imported_meta.workspace_source_updated_at, Some(updated_at));
        assert_eq!(
            imported_meta.workspace_source_id.as_deref(),
            Some(format!("http://{address}/workspace/workspace-1").as_str())
        );

        let newer_at = updated_at + chrono::Duration::seconds(1);
        let updated_page = serde_json::json!({
            "workspaceId": "workspace-1",
            "meetings": [{
                "id": id,
                "title": "Workspace planning updated",
                "mode": "general",
                "startedAt": "2026-10-04T10:00:00Z",
                "endedAt": "2026-10-04T10:30:00Z",
                "summary": "Updated online.",
                "updatedAt": newer_at,
                "transcript": [{"speaker": "you", "text": "Edited online.", "timestamp": null}],
                "actionItems": []
            }],
            "hasMore": false,
            "nextCursor": {"updatedAt": newer_at, "id": id.to_string()},
            "serverCursorVersion": 2
        })
        .to_string();
        let update_listener = tokio::net::TcpListener::bind(address).await.unwrap();
        let update_address = update_listener.local_addr().unwrap();
        let expected_update = updated_page.clone();
        let update_server = tokio::spawn(async move {
            let (stream, _) = update_listener.accept().await.unwrap();
            let mut stream = BufReader::new(stream);
            let mut line = String::new();
            while stream.read_line(&mut line).await.unwrap() > 0 && line != "\r\n" {
                line.clear();
            }
            let mut stream = stream.into_inner();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                expected_update.len(), expected_update
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });

        assert_eq!(
            sync.pull_workspace_notes(
                store.clone(),
                &format!("http://{update_address}"),
                "sync-token"
            )
            .await
            .unwrap(),
            1
        );
        update_server.await.unwrap();
        let updated_meta = store.load_meta(id).unwrap();
        assert_eq!(
            updated_meta.title.as_deref(),
            Some("Workspace planning updated")
        );
        assert_eq!(updated_meta.workspace_source_updated_at, Some(newer_at));
        assert_eq!(
            store.load_summary(id).unwrap().unwrap().summary,
            "Updated online."
        );
        assert_eq!(store.load_transcript(id).unwrap()[0].text, "Edited online.");
        let source_id = format!("http://{update_address}/workspace/workspace-1");
        assert_eq!(
            sync.lock_state()
                .scoped_remote_versions
                .get(&remote_version_key(id, &source_id)),
            Some(&newer_at)
        );
        let reopened = DesktopSync::load(directory.path());
        assert_eq!(
            reopened.lock_state().remote_cursor.as_ref().unwrap().id,
            id.to_string()
        );
        assert_eq!(
            reopened
                .lock_state()
                .scoped_remote_versions
                .get(&remote_version_key(id, &source_id)),
            Some(&newer_at)
        );
    }

    #[tokio::test]
    async fn a_workspace_without_a_plan_keeps_the_note_queued_and_says_why() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        let directory = tempfile::tempdir().unwrap();
        let store = Arc::new(MeetingStore::new(directory.path()).unwrap());
        let id = Uuid::new_v4();
        let started = Utc::now();
        store.create_meeting(id, started).unwrap();
        store
            .mark_stopped(id, started + chrono::Duration::minutes(5))
            .unwrap();
        store
            .write_summary(
                id,
                &Summary {
                    summary: "Ready".into(),
                    action_items: vec![],
                },
            )
            .unwrap();
        store.mark_processed(id).unwrap();
        let sync = DesktopSync::load(directory.path());
        sync.enqueue(id).unwrap();

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut reader = BufReader::new(stream);
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).await.unwrap() == 0 || line == "\r\n" {
                    break;
                }
            }
            let body = r#"{"error":"Cloud sync needs an active AI Notetaker subscription."}"#;
            let response = format!(
                "HTTP/1.1 402 Payment Required\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            reader
                .into_inner()
                .write_all(response.as_bytes())
                .await
                .unwrap();
        });

        let error = sync
            .sync_pending(store, &format!("http://{address}"), "sync-token")
            .await
            .unwrap_err();
        server.await.unwrap();

        assert!(error.contains("Cloud sync needs an active plan"), "{error}");
        assert!(error.contains("HTTP 402"), "{error}");
        // Nothing is lost: the note stays queued for when a plan is added.
        assert_eq!(sync.status(true).pending, 1);
    }

    #[tokio::test]
    async fn a_note_deleted_on_this_device_is_not_brought_back_by_sync() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        let directory = tempfile::tempdir().unwrap();
        let store = Arc::new(MeetingStore::new(directory.path()).unwrap());
        let sync = DesktopSync::load(directory.path());
        let deleted = Uuid::new_v4();
        let kept = Uuid::new_v4();
        let updated_at = Utc::now();
        let note = |id: Uuid, title: &str| {
            serde_json::json!({
                "id": id, "title": title, "mode": "general",
                "startedAt": "2026-10-04T10:00:00Z", "endedAt": "2026-10-04T10:30:00Z",
                "summary": "Text", "updatedAt": updated_at,
                "transcript": [{"speaker": "you", "text": "Hi", "timestamp": null}],
                "actionItems": []
            })
        };
        let page = serde_json::json!({
            "workspaceId": "workspace-1",
            "meetings": [note(deleted, "Deleted here"), note(kept, "Kept")],
            "hasMore": false,
            "nextCursor": {"updatedAt": updated_at, "id": kept.to_string()},
        })
        .to_string();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut stream = BufReader::new(stream);
            loop {
                let mut line = String::new();
                if stream.read_line(&mut line).await.unwrap() == 0 || line == "\r\n" {
                    break;
                }
            }
            let mut stream = stream.into_inner();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                page.len(),
                page
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });

        sync.dismiss(deleted).unwrap();
        // The choice survives a restart.
        let sync = DesktopSync::load(directory.path());
        let imported = sync
            .pull_workspace_notes(store.clone(), &format!("http://{address}"), "token")
            .await
            .unwrap();
        server.await.unwrap();
        assert_eq!(imported, 1);
        assert!(store.load_meta(deleted).is_err());
        assert!(store.load_meta(kept).is_ok());
    }
}
