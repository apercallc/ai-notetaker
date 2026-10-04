//! Bounded, secret-free import for meeting text exported by the legacy extension.

use chrono::{DateTime, Utc};
use notetaker_core::native_messaging::{
    ActionItem, MeetingMode, SummarizationProviderId, TranscriptionProviderId,
};
use notetaker_core::providers::{Summary, TranscriptSegment};
use notetaker_core::storage::{ImportedMeetingNote, MeetingStore};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub const MAX_ARCHIVE_BYTES: usize = 20 * 1024 * 1024;
const MAX_MEETINGS: usize = 2_000;
const MAX_SEGMENTS_PER_MEETING: usize = 50_000;
const MAX_TRANSCRIPT_CHARS: usize = 2_000_000;
const AUDIO_ARCHIVE_MAGIC: &[u8; 8] = b"NTKAR001";
const MAX_AUDIO_MANIFEST_BYTES: usize = 20 * 1024 * 1024;
const MAX_AUDIO_ARCHIVE_BYTES: u64 = 50 * 1024 * 1024 * 1024;
const MAX_AUDIO_CHUNK_BYTES: u32 = 8 * 1024 * 1024;
const MAX_AUDIO_CHUNKS: u64 = 50_000_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationArchive {
    format: String,
    version: u32,
    exported_at: DateTime<Utc>,
    pub settings: MigrationSettings,
    meetings: Vec<MigrationMeeting>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSettings {
    pub transcription_provider: TranscriptionProviderId,
    pub summarization_provider: SummarizationProviderId,
    pub default_meeting_mode: MeetingMode,
    pub custom_vocabulary: Vec<String>,
    pub custom_summary_instructions: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MigrationMeeting {
    id: Uuid,
    title: String,
    started_at: DateTime<Utc>,
    ended_at: Option<DateTime<Utc>>,
    mode: Option<MeetingMode>,
    status: String,
    transcript: Vec<MigrationSegment>,
    summary: Option<String>,
    action_items: Vec<MigrationActionItem>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MigrationSegment {
    speaker: String,
    text: String,
    is_final: bool,
    #[allow(dead_code)]
    timestamp: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MigrationActionItem {
    text: String,
    owner: Option<String>,
    id: Option<String>,
    status: Option<String>,
    #[serde(rename = "dueAt")]
    due_at: Option<String>,
    #[serde(rename = "completedAt")]
    completed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MigrationImportReport {
    pub imported: usize,
    pub already_present: usize,
    pub preferences_imported: bool,
    pub audio_imported: usize,
    pub audio_bytes: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AudioTransferManifest {
    format: String,
    version: u32,
    sample_rate_hz: u32,
    notes: MigrationArchive,
    audio_meeting_ids: Vec<Uuid>,
}

pub fn parse_archive_json(json: &str) -> Result<MigrationArchive, String> {
    if json.len() > MAX_ARCHIVE_BYTES {
        return Err("Transfer file is larger than 20 MB.".into());
    }
    let archive: MigrationArchive = serde_json::from_str(json)
        .map_err(|_| "This is not a valid AI Notetaker desktop transfer file.".to_string())?;
    validate_archive(&archive)?;
    Ok(archive)
}

fn validate_archive(archive: &MigrationArchive) -> Result<(), String> {
    if archive.format != "ai-notetaker-desktop-transfer" || archive.version != 1 {
        return Err("This transfer file version is not supported.".into());
    }
    let _ = archive.exported_at;
    validate_settings(&archive.settings)?;
    if archive.meetings.len() > MAX_MEETINGS {
        return Err("Transfer file contains too many meetings.".into());
    }
    for meeting in &archive.meetings {
        validate_meeting(meeting)?;
    }
    Ok(())
}

fn validate_settings(settings: &MigrationSettings) -> Result<(), String> {
    if settings.custom_vocabulary.len() > 100
        || settings
            .custom_vocabulary
            .iter()
            .any(|term| term.chars().count() > 100)
        || settings.custom_summary_instructions.chars().count() > 4_000
    {
        return Err("Transfer file contains invalid desktop preferences.".into());
    }
    Ok(())
}

fn validate_meeting(meeting: &MigrationMeeting) -> Result<(), String> {
    if !matches!(
        meeting.status.as_str(),
        "recording" | "saved" | "processing" | "complete" | "error"
    ) || (meeting.status == "complete" && meeting.ended_at.is_none())
    {
        return Err("Transfer file contains an invalid meeting state.".into());
    }
    if meeting.title.trim().is_empty()
        || meeting.title.chars().count() > 200
        || meeting.title.chars().any(char::is_control)
        || meeting
            .summary
            .as_ref()
            .is_some_and(|summary| summary.chars().count() > 100_000)
        || meeting.transcript.len() > MAX_SEGMENTS_PER_MEETING
        || meeting.action_items.len() > 1_000
    {
        return Err("Transfer file contains a meeting that exceeds import limits.".into());
    }
    if meeting
        .ended_at
        .is_some_and(|ended_at| ended_at < meeting.started_at)
    {
        return Err("Transfer file contains invalid meeting dates.".into());
    }
    let transcript_chars = meeting
        .transcript
        .iter()
        .try_fold(0usize, |total, segment| {
            if segment.text.chars().count() > 25_000
                || segment.text.chars().any(|ch| ch == '\0')
                || segment
                    .timestamp
                    .as_ref()
                    .is_some_and(|timestamp| DateTime::parse_from_rfc3339(timestamp).is_err())
                || !(segment.speaker == "you"
                    || segment.speaker == "them"
                    || (segment.speaker.starts_with("them-")
                        && segment.speaker[5..].parse::<u32>().is_ok()))
            {
                return None;
            }
            total.checked_add(segment.text.chars().count())
        });
    if transcript_chars.is_none_or(|count| count > MAX_TRANSCRIPT_CHARS) {
        return Err("Transfer file contains invalid or oversized transcript text.".into());
    }
    if meeting.action_items.iter().any(|item| {
        item.text.chars().count() > 2_000
            || item
                .owner
                .as_ref()
                .is_some_and(|owner| owner.chars().count() > 200)
            || item.id.as_ref().is_some_and(|id| id.chars().count() > 200)
            || item
                .status
                .as_deref()
                .is_some_and(|status| status != "open" && status != "done")
            || item
                .due_at
                .as_ref()
                .is_some_and(|date| DateTime::parse_from_rfc3339(date).is_err())
            || item
                .completed_at
                .as_ref()
                .is_some_and(|date| DateTime::parse_from_rfc3339(date).is_err())
    }) {
        return Err("Transfer file contains an invalid action item.".into());
    }
    Ok(())
}

pub fn import_archive(
    archive: MigrationArchive,
    store: &MeetingStore,
) -> Result<MigrationImportReport, String> {
    let mut report = MigrationImportReport {
        imported: 0,
        already_present: 0,
        preferences_imported: true,
        audio_imported: 0,
        audio_bytes: 0,
    };
    for meeting in archive.meetings {
        match store
            .import_text_only_note(into_imported_note(meeting))
            .map_err(|_| "A meeting could not be written to the desktop library. Retry the same transfer file; already imported notes will be skipped.".to_string())?
        {
            true => report.imported += 1,
            false => report.already_present += 1,
        }
    }
    Ok(report)
}

fn into_imported_note(meeting: MigrationMeeting) -> ImportedMeetingNote {
    let transcript = meeting
        .transcript
        .into_iter()
        .map(|segment| TranscriptSegment {
            speaker: segment.speaker,
            text: segment.text,
            is_final: segment.is_final,
            timestamp: segment.timestamp,
        })
        .collect::<Vec<_>>();
    let action_items = meeting
        .action_items
        .into_iter()
        .map(|item| ActionItem {
            text: item.text,
            owner: item.owner,
            id: item.id,
            status: item.status,
            due_at: item.due_at,
            completed_at: item.completed_at,
        })
        .collect::<Vec<_>>();
    let summary = meeting.summary.filter(|text| !text.trim().is_empty());
    let summary = (summary.is_some() || !action_items.is_empty()).then(|| Summary {
        summary: summary.unwrap_or_default(),
        action_items,
    });
    ImportedMeetingNote {
        id: meeting.id,
        workspace_import: false,
        title: meeting.title,
        started_at: meeting.started_at,
        ended_at: meeting.ended_at,
        extension_source_status: meeting.status,
        mode: meeting.mode.unwrap_or_default(),
        transcript,
        summary,
    }
}

/// Imports the streamed `.ntarchive` format produced by Chrome Settings.
/// The archive remains on disk as the user's backup; imported meetings are
/// committed one at a time so retries safely skip completed entries.
pub fn import_audio_archive_file(
    path: &Path,
    store: &MeetingStore,
) -> Result<(MigrationImportReport, MigrationSettings), String> {
    let metadata =
        fs::metadata(path).map_err(|_| "The selected archive could not be read.".to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_AUDIO_ARCHIVE_BYTES {
        return Err("The audio archive is invalid or larger than 50 GB.".into());
    }
    let file =
        File::open(path).map_err(|_| "The selected archive could not be opened.".to_string())?;
    import_audio_archive(file, store)
}

fn import_audio_archive<R: Read>(
    mut reader: R,
    store: &MeetingStore,
) -> Result<(MigrationImportReport, MigrationSettings), String> {
    let mut header = [0_u8; 12];
    reader
        .read_exact(&mut header)
        .map_err(|_| "This is not a complete AI Notetaker audio archive.".to_string())?;
    if &header[..8] != AUDIO_ARCHIVE_MAGIC {
        return Err("This is not a supported AI Notetaker audio archive.".into());
    }
    let manifest_len = u32::from_le_bytes(header[8..12].try_into().unwrap()) as usize;
    if manifest_len == 0 || manifest_len > MAX_AUDIO_MANIFEST_BYTES {
        return Err("The audio archive manifest is invalid or too large.".into());
    }
    let mut manifest_bytes = vec![0_u8; manifest_len];
    reader
        .read_exact(&mut manifest_bytes)
        .map_err(|_| "The audio archive ended inside its manifest.".to_string())?;
    let manifest: AudioTransferManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|_| "The audio archive manifest is invalid.".to_string())?;
    if manifest.format != "ai-notetaker-desktop-audio-transfer"
        || manifest.version != 1
        || manifest.sample_rate_hz != 48_000
    {
        return Err("This audio archive version is not supported.".into());
    }
    validate_archive(&manifest.notes)?;
    if manifest.audio_meeting_ids.len() > MAX_MEETINGS {
        return Err("The audio archive contains too many recordings.".into());
    }
    let meeting_ids: HashSet<Uuid> = manifest
        .notes
        .meetings
        .iter()
        .map(|meeting| meeting.id)
        .collect();
    let audio_ids: HashSet<Uuid> = manifest.audio_meeting_ids.iter().copied().collect();
    if audio_ids.len() != manifest.audio_meeting_ids.len() || !audio_ids.is_subset(&meeting_ids) {
        return Err("The audio archive has inconsistent meeting references.".into());
    }
    let imported_settings = manifest.notes.settings.clone();
    let imported_sample_rate_hz = manifest.sample_rate_hz;
    let temp_root = tempfile::Builder::new()
        .prefix("ai-notetaker-import-")
        .tempdir()
        .map_err(|_| "Temporary space is unavailable for this import.".to_string())?;
    let mut previous_sequence: HashMap<(Uuid, u8), u64> = HashMap::new();
    let mut audio_tracks: HashMap<(Uuid, u8), PathBuf> = HashMap::new();
    let mut audio_bytes_by_meeting: HashMap<Uuid, u64> = HashMap::new();
    let mut chunk_count = 0_u64;
    let mut audio_bytes = 0_u64;
    loop {
        let mut kind = [0_u8; 1];
        reader
            .read_exact(&mut kind)
            .map_err(|_| "The audio archive is missing its end marker.".to_string())?;
        if kind[0] == 0xff {
            let mut count = [0_u8; 8];
            reader
                .read_exact(&mut count)
                .map_err(|_| "The audio archive has an incomplete end marker.".to_string())?;
            if u64::from_le_bytes(count) != chunk_count {
                return Err("The audio archive chunk count does not match its contents.".into());
            }
            let mut trailing = [0_u8; 1];
            if reader
                .read(&mut trailing)
                .map_err(|_| "The audio archive could not be checked.".to_string())?
                != 0
            {
                return Err("The audio archive contains unexpected trailing data.".into());
            }
            break;
        }
        if kind[0] != 1 {
            return Err("The audio archive contains an unknown record.".into());
        }
        let mut frame = [0_u8; 61];
        reader
            .read_exact(&mut frame)
            .map_err(|_| "The audio archive contains an incomplete audio record.".to_string())?;
        let id_text = std::str::from_utf8(&frame[..36])
            .map_err(|_| "The audio archive has an invalid meeting id.".to_string())?;
        let meeting_id = Uuid::parse_str(id_text)
            .map_err(|_| "The audio archive has an invalid meeting id.".to_string())?;
        let channel = frame[36];
        if channel > 1 || !audio_ids.contains(&meeting_id) {
            return Err(
                "The audio archive has an invalid audio channel or meeting reference.".into(),
            );
        }
        let sequence = u64::from_le_bytes(frame[37..45].try_into().unwrap());
        let _captured_at_ms = u64::from_le_bytes(frame[45..53].try_into().unwrap());
        let length = u32::from_le_bytes(frame[53..57].try_into().unwrap());
        let expected_crc = u32::from_le_bytes(frame[57..61].try_into().unwrap());
        if length == 0 || length > MAX_AUDIO_CHUNK_BYTES || length % 2 != 0 {
            return Err("The audio archive contains an invalid PCM chunk.".into());
        }
        let key = (meeting_id, channel);
        if previous_sequence
            .get(&key)
            .is_some_and(|previous| sequence <= *previous)
        {
            return Err("The audio archive contains duplicated or out-of-order audio.".into());
        }
        previous_sequence.insert(key, sequence);
        chunk_count += 1;
        audio_bytes = audio_bytes
            .checked_add(length as u64)
            .ok_or_else(|| "The audio archive is too large.".to_string())?;
        *audio_bytes_by_meeting.entry(meeting_id).or_default() += length as u64;
        if chunk_count > MAX_AUDIO_CHUNKS || audio_bytes > MAX_AUDIO_ARCHIVE_BYTES {
            return Err("The audio archive exceeds import limits.".into());
        }
        let track_path = audio_tracks
            .entry(key)
            .or_insert_with(|| {
                temp_root.path().join(format!(
                    "{}-{}.pcm",
                    meeting_id,
                    if channel == 0 { "mic" } else { "speaker" }
                ))
            })
            .clone();
        let mut track = OpenOptions::new()
            .create(true)
            .append(true)
            .open(track_path)
            .map_err(|_| "Temporary space is unavailable for this audio import.".to_string())?;
        let mut remaining = length as u64;
        let mut buffer = [0_u8; 64 * 1024];
        let mut checksum = crc32fast::Hasher::new();
        while remaining > 0 {
            let count = usize::try_from(remaining.min(buffer.len() as u64)).unwrap();
            reader
                .read_exact(&mut buffer[..count])
                .map_err(|_| "The audio archive ended inside an audio chunk.".to_string())?;
            checksum.update(&buffer[..count]);
            track
                .write_all(&buffer[..count])
                .map_err(|_| "Temporary space ran out while importing audio.".to_string())?;
            remaining -= count as u64;
        }
        if checksum.finalize() != expected_crc {
            return Err("The audio archive contains a damaged audio chunk.".into());
        }
    }
    if audio_tracks.is_empty() && !audio_ids.is_empty() {
        return Err("The audio archive lists recordings but contains no audio.".into());
    }
    for id in &audio_ids {
        if !audio_tracks.keys().any(|(meeting_id, _)| meeting_id == id) {
            return Err("The audio archive is missing one of its recordings.".into());
        }
    }
    let mut report = MigrationImportReport {
        imported: 0,
        already_present: 0,
        preferences_imported: true,
        audio_imported: 0,
        audio_bytes: 0,
    };
    for meeting in manifest.notes.meetings {
        let id = meeting.id;
        let mic = audio_tracks.get(&(id, 0)).map(PathBuf::as_path);
        let speaker = audio_tracks.get(&(id, 1)).map(PathBuf::as_path);
        let imported = if mic.is_some() || speaker.is_some() {
            store.import_note_with_audio(
                into_imported_note(meeting),
                mic,
                speaker,
                imported_sample_rate_hz,
            )
        } else {
            store.import_text_only_note(into_imported_note(meeting))
        }.map_err(|_| "A meeting could not be written to the desktop library. Retry the archive; already imported meetings will be skipped.".to_string())?;
        if imported {
            report.imported += 1;
            if let Some(bytes) = audio_bytes_by_meeting.get(&id) {
                report.audio_imported += 1;
                report.audio_bytes += bytes;
            }
        } else {
            report.already_present += 1;
        }
    }
    Ok((report, imported_settings))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use chrono::TimeZone;
    use notetaker_core::storage::MeetingState;
    use tempfile::tempdir;

    fn archive_json(id: Uuid) -> String {
        serde_json::json!({
            "format": "ai-notetaker-desktop-transfer",
            "version": 1,
            "exportedAt": "2026-10-03T12:00:00Z",
            "settings": {
                "transcriptionProvider": "deepgram",
                "summarizationProvider": "claude",
                "defaultMeetingMode": "general",
                "customVocabulary": ["Acme"],
                "customSummaryInstructions": "Focus on decisions."
            },
            "meetings": [{
                "id": id,
                "title": "Planning",
                "startedAt": "2026-10-01T10:00:00Z",
                "endedAt": "2026-10-01T10:30:00Z",
                "mode": "standup",
                "status": "complete",
                "transcript": [{"speaker":"you","text":"Ship it","timestamp":"2026-10-01T10:10:00Z","isFinal":true}],
                "summary": "Ship the desktop app.",
                "actionItems": [{"text":"Publish installers","owner":"Team","id":"action-1","status":"done","dueAt":"2026-10-02T10:00:00Z","completedAt":"2026-10-02T09:00:00Z"}]
            }]
        }).to_string()
    }

    #[test]
    fn import_writes_completed_note_and_is_idempotent() {
        let temp = tempdir().unwrap();
        let store = MeetingStore::new(temp.path()).unwrap();
        let id = Uuid::new_v4();
        let archive = parse_archive_json(&archive_json(id)).unwrap();

        let first = import_archive(archive, &store).unwrap();
        let second =
            import_archive(parse_archive_json(&archive_json(id)).unwrap(), &store).unwrap();

        assert_eq!(first.imported, 1);
        assert_eq!(second.already_present, 1);
        let meta = store.load_meta(id).unwrap();
        assert_eq!(meta.state, MeetingState::Processed);
        assert!(meta.text_only_import);
        assert_eq!(meta.title.as_deref(), Some("Planning"));
        assert_eq!(store.load_transcript(id).unwrap()[0].text, "Ship it");
        assert_eq!(
            store.load_transcript(id).unwrap()[0].timestamp.as_deref(),
            Some("2026-10-01T10:10:00Z")
        );
        assert_eq!(
            store.load_summary(id).unwrap().unwrap().action_items[0].text,
            "Publish installers"
        );
        assert_eq!(
            store.load_summary(id).unwrap().unwrap().action_items[0]
                .id
                .as_deref(),
            Some("action-1")
        );
        assert_eq!(
            store.load_summary(id).unwrap().unwrap().action_items[0]
                .status
                .as_deref(),
            Some("done")
        );
        assert_eq!(
            meta.started_at,
            Utc.with_ymd_and_hms(2026, 10, 1, 10, 0, 0).unwrap()
        );
        assert!(!temp
            .path()
            .join("meetings")
            .join(id.to_string())
            .join("mic.pcm")
            .exists());
    }

    #[test]
    fn accepts_saved_recorder_audio_state() {
        let id = Uuid::new_v4();
        let transfer = archive_json(id).replace("\"status\":\"complete\"", "\"status\":\"saved\"");
        let archive = parse_archive_json(&transfer).unwrap();
        assert_eq!(archive.meetings[0].status, "saved");
    }

    #[test]
    fn rejects_secret_fields_and_imports_partial_text_without_audio() {
        let id = Uuid::new_v4();
        let with_secret = archive_json(id).replace(
            "\"customVocabulary\"",
            "\"apiKeys\":{\"deepgram\":\"secret\"},\"customVocabulary\"",
        );
        assert!(parse_archive_json(&with_secret).is_err());
        let unfinished = archive_json(id)
            .replace("\"status\":\"complete\"", "\"status\":\"processing\"")
            .replace("\"endedAt\":\"2026-10-01T10:30:00Z\"", "\"endedAt\":null");
        let temp = tempdir().unwrap();
        let store = MeetingStore::new(temp.path()).unwrap();
        let report = import_archive(parse_archive_json(&unfinished).unwrap(), &store).unwrap();
        assert_eq!(report.imported, 1);
        let meta = store.load_meta(id).unwrap();
        assert_eq!(meta.ended_at, None);
        assert_eq!(meta.extension_source_status.as_deref(), Some("processing"));
        assert_eq!(store.load_transcript(id).unwrap()[0].text, "Ship it");
        assert!(!temp
            .path()
            .join("meetings")
            .join(id.to_string())
            .join("mic.pcm")
            .exists());

        let invalid_complete =
            unfinished.replace("\"status\":\"processing\"", "\"status\":\"complete\"");
        assert!(parse_archive_json(&invalid_complete).is_err());
    }

    #[test]
    fn enforces_archive_size_limit() {
        let source = " ".repeat(MAX_ARCHIVE_BYTES + 1);
        assert!(parse_archive_json(&source).unwrap_err().contains("20 MB"));
    }

    fn audio_archive_bytes(id: Uuid) -> Vec<u8> {
        let notes = serde_json::from_str::<serde_json::Value>(&archive_json(id)).unwrap();
        let manifest = serde_json::to_vec(&serde_json::json!({
            "format": "ai-notetaker-desktop-audio-transfer",
            "version": 1,
            "sampleRateHz": 48000,
            "notes": notes,
            "audioMeetingIds": [id],
        }))
        .unwrap();
        let mut result = AUDIO_ARCHIVE_MAGIC.to_vec();
        result.extend_from_slice(&(manifest.len() as u32).to_le_bytes());
        result.extend_from_slice(&manifest);
        for (channel, sequence, bytes) in [(0_u8, 0_u64, [1_u8, 2, 3, 4]), (1, 1, [5, 6, 7, 8])] {
            result.push(1);
            result.extend_from_slice(id.to_string().as_bytes());
            result.push(channel);
            result.extend_from_slice(&sequence.to_le_bytes());
            result.extend_from_slice(&1_791_000_000_000_u64.to_le_bytes());
            result.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
            result.extend_from_slice(&crc32fast::hash(&bytes).to_le_bytes());
            result.extend_from_slice(&bytes);
        }
        result.push(0xff);
        result.extend_from_slice(&2_u64.to_le_bytes());
        result
    }

    #[test]
    fn streams_audio_archive_into_separate_local_tracks_and_is_idempotent() {
        let temp = tempdir().unwrap();
        let store = MeetingStore::new(temp.path()).unwrap();
        let id = Uuid::parse_str("2f6dd7bf-1f39-4a7c-a7a7-43c4c46d1c36").unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(
                include_str!("../../../../extension/test-fixtures/desktop-audio-transfer-v1.b64")
                    .trim(),
            )
            .unwrap();

        let (report, settings) = import_audio_archive(bytes.as_slice(), &store).unwrap();
        assert_eq!(report.imported, 1);
        assert_eq!(report.audio_imported, 1);
        assert_eq!(report.audio_bytes, 6);
        assert!(settings.custom_vocabulary.is_empty());
        let meta = store.load_meta(id).unwrap();
        assert!(!meta.text_only_import);
        assert_eq!(meta.extension_source_status.as_deref(), Some("complete"));
        assert_eq!(
            std::fs::read(store.audio_path(id, "mic.pcm")).unwrap(),
            [1, 2, 5, 6]
        );
        assert_eq!(
            std::fs::read(store.audio_path(id, "speaker.pcm")).unwrap(),
            [3, 4]
        );
        assert_eq!(store.load_transcript(id).unwrap()[0].text, "Ship it");
        assert_eq!(
            store.load_summary(id).unwrap().unwrap().summary,
            "Ship the desktop app."
        );
        assert_eq!(
            store.load_summary(id).unwrap().unwrap().action_items[0].text,
            "Publish installers"
        );

        let (second, _) = import_audio_archive(bytes.as_slice(), &store).unwrap();
        assert_eq!(second.already_present, 1);
        assert_eq!(second.audio_imported, 0);
        assert_eq!(
            std::fs::read(store.audio_path(id, "mic.pcm")).unwrap(),
            [1, 2, 5, 6]
        );
    }

    #[test]
    fn audio_archive_rejects_truncation_unknown_meetings_and_bad_chunk_count() {
        let id = Uuid::new_v4();
        let mut truncated = audio_archive_bytes(id);
        truncated.pop();
        let temp = tempdir().unwrap();
        let store = MeetingStore::new(temp.path()).unwrap();
        assert!(import_audio_archive(truncated.as_slice(), &store)
            .unwrap_err()
            .contains("end marker"));

        let mut bad_count = audio_archive_bytes(id);
        let end = bad_count.len() - 8;
        bad_count[end..].copy_from_slice(&3_u64.to_le_bytes());
        assert!(import_audio_archive(bad_count.as_slice(), &store)
            .unwrap_err()
            .contains("chunk count"));

        let mut unknown = audio_archive_bytes(id);
        let notes_len = u32::from_le_bytes(unknown[8..12].try_into().unwrap()) as usize;
        let first_id = 12 + notes_len + 1;
        unknown[first_id] = if unknown[first_id] == b'0' {
            b'1'
        } else {
            b'0'
        };
        assert!(import_audio_archive(unknown.as_slice(), &store)
            .unwrap_err()
            .contains("meeting reference"));

        let mut damaged_audio = audio_archive_bytes(id);
        let manifest_size = u32::from_le_bytes(damaged_audio[8..12].try_into().unwrap()) as usize;
        damaged_audio[12 + manifest_size + 62] ^= 0x01;
        assert!(import_audio_archive(damaged_audio.as_slice(), &store)
            .unwrap_err()
            .contains("damaged audio"));
    }
}
