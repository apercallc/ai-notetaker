//! Local on-disk layout for meetings. This is the resilience backbone: raw
//! audio is appended here incrementally *before* any provider call, so a
//! network failure, a bad key, or an unclean shutdown never loses audio —
//! only ever loses the not-yet-done processing of it, which can always be
//! redone from what's on disk.
//!
//! Layout, rooted at a data directory the caller supplies (in production,
//! the OS-appropriate app-data directory; in tests, a tempdir):
//!
//! ```text
//! <root>/meetings/<meeting-id>/
//!   meta.json        - MeetingMeta (state, timestamps)
//!   mic.pcm           - raw PCM16 mono, appended during capture
//!   speaker.pcm       - raw PCM16 mono, appended during capture
//!   transcript.json   - Vec<TranscriptSegment>, appended as segments arrive
//!   summary.json      - Summary, written once after finalize
//! ```

use crate::native_messaging::MeetingMode;
use crate::providers::{FlaggedMoment, Summary, SummaryOptions, TranscriptSegment};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeetingState {
    Recording,
    Stopped,
    Processed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingMeta {
    pub id: Uuid,
    #[serde(default)]
    pub title: Option<String>,
    pub started_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
    pub state: MeetingState,
    #[serde(default)]
    pub summary_options: SummaryOptions,
    #[serde(default)]
    pub transcribed_mic_bytes: usize,
    #[serde(default)]
    pub transcribed_speaker_bytes: usize,
    #[serde(default = "default_sample_rate")]
    pub mic_sample_rate_hz: u32,
    #[serde(default = "default_sample_rate")]
    pub speaker_sample_rate_hz: u32,
    #[serde(default)]
    pub summary_pending: bool,
    /// Managed-mode capture has stopped and still needs to be uploaded or
    /// watched. These fields are deliberately independent of `state`: the
    /// local meeting remains `Stopped` while hosted processing continues.
    #[serde(default)]
    pub managed_pending: bool,
    #[serde(default)]
    pub managed_job_id: Option<String>,
    #[serde(default)]
    pub managed_upload_id: Option<String>,
    #[serde(default)]
    pub managed_next_chunk: usize,
    /// Tenant identity that authorized the managed upload. Pending recordings
    /// must never be replayed into a different hosted workspace after the
    /// user switches accounts or workspaces.
    #[serde(default)]
    pub managed_account_id: Option<String>,
    #[serde(default)]
    pub managed_workspace_id: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("meeting {0} not found")]
    NotFound(Uuid),
}

#[derive(Debug, Clone)]
pub struct MeetingStore {
    root: PathBuf,
}

impl MeetingStore {
    pub fn new(root: impl Into<PathBuf>) -> Result<Self, StorageError> {
        let root = root.into();
        fs::create_dir_all(root.join("meetings"))?;
        Ok(Self { root })
    }

    fn meeting_dir(&self, id: Uuid) -> PathBuf {
        self.root.join("meetings").join(id.to_string())
    }

    pub fn create_meeting(&self, id: Uuid, started_at: DateTime<Utc>) -> Result<(), StorageError> {
        let dir = self.meeting_dir(id);
        fs::create_dir_all(&dir)?;
        let meta = MeetingMeta {
            id,
            title: None,
            started_at,
            ended_at: None,
            state: MeetingState::Recording,
            summary_options: SummaryOptions::default(),
            transcribed_mic_bytes: 0,
            transcribed_speaker_bytes: 0,
            mic_sample_rate_hz: default_sample_rate(),
            speaker_sample_rate_hz: default_sample_rate(),
            summary_pending: false,
            managed_pending: false,
            managed_job_id: None,
            managed_upload_id: None,
            managed_next_chunk: 0,
            managed_account_id: None,
            managed_workspace_id: None,
        };
        self.write_meta(&meta)?;
        Ok(())
    }

