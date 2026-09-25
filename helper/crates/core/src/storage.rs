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
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
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

/// One directory under `<root>/meetings/` that the recovery scan could not
/// turn into a `MeetingMeta`. Its raw audio (if any) is still on disk, so it
/// is surfaced to the user rather than silently dropped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnreadableMeeting {
    pub dir: PathBuf,
    /// Parsed from the directory name when it is a UUID.
    pub meeting_id: Option<Uuid>,
    pub reason: String,
}

/// Result of scanning every meeting directory. A single corrupt `meta.json`
/// must never hide the other recoverable recordings, so bad entries are
/// reported separately instead of aborting the scan.
#[derive(Debug, Clone, Default)]
pub struct MeetingScan {
    pub readable: Vec<MeetingMeta>,
    pub unreadable: Vec<UnreadableMeeting>,
}

/// `meta.json` is a read-modify-write document updated from several tasks
/// (audio ingest, the transcription pipeline, the retry worker, the managed
/// uploader), and `MeetingStore` is cheaply cloned and constructed in several
/// places, so the serialization point has to be process-wide and keyed by
/// meeting rather than living inside one store instance.
fn lock_map() -> std::sync::MutexGuard<'static, HashMap<Uuid, Arc<Mutex<()>>>> {
    static LOCKS: OnceLock<Mutex<HashMap<Uuid, Arc<Mutex<()>>>>> = OnceLock::new();
    LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn meeting_lock(id: Uuid) -> Arc<Mutex<()>> {
    lock_map().entry(id).or_default().clone()
}

/// Dropped when a meeting is deleted so the map does not grow forever. A
/// concurrent holder keeps its own `Arc`, so this can never break a critical
/// section that is already running.
fn forget_meeting_lock(id: Uuid) {
    lock_map().remove(&id);
}

impl StorageError {
    /// The wire-level category for this failure: a full disk is called out
    /// separately (the user can fix it and the helper auto-stops on it);
    /// everything else local is a generic storage error.
    pub fn error_code(&self) -> crate::native_messaging::ErrorCode {
        use crate::native_messaging::ErrorCode;
        match self {
            StorageError::Io(error) => io_error_code(error),
            _ => ErrorCode::StorageError,
        }
    }
}

