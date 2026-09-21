//! Wire protocol for extension <-> helper, per docs/native-messaging-protocol.md.
//!
//! Framing follows Chrome's Native Messaging spec: each message is a JSON
//! object preceded by a 4-byte little-endian message length, matching the
//! protocol contract in `docs/native-messaging-protocol.md`.

use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};
use uuid::Uuid;

/// Chrome will refuse to launch a native message exceeding 1 MiB when sent
/// *to* the extension, and the host must refuse anything absurd coming in.
/// Audio itself never flows over this channel (only transcript text and
/// control messages), so this ceiling is generous headroom, not a tight fit.
pub const MAX_MESSAGE_BYTES: u32 = 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum FramingError {
    #[error("io error: {0}")]
    Io(#[from] io::Error),
    #[error("message of {0} bytes exceeds the {MAX_MESSAGE_BYTES}-byte limit")]
    TooLarge(u32),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("stream closed")]
    Eof,
}

pub fn read_message<R: Read>(reader: &mut R) -> Result<ExtensionToHelper, FramingError> {
    let mut len_buf = [0u8; 4];
    match reader.read_exact(&mut len_buf) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Err(FramingError::Eof),
        Err(e) => return Err(e.into()),
    }
    let len = u32::from_le_bytes(len_buf);
    if len > MAX_MESSAGE_BYTES {
        return Err(FramingError::TooLarge(len));
    }
    let mut payload = vec![0u8; len as usize];
    reader.read_exact(&mut payload)?;
    let msg = serde_json::from_slice(&payload)?;
    Ok(msg)
}