    pub fn create_meeting_with_options(
        &self,
        id: Uuid,
        started_at: DateTime<Utc>,
        mode: MeetingMode,
        mut summary_options: SummaryOptions,
    ) -> Result<(), StorageError> {
        summary_options.mode = mode;
        let dir = self.meeting_dir(id);
        fs::create_dir_all(&dir)?;
        let meta = MeetingMeta {
            id,
            title: None,
            started_at,
            ended_at: None,
            state: MeetingState::Recording,
            summary_options,
            transcribed_mic_bytes: 0,
            transcribed_speaker_bytes: 0,
            mic_sample_rate_hz: default_sample_rate(),
            speaker_sample_rate_hz: default_sample_rate(),
            summary_pending: false,
            managed_pending: false,
            managed_job_id: None,
            managed_upload_id: None,
            managed_next_chunk: 0,
            managed_account_id: None,
            managed_workspace_id: None,
        };
        self.write_meta(&meta)
    }

    fn write_meta(&self, meta: &MeetingMeta) -> Result<(), StorageError> {
        let path = self.meeting_dir(meta.id).join("meta.json");
        atomic_write(&path, &serde_json::to_vec_pretty(meta)?)?;
        Ok(())
    }

    pub fn load_meta(&self, id: Uuid) -> Result<MeetingMeta, StorageError> {
        let path = self.meeting_dir(id).join("meta.json");
        if !path.exists() {
            return Err(StorageError::NotFound(id));
        }
        let bytes = fs::read(path)?;
        Ok(serde_json::from_slice(&bytes)?)
    }

    pub fn set_title(&self, id: Uuid, title: &str) -> Result<(), StorageError> {
        let mut meta = self.load_meta(id)?;
        let title = title.trim();
        if !title.is_empty() {
            meta.title = Some(title.chars().take(200).collect());
            self.write_meta(&meta)?;
        }
        Ok(())
    }

    /// Appends raw PCM16 bytes to the given channel's file for this
    /// meeting. Called continuously during capture, always before those
    /// same bytes are handed to a transcription provider.
    pub fn append_audio(
        &self,
        id: Uuid,
        channel_file: &str,
        pcm16: &[u8],
    ) -> Result<(), StorageError> {
        let path = self.meeting_dir(id).join(channel_file);
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?;
        file.write_all(pcm16)?;
        // The next pipeline step may send these exact bytes to a provider;
        // make the write durable before that call so a process crash cannot
        // leave the retry cursor pointing at audio that never reached disk.
        file.sync_data()?;
        Ok(())
    }

    pub fn mark_stopped(&self, id: Uuid, ended_at: DateTime<Utc>) -> Result<(), StorageError> {
        let mut meta = self.load_meta(id)?;
        meta.ended_at = Some(ended_at);
        meta.state = MeetingState::Stopped;
        self.write_meta(&meta)
    }

    /// Records what the user flagged so a summary retried after a restart
    /// still knows. Bounded, because the input is user-controlled and ends up
    /// in a prompt.
    ///
    /// A position the caller measured (the extension knows when the user
    /// really pressed stop) wins; otherwise it is derived from `now`.
    pub fn mark_flagged_moments(
        &self,
        id: Uuid,
        moments: &[FlaggedMoment],
        now: DateTime<Utc>,
    ) -> Result<(), StorageError> {
        const MAX_MOMENTS: usize = 200;
        const MAX_NOTE_CHARS: usize = 280;
        let mut meta = self.load_meta(id)?;
        let call_length_ms = (now - meta.started_at).num_milliseconds().max(0) as u64;
        meta.summary_options.flagged_moments = moments
            .iter()
            .take(MAX_MOMENTS)
            .map(|moment| FlaggedMoment {
                offset_ms: moment.offset_ms,
                note: moment.note.trim().chars().take(MAX_NOTE_CHARS).collect(),
                position_percent: moment.position_percent.map(|p| p.min(100)).or_else(|| {
                    (call_length_ms > 0).then(|| {
                        ((moment.offset_ms.saturating_mul(100)) / call_length_ms).min(100) as u8
                    })
                }),
            })
            .collect();
        self.write_meta(&meta)
    }