/// Maps an I/O failure to `DiskFull` (ENOSPC / ERROR_DISK_FULL / quota) or the
/// generic `StorageError`.
pub fn io_error_code(error: &std::io::Error) -> crate::native_messaging::ErrorCode {
    use crate::native_messaging::ErrorCode;
    if matches!(
        error.kind(),
        std::io::ErrorKind::StorageFull | std::io::ErrorKind::QuotaExceeded
    ) {
        ErrorCode::DiskFull
    } else {
        ErrorCode::StorageError
    }
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
        self.write_meta(&meta)
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

    /// Writes a brand-new meta document under the meeting's lock.
    fn write_meta(&self, meta: &MeetingMeta) -> Result<(), StorageError> {
        let lock = meeting_lock(meta.id);
        let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        self.write_meta_unlocked(meta)
    }

    fn write_meta_unlocked(&self, meta: &MeetingMeta) -> Result<(), StorageError> {
        let path = self.meeting_dir(meta.id).join("meta.json");
        atomic_write(&path, &serde_json::to_vec_pretty(meta)?)?;
        Ok(())
    }

    /// The only way meta is modified after creation: load, mutate and write
    /// back while holding the meeting's process-wide lock, so two concurrent
    /// updaters (ingest recording a sample rate while the pipeline advances
    /// its transcription cursor) can never overwrite each other's change.
    fn update_meta<F>(&self, id: Uuid, mutate: F) -> Result<(), StorageError>
    where
        F: FnOnce(&mut MeetingMeta) -> Result<(), StorageError>,
    {
        let lock = meeting_lock(id);
        let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut meta = self.load_meta(id)?;
        mutate(&mut meta)?;
        self.write_meta_unlocked(&meta)
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
        let title = title.trim();
        if title.is_empty() {
            self.load_meta(id)?;
            return Ok(());
        }
        self.update_meta(id, |meta| {
            meta.title = Some(title.chars().take(200).collect());
            Ok(())
        })
    }

    /// Appends raw PCM16 bytes to the given channel's file for this
    /// meeting and makes them durable before returning. Used by the
    /// synchronous pipeline path and tests; the helper's live capture path
    /// uses [`AudioAppender`], which batches the flush.
    pub fn append_audio(
        &self,
        id: Uuid,
        channel_file: &str,
        pcm16: &[u8],
    ) -> Result<(), StorageError> {
        let mut appender = self.open_audio_appender(id);
        appender.append(channel_file, pcm16)?;
        appender.sync()
    }

    /// Opens a per-meeting appender that keeps both channel files open and
    /// batches `fsync`, for the single writer task that owns a live capture.
    pub fn open_audio_appender(&self, id: Uuid) -> AudioAppender {
        AudioAppender::new(self.meeting_dir(id))
    }

    pub fn mark_stopped(&self, id: Uuid, ended_at: DateTime<Utc>) -> Result<(), StorageError> {
        self.update_meta(id, |meta| {
            meta.ended_at = Some(ended_at);
            meta.state = MeetingState::Stopped;
            Ok(())
        })
    }

    /// Puts a stopped meeting back into the `Recording` state so the startup
    /// recovery scan offers it again. Used when a graceful shutdown ran out
    /// of time before the transcription tail was processed: the raw audio is
    /// safe, and recovery is what re-transcribes whatever is past the cursor.
    pub fn mark_interrupted(&self, id: Uuid) -> Result<(), StorageError> {
        self.update_meta(id, |meta| {
            meta.ended_at = None;
            meta.state = MeetingState::Recording;
            Ok(())
        })
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
        self.update_meta(id, |meta| {
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
            Ok(())
        })
    }

    pub fn mark_processed(&self, id: Uuid) -> Result<(), StorageError> {
        self.update_meta(id, |meta| {
            meta.state = MeetingState::Processed;
            meta.summary_pending = false;
            Ok(())
        })
    }

    pub fn mark_summary_pending(&self, id: Uuid) -> Result<(), StorageError> {
        self.update_meta(id, |meta| {
            meta.summary_pending = true;
            Ok(())
        })
    }

    /// Marks a managed capture as requiring hosted upload/processing. This is
    /// written before capture begins so an unexpected shutdown cannot make a
    /// managed meeting indistinguishable from a completed local one.
    pub fn mark_managed_pending(&self, id: Uuid) -> Result<(), StorageError> {
        self.update_meta(id, |meta| {
            meta.managed_pending = true;
            Ok(())
        })
    }

    pub fn mark_managed_pending_for_identity(
        &self,
        id: Uuid,
        account_id: &str,
        workspace_id: &str,
    ) -> Result<(), StorageError> {
        self.update_meta(id, |meta| {
            meta.managed_pending = true;
            meta.managed_account_id = Some(account_id.to_owned());
            meta.managed_workspace_id = Some(workspace_id.to_owned());
            Ok(())
        })
    }

    pub fn set_managed_job_id(&self, id: Uuid, job_id: &str) -> Result<(), StorageError> {
        self.update_meta(id, |meta| {
            meta.managed_pending = true;
            meta.managed_job_id = Some(job_id.to_string());
            Ok(())
        })
    }

    /// Retain the durable managed upload after a terminal hosted-job failure,
    /// but forget the failed job cursor so the next authenticated settings
    /// refresh can enqueue the same idempotent work again.
    pub fn clear_managed_job_id(&self, id: Uuid) -> Result<(), StorageError> {
        self.update_meta(id, |meta| {
            meta.managed_pending = true;
            meta.managed_job_id = None;
            Ok(())
        })
    }

    pub fn set_managed_upload_progress(
        &self,
        id: Uuid,
        upload_id: &str,
        next_chunk: usize,
    ) -> Result<(), StorageError> {
        self.update_meta(id, |meta| {
            meta.managed_pending = true;
            meta.managed_upload_id = Some(upload_id.to_string());
            meta.managed_next_chunk = next_chunk;
            Ok(())
        })
    }

    pub fn mark_managed_complete(&self, id: Uuid) -> Result<(), StorageError> {
        self.update_meta(id, |meta| {
            meta.managed_pending = false;
            Ok(())
        })
    }

    pub fn mark_audio_transcribed(
        &self,
        id: Uuid,
        channel_file: &str,
        end: usize,
    ) -> Result<(), StorageError> {
        self.update_meta(id, |meta| {
            match channel_file {
                MIC_FILE => meta.transcribed_mic_bytes = meta.transcribed_mic_bytes.max(end),
                SPEAKER_FILE => {
                    meta.transcribed_speaker_bytes = meta.transcribed_speaker_bytes.max(end)
                }
                _ => return Err(invalid_channel()),
            }
            Ok(())
        })
    }

    /// Records a channel's sample rate. Callers should only call this when
    /// the rate changes; an unchanged value is a no-op here too, so it can
    /// never turn every audio frame into a `meta.json` rewrite.
    pub fn mark_audio_sample_rate(
        &self,
        id: Uuid,
        channel_file: &str,
        sample_rate_hz: u32,
    ) -> Result<(), StorageError> {
        let lock = meeting_lock(id);
        let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut meta = self.load_meta(id)?;
        let slot = match channel_file {
            MIC_FILE => &mut meta.mic_sample_rate_hz,
            SPEAKER_FILE => &mut meta.speaker_sample_rate_hz,
            _ => return Err(invalid_channel()),
        };
        if *slot == sample_rate_hz {
            return Ok(());
        }
        *slot = sample_rate_hz;
        self.write_meta_unlocked(&meta)
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
        let lock = meeting_lock(id);
        let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
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
    /// This is the crash-recovery scan run on helper startup. Unreadable
    /// entries are skipped (and logged) rather than failing the whole scan.
    pub fn find_interrupted_meetings(&self) -> Result<Vec<MeetingMeta>, StorageError> {
        self.find_interrupted_meetings_excluding(&std::collections::HashSet::new())
    }

    pub fn find_interrupted_meetings_excluding(
        &self,
        excluded: &std::collections::HashSet<Uuid>,
    ) -> Result<Vec<MeetingMeta>, StorageError> {
        let mut interrupted: Vec<MeetingMeta> = self
            .scan_meetings()?
            .readable
            .into_iter()
            .filter(|meta| meta.state == MeetingState::Recording && !excluded.contains(&meta.id))
            .collect();
        interrupted.sort_by_key(|m| m.started_at);
        Ok(interrupted)
    }

    /// Reads every meeting directory, separating the ones whose `meta.json`
    /// parsed from the ones that did not. One corrupt file must never hide
    /// the other recoverable recordings, so a failure here is data, not an
    /// error: it is logged and returned in `unreadable` so the UI can point
    /// the user at the folder that still holds their audio.
    pub fn scan_meetings(&self) -> Result<MeetingScan, StorageError> {
        let meetings_dir = self.root.join("meetings");
        let mut scan = MeetingScan::default();
        if !meetings_dir.exists() {
            return Ok(scan);
        }
        for entry in fs::read_dir(&meetings_dir)? {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    tracing::warn!(%error, "could not list an entry in the meetings folder");
                    continue;
                }
            };
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let meeting_id = dir
                .file_name()
                .and_then(|name| name.to_str())
                .and_then(|name| Uuid::parse_str(name).ok());
            let meta_path = dir.join("meta.json");
            let failure = match fs::read(&meta_path) {
                Ok(bytes) => match serde_json::from_slice::<MeetingMeta>(&bytes) {
                    Ok(meta) => {
                        scan.readable.push(meta);
                        continue;
                    }
                    Err(error) => format!("meta.json is not valid: {error}"),
                },
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    // A directory with no meta and no audio is just an empty
                    // shell; one that still holds audio is a real recording
                    // whose bookkeeping was lost.
                    if !directory_holds_audio(&dir) {
                        continue;
                    }
                    "meta.json is missing but raw audio is present".to_string()
                }
                Err(error) => format!("meta.json could not be read: {error}"),
            };
            tracing::warn!(dir = %dir.display(), reason = %failure, "skipping unreadable recording");
            scan.unreadable.push(UnreadableMeeting {
                dir,
                meeting_id,
                reason: failure,
            });
        }
        scan.readable.sort_by_key(|meta| meta.started_at);
        scan.unreadable.sort_by(|a, b| a.dir.cmp(&b.dir));
        Ok(scan)
    }

    /// The most recently started readable meeting, for "Open Latest Note".
    pub fn latest_meeting(&self) -> Result<Option<MeetingMeta>, StorageError> {
        Ok(self
            .scan_meetings()?
            .readable
            .into_iter()
            .max_by_key(|meta| meta.started_at))
    }

    /// Renders a meeting as a human-readable Markdown note: summary, action
    /// items, flagged moments and transcript, each only when available, with
    /// an honest status line for a meeting that is still being processed.
    pub fn render_note_markdown(&self, id: Uuid) -> Result<String, StorageError> {
        let meta = self.load_meta(id)?;
        let transcript = self.load_transcript(id)?;
        let summary = self.load_summary(id)?;
        let mut note = String::new();
        let title = meta.title.clone().unwrap_or_else(|| {
            format!(
                "Meeting on {}",
                meta.started_at.format("%Y-%m-%d %H:%M UTC")
            )
        });
        note.push_str(&format!("# {title}\n\n"));
        note.push_str(&format!(
            "- Started: {}\n",
            meta.started_at.format("%Y-%m-%d %H:%M UTC")
        ));
        if let Some(ended) = meta.ended_at {
            note.push_str(&format!(
                "- Ended: {}\n",
                ended.format("%Y-%m-%d %H:%M UTC")
            ));
        }
        let status = match (meta.state, summary.is_some(), meta.summary_pending) {
            (MeetingState::Recording, _, _) => {
                "Recording was interrupted; recover it from the tray menu to finish processing"
            }
            (_, true, _) => "Complete",
            (_, false, true) => "Summary pending",
            (_, false, false) if meta.managed_pending => "Hosted processing in progress",
            (_, false, false) => "No summary available",
        };
        note.push_str(&format!("- Status: {status}\n\n"));

        note.push_str("## Summary\n\n");
        match &summary {
            Some(summary) if !summary.summary.trim().is_empty() => {
                note.push_str(summary.summary.trim());
                note.push_str("\n\n");
            }
            _ => note.push_str("_No summary yet._\n\n"),
        }
        if let Some(summary) = &summary {
            if !summary.action_items.is_empty() {
                note.push_str("## Action items\n\n");
                for item in &summary.action_items {
                    match item
                        .owner
                        .as_deref()
                        .filter(|owner| !owner.trim().is_empty())
                    {
                        Some(owner) => note.push_str(&format!("- [ ] {} ({owner})\n", item.text)),
                        None => note.push_str(&format!("- [ ] {}\n", item.text)),
                    }
                }
                note.push('\n');
            }
        }
        let moments = &meta.summary_options.flagged_moments;
        if !moments.is_empty() {
            note.push_str("## Flagged moments\n\n");
            for moment in moments {
                let seconds = moment.offset_ms / 1_000;
                let note_text = if moment.note.is_empty() {
                    "(no note)"
                } else {
                    moment.note.as_str()
                };
                note.push_str(&format!(
                    "- {:02}:{:02} {note_text}\n",
                    seconds / 60,
                    seconds % 60
                ));
            }
            note.push('\n');
        }
        if !transcript.is_empty() {
            note.push_str("## Transcript\n\n");
            for segment in transcript.iter().filter(|segment| segment.is_final) {
                note.push_str(&format!(
                    "**{}:** {}\n\n",
                    segment.speaker,
                    segment.text.trim()
                ));
            }
        }
        Ok(note)
    }

    /// Writes `note.md` beside the meeting's data and returns its path, so
    /// "Open Latest Note" opens something a person can read rather than raw
    /// JSON. Regenerated on every call so it never goes stale.
    pub fn write_note_markdown(&self, id: Uuid) -> Result<PathBuf, StorageError> {
        let markdown = self.render_note_markdown(id)?;
        let path = self.meeting_dir(id).join("note.md");
        atomic_write(&path, markdown.as_bytes())?;
        Ok(path)
    }

    pub fn delete_meeting(&self, id: Uuid) -> Result<(), StorageError> {
        let dir = self.meeting_dir(id);
        if dir.exists() {
            fs::remove_dir_all(dir)?;
        }
        forget_meeting_lock(id);
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

fn invalid_channel() -> StorageError {
    StorageError::Io(std::io::Error::new(
        std::io::ErrorKind::InvalidInput,
        "invalid audio channel",
    ))
}

fn directory_holds_audio(dir: &Path) -> bool {
    [MIC_FILE, SPEAKER_FILE].iter().any(|name| {
        fs::metadata(dir.join(name))
            .map(|metadata| metadata.len() > 0)
            .unwrap_or(false)
    })
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
///
/// The temp name is unique per call (process id + a counter): a fixed
/// `meta.tmp` let two concurrent writers truncate and rename each other's
/// half-written file.
pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), std::io::Error> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_string());
    let temp = path.with_file_name(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = fs::File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

/// Append-only writer for one meeting's two PCM channel files, owned by the
/// single ingest task for that meeting.
///
/// It keeps the files open (no `open()` per audio frame), tracks each file's
/// length itself (no `stat()` per frame) and batches durability: bytes reach
/// the OS on every `append`, so a helper crash loses nothing, while `fsync`
/// runs at most once per interval instead of once per ~10 ms frame. The only
/// window `fsync` batching leaves open is an OS crash or power loss losing up
/// to one interval of the newest audio; the retry path already reports (and
/// recovery tolerates) a cursor that points past the end of a shortened file.
pub struct AudioAppender {
    dir: PathBuf,
    mic: AppendChannel,
    speaker: AppendChannel,
    last_sync: Instant,
}

#[derive(Default)]
struct AppendChannel {
    file: Option<fs::File>,
    len: u64,
    dirty: bool,
}

impl AudioAppender {
    fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            mic: AppendChannel::default(),
            speaker: AppendChannel::default(),
            last_sync: Instant::now(),
        }
    }

    fn channel(&mut self, channel_file: &str) -> Result<&mut AppendChannel, StorageError> {
        match channel_file {
            MIC_FILE => Ok(&mut self.mic),
            SPEAKER_FILE => Ok(&mut self.speaker),
            _ => Err(invalid_channel()),
        }
    }

    /// Appends `pcm16` and returns the file length *before* the append — the
    /// offset at which these bytes start, which the transcription cursor uses.
    pub fn append(&mut self, channel_file: &str, pcm16: &[u8]) -> Result<usize, StorageError> {
        let path = self.dir.join(channel_file);
        let channel = self.channel(channel_file)?;
        if channel.file.is_none() {
            let file = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)?;
            channel.len = file.metadata()?.len();
            channel.file = Some(file);
        }
        let start = channel.len;
        let file = channel.file.as_mut().expect("opened above");
        match file.write_all(pcm16) {
            Ok(()) => {
                channel.len = start + pcm16.len() as u64;
                channel.dirty = true;
                Ok(start as usize)
            }
            Err(error) => {
                // A failed write may have landed partially; forget the handle
                // and length so the next append re-reads the true file size.
                channel.file = None;
                Err(error.into())
            }
        }
    }

    /// `fsync`s dirty channels if at least `interval` has passed since the
    /// previous flush. Cheap to call after every frame.
    pub fn sync_if_due(&mut self, interval: Duration) -> Result<(), StorageError> {
        if self.last_sync.elapsed() < interval {
            return Ok(());
        }
        self.sync()
    }

    /// Unconditionally makes everything appended so far durable.
    pub fn sync(&mut self) -> Result<(), StorageError> {
        self.last_sync = Instant::now();
        for channel in [&mut self.mic, &mut self.speaker] {
            if !channel.dirty {
                continue;
            }
            if let Some(file) = channel.file.as_ref() {
                file.sync_data()?;
            }
            channel.dirty = false;
        }
        Ok(())
    }
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

    #[test]
    fn storage_failures_map_to_specific_error_codes() {
        use crate::native_messaging::ErrorCode;
        let full = StorageError::Io(std::io::Error::from(std::io::ErrorKind::StorageFull));
        assert_eq!(full.error_code(), ErrorCode::DiskFull);
        let denied = StorageError::Io(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
        assert_eq!(denied.error_code(), ErrorCode::StorageError);
        assert_eq!(
            StorageError::NotFound(Uuid::new_v4()).error_code(),
            ErrorCode::StorageError
        );
    }

    #[test]
    fn one_unreadable_meta_does_not_hide_the_other_recoverable_recordings() {
        let (dir, store) = temp_store();
        let good_a = Uuid::new_v4();
        let good_b = Uuid::new_v4();
        store.create_meeting(good_a, Utc::now()).unwrap();
        store.create_meeting(good_b, Utc::now()).unwrap();

        let corrupt = Uuid::new_v4();
        let corrupt_dir = dir.path().join("meetings").join(corrupt.to_string());
        fs::create_dir_all(&corrupt_dir).unwrap();
        fs::write(corrupt_dir.join("meta.json"), b"{ not json").unwrap();
        fs::write(corrupt_dir.join(MIC_FILE), [1, 2, 3, 4]).unwrap();

        let orphan = Uuid::new_v4();
        let orphan_dir = dir.path().join("meetings").join(orphan.to_string());
        fs::create_dir_all(&orphan_dir).unwrap();
        fs::write(orphan_dir.join(SPEAKER_FILE), [9, 9]).unwrap();

        // An empty shell directory is not a recording.
        fs::create_dir_all(dir.path().join("meetings").join(Uuid::new_v4().to_string())).unwrap();

        let interrupted = store.find_interrupted_meetings().unwrap();
        let ids: Vec<Uuid> = interrupted.iter().map(|meta| meta.id).collect();
        assert!(ids.contains(&good_a) && ids.contains(&good_b));
        assert_eq!(ids.len(), 2);

        let scan = store.scan_meetings().unwrap();
        assert_eq!(scan.readable.len(), 2);
        let bad: Vec<Option<Uuid>> = scan.unreadable.iter().map(|item| item.meeting_id).collect();
        assert_eq!(scan.unreadable.len(), 2);
        assert!(bad.contains(&Some(corrupt)) && bad.contains(&Some(orphan)));
    }

    #[test]
    fn concurrent_meta_updates_never_lose_each_others_changes() {
        let (_dir, store) = temp_store();
        let id = Uuid::new_v4();
        store.create_meeting(id, Utc::now()).unwrap();

        let rates = store.clone();
        let cursor = store.clone();
        let sample_rate = std::thread::spawn(move || {
            for i in 0..200u32 {
                rates
                    .mark_audio_sample_rate(id, MIC_FILE, 8_000 + (i % 2) * 8_000)
                    .unwrap();
            }
            rates.mark_audio_sample_rate(id, MIC_FILE, 48_000).unwrap();
        });
        let transcribed = std::thread::spawn(move || {
            for end in 1..=200usize {
                cursor
                    .mark_audio_transcribed(id, MIC_FILE, end * 100)
                    .unwrap();
            }
        });
        sample_rate.join().unwrap();
        transcribed.join().unwrap();

        let meta = store.load_meta(id).unwrap();
        assert_eq!(meta.mic_sample_rate_hz, 48_000);
        assert_eq!(meta.transcribed_mic_bytes, 20_000);
    }

    #[test]
    fn unchanged_sample_rate_does_not_rewrite_meta() {
        let (dir, store) = temp_store();
        let id = Uuid::new_v4();
        store.create_meeting(id, Utc::now()).unwrap();
        store.mark_audio_sample_rate(id, MIC_FILE, 48_000).unwrap();
        let meta_path = dir
            .path()
            .join("meetings")
            .join(id.to_string())
            .join("meta.json");
        let before = fs::metadata(&meta_path).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(30));
        store.mark_audio_sample_rate(id, MIC_FILE, 48_000).unwrap();
        assert_eq!(
            fs::metadata(&meta_path).unwrap().modified().unwrap(),
            before
        );
    }

    #[test]
    fn atomic_writes_use_unique_temp_files_and_leave_none_behind() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("doc.json");
        let threads: Vec<_> = (0..8)
            .map(|worker| {
                let path = path.clone();
                std::thread::spawn(move || {
                    for round in 0..50 {
                        let body = format!("{{\"worker\":{worker},\"round\":{round}}}");
                        atomic_write(&path, body.as_bytes()).unwrap();
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        // Whatever won the last rename, it is one writer's complete document.
        let value: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert!(value.get("worker").is_some());
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp files leaked: {leftovers:?}");
    }

    #[test]
    fn audio_appender_tracks_offsets_and_batches_durability() {
        let (_dir, store) = temp_store();
        let id = Uuid::new_v4();
        store.create_meeting(id, Utc::now()).unwrap();
        let mut appender = store.open_audio_appender(id);

        assert_eq!(appender.append(MIC_FILE, &[1, 2, 3, 4]).unwrap(), 0);
        assert_eq!(appender.append(MIC_FILE, &[5, 6]).unwrap(), 4);
        assert_eq!(appender.append(SPEAKER_FILE, &[7, 8]).unwrap(), 0);
        // Not yet due: the flush is skipped, but the bytes are already with
        // the OS and visible to readers.
        appender
            .sync_if_due(std::time::Duration::from_secs(3_600))
            .unwrap();
        assert_eq!(store.audio_len(id, MIC_FILE).unwrap(), 6);
        appender.sync().unwrap();
        assert_eq!(
            store.read_audio_range(id, MIC_FILE, 0, 6).unwrap(),
            vec![1, 2, 3, 4, 5, 6]
        );
        assert!(appender.append("meta.json", &[1]).is_err());

        // A second appender (a resumed capture) continues at the file's end.
        let mut resumed = store.open_audio_appender(id);
        assert_eq!(resumed.append(MIC_FILE, &[9]).unwrap(), 6);
    }

    #[test]
    fn interrupted_meetings_can_be_reopened_after_a_shutdown_ran_out_of_time() {
        let (_dir, store) = temp_store();
        let id = Uuid::new_v4();
        store.create_meeting(id, Utc::now()).unwrap();
        store.mark_stopped(id, Utc::now()).unwrap();
        assert!(store.find_interrupted_meetings().unwrap().is_empty());
        store.mark_interrupted(id).unwrap();
        let meta = store.load_meta(id).unwrap();
        assert_eq!(meta.state, MeetingState::Recording);
        assert!(meta.ended_at.is_none());
        assert_eq!(store.find_interrupted_meetings().unwrap().len(), 1);
    }

    #[test]
    fn note_markdown_is_readable_and_honest_about_missing_pieces() {
        let (dir, store) = temp_store();
        let id = Uuid::new_v4();
        store.create_meeting(id, Utc::now()).unwrap();
        store.set_title(id, "Roadmap sync").unwrap();
        store.mark_stopped(id, Utc::now()).unwrap();
        store.mark_summary_pending(id).unwrap();

        let pending = store.render_note_markdown(id).unwrap();
        assert!(pending.starts_with("# Roadmap sync\n"));
        assert!(pending.contains("Status: Summary pending"));
        assert!(pending.contains("_No summary yet._"));
        assert!(!pending.contains("## Transcript"));

        store
            .append_transcript_segments(
                id,
                &[
                    TranscriptSegment {
                        speaker: "You".into(),
                        text: " Ship it. ".into(),
                        is_final: true,
                    },
                    TranscriptSegment {
                        speaker: "Them".into(),
                        text: "partial".into(),
                        is_final: false,
                    },
                ],
            )
            .unwrap();
        store
            .write_summary(
                id,
                &Summary {
                    summary: "We agreed to ship.".into(),
                    action_items: vec![
                        crate::native_messaging::ActionItem {
                            text: "Send notes".into(),
                            owner: Some("Sam".into()),
                        },
                        crate::native_messaging::ActionItem {
                            text: "Book venue".into(),
                            owner: None,
                        },
                    ],
                },
            )
            .unwrap();
        store.mark_processed(id).unwrap();
        store
            .mark_flagged_moments(id, &[flag(65_000, "pricing", Some(50))], Utc::now())
            .unwrap();

        let note = store.render_note_markdown(id).unwrap();
        assert!(note.contains("Status: Complete"));
        assert!(note.contains("We agreed to ship."));
        assert!(note.contains("- [ ] Send notes (Sam)"));
        assert!(note.contains("- [ ] Book venue\n"));
        assert!(note.contains("- 01:05 pricing"));
        assert!(note.contains("**You:** Ship it."));
        assert!(!note.contains("partial"));

        let path = store.write_note_markdown(id).unwrap();
        assert_eq!(
            path,
            dir.path()
                .join("meetings")
                .join(id.to_string())
                .join("note.md")
        );
        assert_eq!(fs::read_to_string(path).unwrap(), note);
        assert_eq!(store.latest_meeting().unwrap().unwrap().id, id);
    }
}