pub fn write_message<W: Write>(
    writer: &mut W,
    msg: &HelperToExtension,
) -> Result<(), FramingError> {
    let payload = serde_json::to_vec(msg)?;
    if payload.len() as u64 > MAX_MESSAGE_BYTES as u64 {
        return Err(FramingError::TooLarge(payload.len() as u32));
    }
    writer.write_all(&(payload.len() as u32).to_le_bytes())?;
    writer.write_all(&payload)?;
    writer.flush()?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ExtensionToHelper {
    Hello {
        #[serde(rename = "pairingToken")]
        pairing_token: Option<String>,
    },
    Settings {
        #[serde(rename = "transcriptionProvider")]
        transcription_provider: TranscriptionProviderId,
        #[serde(rename = "summarizationProvider")]
        summarization_provider: SummarizationProviderId,
        #[serde(rename = "apiKeys")]
        api_keys: ApiKeys,
        webapp: Option<WebappConfig>,
        #[serde(rename = "defaultMeetingMode", default)]
        default_meeting_mode: MeetingMode,
        #[serde(default)]
        custom_vocabulary: Vec<String>,
        #[serde(rename = "customSummaryInstructions", default)]
        custom_summary_instructions: Option<String>,
    },
    StartRecording {
        #[serde(rename = "meetingId")]
        meeting_id: Uuid,
        #[serde(rename = "meetingMode", default)]
        meeting_mode: MeetingMode,
    },
    StopRecording {
        #[serde(rename = "meetingId")]
        meeting_id: Uuid,
    },
    ResumeRecording {
        #[serde(rename = "meetingId")]
        meeting_id: Uuid,
    },
    DiscardRecording {
        #[serde(rename = "meetingId")]
        meeting_id: Uuid,
    },
    TestProviderKey {
        provider: ProviderKind,
        key: String,
    },
    AudioPreflight,
    AudioProbe,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HelperToExtension {
    Paired {
        #[serde(rename = "pairingToken")]
        pairing_token: String,
    },
    RecordingStarted {
        #[serde(rename = "meetingId")]
        meeting_id: Uuid,
    },
    RecordingStopped {
        #[serde(rename = "meetingId")]
        meeting_id: Uuid,
    },
    TranscriptPartial {
        #[serde(rename = "meetingId")]
        meeting_id: Uuid,
        speaker: String,
        text: String,
        #[serde(rename = "isFinal")]
        is_final: bool,
    },
    SummaryReady {
        #[serde(rename = "meetingId")]
        meeting_id: Uuid,
        summary: String,
        #[serde(rename = "actionItems")]
        action_items: Vec<ActionItem>,
    },
    Error {
        #[serde(rename = "meetingId")]
        meeting_id: Option<Uuid>,
        code: ErrorCode,
        message: String,
    },
    RecoveredRecording {
        #[serde(rename = "meetingId")]
        meeting_id: Uuid,
        #[serde(rename = "startedAt")]
        started_at: chrono::DateTime<chrono::Utc>,
    },
    ProviderKeyTestResult {
        provider: ProviderKind,
        valid: bool,
        message: String,
    },
    AudioStatus {
        platform: String,
        driver: String,
        #[serde(rename = "driverInstalled")]
        driver_installed: bool,
        microphone: Option<String>,
        speaker: Option<String>,
        ready: bool,
        guidance: String,
    },
    AudioProbeResult {
        #[serde(rename = "micFrames")]
        mic_frames: u64,
        #[serde(rename = "speakerFrames")]
        speaker_frames: u64,
        passed: bool,
        message: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum MeetingMode {
    #[default]
    General,
    Standup,
    Sales,
    OneOnOne,
    Interview,
    Custom,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptionProviderId {
    Deepgram,
    Groq,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SummarizationProviderId {
    Claude,
    Gemini,
    Deepseek,
}

/// The union of every provider a key can be tested against — wider than
/// `TranscriptionProviderId`/`SummarizationProviderId` individually, since
/// `test_provider_key` doesn't know or care which role a key is for.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    Deepgram,
    Groq,
    Claude,
    Gemini,
    Deepseek,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ApiKeys {
    pub deepgram: Option<String>,
    pub claude: Option<String>,
    pub groq: Option<String>,
    pub gemini: Option<String>,
    pub deepseek: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WebappConfig {
    pub url: String,
    pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ActionItem {
    pub text: String,
    pub owner: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    ProviderAuthFailed,
    ProviderRateLimited,
    ProviderUnreachable,
    DeviceNotFound,
    HelperNotPaired,
}

/// Generates a new pairing token. Per the protocol doc, this is sent to the
/// extension exactly once (the "paired" message on first-ever connection)
/// and stored by the extension for every subsequent `hello`.
pub fn generate_pairing_token() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let bytes: [u8; 32] = rng.gen();
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn round_trips_hello_message() {
        let msg = ExtensionToHelper::Hello {
            pairing_token: Some("abc123".to_string()),
        };
        let json = serde_json::to_vec(&msg).unwrap();
        let mut framed = Vec::new();
        framed.extend_from_slice(&(json.len() as u32).to_le_bytes());
        framed.extend_from_slice(&json);

        let mut cursor = Cursor::new(framed);
        let decoded = read_message(&mut cursor).unwrap();
        assert_eq!(decoded, msg);
    }

    #[test]
    fn round_trips_settings_message_with_all_fields() {
        let msg = ExtensionToHelper::Settings {
            transcription_provider: TranscriptionProviderId::Deepgram,
            summarization_provider: SummarizationProviderId::Claude,
            api_keys: ApiKeys {
                deepgram: Some("dg-key".into()),
                claude: Some("claude-key".into()),
                groq: None,
                gemini: None,
                deepseek: None,
            },
            webapp: Some(WebappConfig {
                url: "https://example.com".into(),
                token: "tok".into(),
            }),
            default_meeting_mode: MeetingMode::General,
            custom_vocabulary: vec![],
            custom_summary_instructions: None,
        };
        let json = serde_json::to_vec(&msg).unwrap();
        let mut framed = Vec::new();
        framed.extend_from_slice(&(json.len() as u32).to_le_bytes());
        framed.extend_from_slice(&json);
        let mut cursor = Cursor::new(framed);
        let decoded = read_message(&mut cursor).unwrap();
        assert_eq!(decoded, msg);
    }

    #[test]
    fn write_then_read_helper_to_extension_message() {
        let msg = HelperToExtension::TranscriptPartial {
            meeting_id: Uuid::nil(),
            speaker: "you".into(),
            text: "hello world".into(),
            is_final: false,
        };
        let mut buf = Vec::new();
        write_message(&mut buf, &msg).unwrap();

        // Manually parse it back using the extension-side framing rules to
        // prove both directions agree on the wire format.
        let len = u32::from_le_bytes(buf[0..4].try_into().unwrap());
        assert_eq!(len as usize, buf.len() - 4);
        let decoded: HelperToExtension = serde_json::from_slice(&buf[4..]).unwrap();
        assert_eq!(decoded, msg);
    }

    #[test]
    fn rejects_oversized_message_length_prefix() {
        let mut framed = Vec::new();
        framed.extend_from_slice(&(MAX_MESSAGE_BYTES + 1).to_le_bytes());
        let mut cursor = Cursor::new(framed);
        let err = read_message(&mut cursor).unwrap_err();
        assert!(matches!(err, FramingError::TooLarge(_)));
    }

    #[test]
    fn eof_on_empty_stream_is_reported_distinctly() {
        let mut cursor = Cursor::new(Vec::<u8>::new());
        let err = read_message(&mut cursor).unwrap_err();
        assert!(matches!(err, FramingError::Eof));
    }

    #[test]
    fn round_trips_test_provider_key_message() {
        let msg = ExtensionToHelper::TestProviderKey {
            provider: ProviderKind::Deepgram,
            key: "abc".into(),
        };
        let json = serde_json::to_vec(&msg).unwrap();
        let mut framed = Vec::new();
        framed.extend_from_slice(&(json.len() as u32).to_le_bytes());
        framed.extend_from_slice(&json);
        let mut cursor = Cursor::new(framed);
        assert_eq!(read_message(&mut cursor).unwrap(), msg);
    }

    #[test]
    fn round_trips_provider_key_test_result_message() {
        let msg = HelperToExtension::ProviderKeyTestResult {
            provider: ProviderKind::Claude,
            valid: true,
            message: "Claude key is valid.".into(),
        };
        let mut buf = Vec::new();
        write_message(&mut buf, &msg).unwrap();
        let decoded: HelperToExtension = serde_json::from_slice(&buf[4..]).unwrap();
        assert_eq!(decoded, msg);
    }

    #[test]
    fn pairing_tokens_are_unique_and_hex_encoded() {
        let a = generate_pairing_token();
        let b = generate_pairing_token();
        assert_ne!(a, b);
        assert_eq!(a.len(), 64); // 32 bytes -> 64 hex chars
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