    pub fn mark_processed(&self, id: Uuid) -> Result<(), StorageError> {
        let mut meta = self.load_meta(id)?;
        meta.state = MeetingState::Processed;
        meta.summary_pending = false;
        self.write_meta(&meta)
    }

    pub fn mark_summary_pending(&self, id: Uuid) -> Result<(), StorageError> {
        let mut meta = self.load_meta(id)?;
        meta.summary_pending = true;
        self.write_meta(&meta)
    }

    /// Marks a managed capture as requiring hosted upload/processing. This is
    /// written before capture begins so an unexpected shutdown cannot make a
    /// managed meeting indistinguishable from a completed local one.
    pub fn mark_managed_pending(&self, id: Uuid) -> Result<(), StorageError> {
        let mut meta = self.load_meta(id)?;
        meta.managed_pending = true;
        self.write_meta(&meta)
    }

    pub fn mark_managed_pending_for_identity(
        &self,
        id: Uuid,
        account_id: &str,
        workspace_id: &str,
    ) -> Result<(), StorageError> {
        let mut meta = self.load_meta(id)?;
        meta.managed_pending = true;
        meta.managed_account_id = Some(account_id.to_owned());
        meta.managed_workspace_id = Some(workspace_id.to_owned());
        self.write_meta(&meta)
    }

    pub fn set_managed_job_id(&self, id: Uuid, job_id: &str) -> Result<(), StorageError> {
        let mut meta = self.load_meta(id)?;
        meta.managed_pending = true;
        meta.managed_job_id = Some(job_id.to_string());
        self.write_meta(&meta)
    }

    /// Retain the durable managed upload after a terminal hosted-job failure,
    /// but forget the failed job cursor so the next authenticated settings
    /// refresh can enqueue the same idempotent work again.
    pub fn clear_managed_job_id(&self, id: Uuid) -> Result<(), StorageError> {
        let mut meta = self.load_meta(id)?;
        meta.managed_pending = true;
        meta.managed_job_id = None;
        self.write_meta(&meta)
    }

    pub fn set_managed_upload_progress(
        &self,
        id: Uuid,
        upload_id: &str,
        next_chunk: usize,
    ) -> Result<(), StorageError> {
        let mut meta = self.load_meta(id)?;
        meta.managed_pending = true;
        meta.managed_upload_id = Some(upload_id.to_string());
        meta.managed_next_chunk = next_chunk;
        self.write_meta(&meta)
    }

    pub fn mark_managed_complete(&self, id: Uuid) -> Result<(), StorageError> {
        let mut meta = self.load_meta(id)?;
        meta.managed_pending = false;
        self.write_meta(&meta)
    }

