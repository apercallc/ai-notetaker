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

use crate::providers::TranscriptSegment;
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
    pub started_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
    pub state: MeetingState,
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
            started_at,
            ended_at: None,
            state: MeetingState::Recording,
        };
        self.write_meta(&meta)?;
        Ok(())
    }

    fn write_meta(&self, meta: &MeetingMeta) -> Result<(), StorageError> {
        let path = self.meeting_dir(meta.id).join("meta.json");
        fs::write(path, serde_json::to_vec_pretty(meta)?)?;
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
        Ok(())
    }

    pub fn mark_stopped(&self, id: Uuid, ended_at: DateTime<Utc>) -> Result<(), StorageError> {
        let mut meta = self.load_meta(id)?;
        meta.ended_at = Some(ended_at);
        meta.state = MeetingState::Stopped;
        self.write_meta(&meta)
    }

    pub fn mark_processed(&self, id: Uuid) -> Result<(), StorageError> {
        let mut meta = self.load_meta(id)?;
        meta.state = MeetingState::Processed;
        self.write_meta(&meta)
    }

    pub fn append_transcript_segment(
        &self,
        id: Uuid,
        segment: &TranscriptSegment,
    ) -> Result<(), StorageError> {
        let mut segments = self.load_transcript(id).unwrap_or_default();
        segments.push(segment.clone());
        let path = self.meeting_dir(id).join("transcript.json");
        fs::write(path, serde_json::to_vec_pretty(&segments)?)?;
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

    /// Every meeting directory whose meta is still `Recording` — i.e. one
    /// that never saw a clean `stop_recording` before the process exited.
    /// This is the crash-recovery scan run on helper startup.
    pub fn find_interrupted_meetings(&self) -> Result<Vec<MeetingMeta>, StorageError> {
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
            if meta.state == MeetingState::Recording {
                interrupted.push(meta);
            }
        }
        interrupted.sort_by_key(|m| m.started_at);
        Ok(interrupted)
    }

    pub fn audio_path(&self, id: Uuid, channel_file: &str) -> PathBuf {
        self.meeting_dir(id).join(channel_file)
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
}

pub const MIC_FILE: &str = "mic.pcm";
pub const SPEAKER_FILE: &str = "speaker.pcm";

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
}