    pub fn mark_audio_transcribed(
        &self,
        id: Uuid,
        channel_file: &str,
        end: usize,
    ) -> Result<(), StorageError> {
        let mut meta = self.load_meta(id)?;
        match channel_file {
            MIC_FILE => meta.transcribed_mic_bytes = meta.transcribed_mic_bytes.max(end),
            SPEAKER_FILE => {
                meta.transcribed_speaker_bytes = meta.transcribed_speaker_bytes.max(end)
            }
            _ => {
                return Err(StorageError::Io(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "invalid audio channel",
                )))
            }
        }
        self.write_meta(&meta)
    }

    pub fn mark_audio_sample_rate(
        &self,
        id: Uuid,
        channel_file: &str,
        sample_rate_hz: u32,
    ) -> Result<(), StorageError> {
        let mut meta = self.load_meta(id)?;
        match channel_file {
            MIC_FILE => meta.mic_sample_rate_hz = sample_rate_hz,
            SPEAKER_FILE => meta.speaker_sample_rate_hz = sample_rate_hz,
            _ => {
                return Err(StorageError::Io(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "invalid audio channel",
                )))
            }
        }
        self.write_meta(&meta)
    }

    pub fn append_transcript_segment(
        &self,
        id: Uuid,
        segment: &TranscriptSegment,
    ) -> Result<(), StorageError> {
        self.append_transcript_segments(id, std::slice::from_ref(segment))
    }

    /// Appends a provider response in one read/write cycle. Provider results
    /// often contain several diarized segments; rewriting transcript.json for
    /// every segment made long meetings increasingly expensive on disk.
    pub fn append_transcript_segments(
        &self,
        id: Uuid,
        new_segments: &[TranscriptSegment],
    ) -> Result<(), StorageError> {
        if new_segments.is_empty() {
            return Ok(());
        }
        let mut segments = self.load_transcript(id).unwrap_or_default();
        segments.extend_from_slice(new_segments);
        let path = self.meeting_dir(id).join("transcript.json");
        atomic_write(&path, &serde_json::to_vec_pretty(&segments)?)?;
        Ok(())
    }

    pub fn load_transcript(&self, id: Uuid) -> Result<Vec<TranscriptSegment>, StorageError> {
        let path = self.meeting_dir(id).join("transcript.json");
        if !path.exists() {
            return Ok(vec![]);
        }
        let bytes = fs::read(path)?;
        Ok(serde_json::from_slice(&bytes)?)
    }

    pub fn write_summary(&self, id: Uuid, summary: &Summary) -> Result<(), StorageError> {
        let path = self.meeting_dir(id).join("summary.json");
        atomic_write(&path, &serde_json::to_vec_pretty(summary)?)?;
        Ok(())
    }

    pub fn load_summary(&self, id: Uuid) -> Result<Option<Summary>, StorageError> {
        let path = self.meeting_dir(id).join("summary.json");
        if !path.exists() {
            return Ok(None);
        }
        let bytes = fs::read(path)?;
        Ok(Some(serde_json::from_slice(&bytes)?))
    }

    /// Every meeting directory whose meta is still `Recording` — i.e. one
    /// that never saw a clean `stop_recording` before the process exited.
    /// This is the crash-recovery scan run on helper startup.
    pub fn find_interrupted_meetings(&self) -> Result<Vec<MeetingMeta>, StorageError> {
        self.find_interrupted_meetings_excluding(&std::collections::HashSet::new())
    }

    pub fn find_interrupted_meetings_excluding(
        &self,
        excluded: &std::collections::HashSet<Uuid>,
    ) -> Result<Vec<MeetingMeta>, StorageError> {
        let meetings_dir = self.root.join("meetings");
        if !meetings_dir.exists() {
            return Ok(vec![]);
        }
        let mut interrupted = Vec::new();
        for entry in fs::read_dir(&meetings_dir)? {
            let entry = entry?;
            if !entry.path().is_dir() {
                continue;
            }
            let meta_path = entry.path().join("meta.json");
            if !meta_path.exists() {
                continue;
            }
            let bytes = fs::read(&meta_path)?;
            let meta: MeetingMeta = serde_json::from_slice(&bytes)?;
            if meta.state == MeetingState::Recording && !excluded.contains(&meta.id) {
                interrupted.push(meta);
            }
        }
        interrupted.sort_by_key(|m| m.started_at);
        Ok(interrupted)
    }

    pub fn delete_meeting(&self, id: Uuid) -> Result<(), StorageError> {
        let dir = self.meeting_dir(id);
        if dir.exists() {
            fs::remove_dir_all(dir)?;
        }
        Ok(())
    }

    pub fn audio_path(&self, id: Uuid, channel_file: &str) -> PathBuf {
        self.meeting_dir(id).join(channel_file)
    }

    /// Returns the durable byte length for one of the two audio channels
    /// without loading its contents. A channel that was never captured is
    /// treated as empty, matching `read_audio_all`'s legacy behavior.
    pub fn audio_len(&self, id: Uuid, channel_file: &str) -> Result<usize, StorageError> {
        if !matches!(channel_file, MIC_FILE | SPEAKER_FILE) {
            return Err(StorageError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "invalid audio channel",
            )));
        }
        let path = self.audio_path(id, channel_file);
        let length = match fs::metadata(path) {
            Ok(metadata) => metadata.len(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(error) => return Err(StorageError::Io(error)),
        };
        usize::try_from(length).map_err(|_| {
            StorageError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "saved audio is too large for this platform",
            ))
        })
    }

    /// Read the exact byte range captured for a retry job. Only the two
    /// channel files can be addressed; retry metadata is persisted on disk,
    /// so accepting an arbitrary filename here would turn it into a path
    /// traversal primitive.
    pub fn read_audio_range(
        &self,
        id: Uuid,
        channel_file: &str,
        start: usize,
        end: usize,
    ) -> Result<Vec<u8>, StorageError> {
        if !matches!(channel_file, MIC_FILE | SPEAKER_FILE) || end < start {
            return Err(StorageError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "invalid audio retry range",
            )));
        }
        let length = end - start;
        let mut file = fs::File::open(self.audio_path(id, channel_file))?;
        if end as u64 > file.metadata()?.len() {
            return Err(StorageError::Io(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "saved audio is shorter than the retry range",
            )));
        }
        file.seek(SeekFrom::Start(start as u64))?;
        let mut bytes = vec![0u8; length];
        file.read_exact(&mut bytes)?;
        Ok(bytes)
    }

    /// Reads one complete durable channel for managed upload or export. The
    /// caller still controls chunking and checksums; this method only exposes
    /// bytes that were already persisted locally.
    pub fn read_audio_all(&self, id: Uuid, channel_file: &str) -> Result<Vec<u8>, StorageError> {
        let path = self.audio_path(id, channel_file);
        if !matches!(channel_file, MIC_FILE | SPEAKER_FILE) {
            return Err(StorageError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "invalid audio channel",
            )));
        }
        Ok(fs::read(path).unwrap_or_default())
    }
}

pub const MIC_FILE: &str = "mic.pcm";
pub const SPEAKER_FILE: &str = "speaker.pcm";

fn default_sample_rate() -> u32 {
    16_000
}

/// Write-to-temp-then-rename, so a reader never observes a half-written
/// file and a crash mid-write leaves the previous contents intact.
///
/// The rename really is atomic on every platform we ship: `std::fs::rename`
/// is `rename(2)` on Unix and `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING`
/// on Windows, both of which replace an existing destination in one step.
/// An earlier version deleted the destination first on Windows, which did
/// the opposite of what it intended — it opened a window where a crash left
/// no `meta.json` at all, losing a meeting's state rather than keeping the
/// older copy.
pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), std::io::Error> {
    let temp = path.with_extension("tmp");
    let mut file = fs::File::create(&temp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    fs::rename(temp, path)?;
    Ok(())
}

pub fn is_valid_root(path: &Path) -> bool {
    path.is_dir() || !path.exists()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    fn temp_store() -> (tempfile::TempDir, MeetingStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = MeetingStore::new(dir.path()).unwrap();
        (dir, store)
    }

    fn flag(offset_ms: u64, note: &str, position_percent: Option<u8>) -> FlaggedMoment {
        FlaggedMoment {
            offset_ms,
            note: note.into(),
            position_percent,
        }
    }

    #[test]
    fn flagged_moments_are_stored_with_their_position_and_bounded() {
        let (_dir, store) = temp_store();
        let id = Uuid::new_v4();
        let started = Utc::now();
        store.create_meeting(id, started).unwrap();
        let now = started + Duration::milliseconds(10_000);
        let long_note = "x".repeat(1_000);

        store
            .mark_flagged_moments(
                id,
                &[
                    flag(2_500, "  pricing  ", None),
                    flag(25_000, &long_note, None),
                    flag(5_000, "", None),
                    flag(1_000, "measured by the extension", Some(80)),
                ],
                now,
            )
            .unwrap();

        let moments = store.load_meta(id).unwrap().summary_options.flagged_moments;
        assert_eq!(moments.len(), 4);
        assert_eq!(moments[3].position_percent, Some(80));
        assert_eq!(moments[0].note, "pricing");
        assert_eq!(moments[0].position_percent, Some(25));
        // A flag past the recorded length clamps rather than overflowing 100%.
        assert_eq!(moments[1].position_percent, Some(100));
        assert_eq!(moments[1].note.chars().count(), 280);
        assert_eq!(moments[2].position_percent, Some(50));
    }

    #[test]
    fn at_most_two_hundred_flagged_moments_are_kept() {
        let (_dir, store) = temp_store();
        let id = Uuid::new_v4();
        store.create_meeting(id, Utc::now()).unwrap();
        let many: Vec<FlaggedMoment> = (0..500).map(|i| flag(i, "n", None)).collect();

        store.mark_flagged_moments(id, &many, Utc::now()).unwrap();

        assert_eq!(
            store
                .load_meta(id)
                .unwrap()
                .summary_options
                .flagged_moments
                .len(),
            200
        );
    }

    #[test]
    fn creates_and_loads_meeting_meta() {
        let (_dir, store) = temp_store();
        let id = Uuid::new_v4();
        let now = Utc::now();
        store.create_meeting(id, now).unwrap();

        let meta = store.load_meta(id).unwrap();
        assert_eq!(meta.id, id);
        assert_eq!(meta.state, MeetingState::Recording);
        assert!(meta.ended_at.is_none());
    }

    #[test]
    fn appends_audio_across_multiple_calls_without_truncating() {
        let (_dir, store) = temp_store();
        let id = Uuid::new_v4();
        store.create_meeting(id, Utc::now()).unwrap();

        store.append_audio(id, MIC_FILE, &[1, 2, 3]).unwrap();
        store.append_audio(id, MIC_FILE, &[4, 5, 6]).unwrap();

        let bytes = fs::read(store.audio_path(id, MIC_FILE)).unwrap();
        assert_eq!(bytes, vec![1, 2, 3, 4, 5, 6]);
    }

    #[test]
    fn mic_and_speaker_channels_stay_in_separate_files() {
        let (_dir, store) = temp_store();
        let id = Uuid::new_v4();
        store.create_meeting(id, Utc::now()).unwrap();

        store.append_audio(id, MIC_FILE, &[1]).unwrap();
        store.append_audio(id, SPEAKER_FILE, &[2]).unwrap();

        assert_eq!(fs::read(store.audio_path(id, MIC_FILE)).unwrap(), vec![1]);
        assert_eq!(
            fs::read(store.audio_path(id, SPEAKER_FILE)).unwrap(),
            vec![2]
        );
    }

    #[test]
    fn audio_len_reads_metadata_without_loading_the_channel() {
        let (_dir, store) = temp_store();
        let id = Uuid::new_v4();
        store.create_meeting(id, Utc::now()).unwrap();

        store.append_audio(id, MIC_FILE, &[1, 2, 3, 4]).unwrap();

        assert_eq!(store.audio_len(id, MIC_FILE).unwrap(), 4);
        assert_eq!(store.audio_len(id, SPEAKER_FILE).unwrap(), 0);
        assert!(store.audio_len(id, "meta.json").is_err());
    }

    #[test]
    fn managed_pending_identity_survives_restart() {
        let dir = tempfile::tempdir().unwrap();
        let store = MeetingStore::new(dir.path()).unwrap();
        let id = Uuid::new_v4();
        store.create_meeting(id, Utc::now()).unwrap();

        store
            .mark_managed_pending_for_identity(id, "account-1", "workspace-1")
            .unwrap();

        let reopened = MeetingStore::new(dir.path()).unwrap();
        let meta = reopened.load_meta(id).unwrap();
        assert_eq!(meta.managed_account_id.as_deref(), Some("account-1"));
        assert_eq!(meta.managed_workspace_id.as_deref(), Some("workspace-1"));
    }

    #[test]
    fn mark_stopped_transitions_state_and_sets_ended_at() {
        let (_dir, store) = temp_store();
        let id = Uuid::new_v4();
        let start = Utc::now();
        store.create_meeting(id, start).unwrap();

        let end = start + Duration::minutes(45);
        store.mark_stopped(id, end).unwrap();

        let meta = store.load_meta(id).unwrap();
        assert_eq!(meta.state, MeetingState::Stopped);
        assert_eq!(meta.ended_at, Some(end));
    }

    #[test]
    fn managed_processing_state_survives_upload_and_completion_transitions() {
        let (_dir, store) = temp_store();
        let id = Uuid::new_v4();
        store.create_meeting(id, Utc::now()).unwrap();

        store.mark_managed_pending(id).unwrap();
        store.set_managed_job_id(id, "job-123").unwrap();
        let pending = store.load_meta(id).unwrap();
        assert!(pending.managed_pending);
        assert_eq!(pending.managed_job_id.as_deref(), Some("job-123"));

        store.mark_managed_complete(id).unwrap();
        let complete = store.load_meta(id).unwrap();
        assert!(!complete.managed_pending);
        assert_eq!(complete.managed_job_id.as_deref(), Some("job-123"));
    }

    #[test]
    fn failed_managed_job_cursor_can_be_cleared_without_losing_pending_upload() {
        let (_dir, store) = temp_store();
        let id = Uuid::new_v4();
        store.create_meeting(id, Utc::now()).unwrap();
        store.mark_managed_pending(id).unwrap();
        store.set_managed_job_id(id, "failed-job").unwrap();

        store.clear_managed_job_id(id).unwrap();
        let meta = store.load_meta(id).unwrap();
        assert!(meta.managed_pending);
        assert!(meta.managed_job_id.is_none());
    }

    #[test]
    fn managed_upload_progress_survives_restart_and_keeps_the_next_chunk_cursor() {
        let dir = tempfile::tempdir().unwrap();
        let store = MeetingStore::new(dir.path()).unwrap();
        let id = Uuid::new_v4();
        store.create_meeting(id, Utc::now()).unwrap();
        store.mark_managed_pending(id).unwrap();
        store
            .set_managed_upload_progress(id, "upload-123", 7)
            .unwrap();

        let reopened = MeetingStore::new(dir.path()).unwrap();
        let meta = reopened.load_meta(id).unwrap();
        assert!(meta.managed_pending);
        assert_eq!(meta.managed_upload_id.as_deref(), Some("upload-123"));
        assert_eq!(meta.managed_next_chunk, 7);
    }

    #[test]
    fn old_metadata_without_managed_upload_fields_still_loads_as_local_state() {
        let (_dir, store) = temp_store();
        let id = Uuid::new_v4();
        store.create_meeting(id, Utc::now()).unwrap();

        let path = store.meeting_dir(id).join("meta.json");
        let mut old_meta: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let object = old_meta.as_object_mut().unwrap();
        object.remove("managed_pending");
        object.remove("managed_job_id");
        object.remove("managed_upload_id");
        object.remove("managed_next_chunk");
        fs::write(&path, serde_json::to_vec(&old_meta).unwrap()).unwrap();

        let loaded = store.load_meta(id).unwrap();
        assert!(!loaded.managed_pending);
        assert!(loaded.managed_job_id.is_none());
        assert!(loaded.managed_upload_id.is_none());
        assert_eq!(loaded.managed_next_chunk, 0);
    }

    #[test]
    fn find_interrupted_meetings_only_returns_recording_state() {
        let (_dir, store) = temp_store();
        let interrupted_id = Uuid::new_v4();
        let stopped_id = Uuid::new_v4();
        store.create_meeting(interrupted_id, Utc::now()).unwrap();
        store.create_meeting(stopped_id, Utc::now()).unwrap();
        store.mark_stopped(stopped_id, Utc::now()).unwrap();

        let interrupted = store.find_interrupted_meetings().unwrap();
        assert_eq!(interrupted.len(), 1);
        assert_eq!(interrupted[0].id, interrupted_id);
    }

    #[test]
    fn find_interrupted_meetings_is_empty_when_no_meetings_exist() {
        let (_dir, store) = temp_store();
        assert!(store.find_interrupted_meetings().unwrap().is_empty());
    }

    #[test]
    fn transcript_segments_accumulate_in_order() {
        let (_dir, store) = temp_store();
        let id = Uuid::new_v4();
        store.create_meeting(id, Utc::now()).unwrap();

        store
            .append_transcript_segment(
                id,
                &TranscriptSegment {
                    speaker: "you".into(),
                    text: "first".into(),
                    is_final: true,
                },
            )
            .unwrap();
        store
            .append_transcript_segment(
                id,
                &TranscriptSegment {
                    speaker: "them".into(),
                    text: "second".into(),
                    is_final: true,
                },
            )
            .unwrap();

        let transcript = store.load_transcript(id).unwrap();
        assert_eq!(transcript.len(), 2);
        assert_eq!(transcript[0].text, "first");
        assert_eq!(transcript[1].text, "second");
    }

    #[test]
    fn loading_meta_for_unknown_meeting_is_not_found() {
        let (_dir, store) = temp_store();
        let err = store.load_meta(Uuid::new_v4()).unwrap_err();
        assert!(matches!(err, StorageError::NotFound(_)));
    }

    #[test]
    fn reads_only_the_requested_audio_range() {
        let (_dir, store) = temp_store();
        let id = Uuid::new_v4();
        store.create_meeting(id, Utc::now()).unwrap();
        store.append_audio(id, MIC_FILE, &[1, 2, 3, 4, 5]).unwrap();

        assert_eq!(
            store.read_audio_range(id, MIC_FILE, 1, 4).unwrap(),
            vec![2, 3, 4]
        );
    }

    #[test]
    fn rejects_an_arbitrary_retry_filename() {
        let (_dir, store) = temp_store();
        let id = Uuid::new_v4();
        store.create_meeting(id, Utc::now()).unwrap();

        assert!(store.read_audio_range(id, "../meta.json", 0, 1).is_err());
    }

    #[test]
    fn excludes_active_recordings_from_recovery_scan() {
        let (_dir, store) = temp_store();
        let active_id = Uuid::new_v4();
        let interrupted_id = Uuid::new_v4();
        store.create_meeting(active_id, Utc::now()).unwrap();
        store.create_meeting(interrupted_id, Utc::now()).unwrap();

        let excluded = std::collections::HashSet::from([active_id]);
        let recoverable = store
            .find_interrupted_meetings_excluding(&excluded)
            .unwrap();

        assert_eq!(
            recoverable.iter().map(|meta| meta.id).collect::<Vec<_>>(),
            vec![interrupted_id]
        );
    }

    #[test]
    fn deleting_a_meeting_removes_raw_audio_and_metadata() {
        let (_dir, store) = temp_store();
        let id = Uuid::new_v4();
        store.create_meeting(id, Utc::now()).unwrap();
        store.append_audio(id, MIC_FILE, &[1, 2, 3]).unwrap();

        store.delete_meeting(id).unwrap();

        assert!(store.load_meta(id).is_err());
        assert!(!store.audio_path(id, MIC_FILE).exists());
    }

    #[test]
    fn summaries_are_persisted_for_tray_and_restart_access() {
        let (_dir, store) = temp_store();
        let id = Uuid::new_v4();
        store.create_meeting(id, Utc::now()).unwrap();
        let summary = Summary {
            summary: "A concise note".into(),
            action_items: vec![],
        };

        store.write_summary(id, &summary).unwrap();

        assert_eq!(store.load_summary(id).unwrap(), Some(summary));
    }
}
