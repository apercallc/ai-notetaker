//! Deepgram transcription provider — default tier.
//!
//! Implemented against Deepgram's synchronous prerecorded (batch) REST
//! endpoint (`POST /v1/listen`), not the live-streaming WebSocket endpoint
//! the architecture spec names as the eventual default — see the scope note
//! in `providers/mod.rs` for why, and what swapping to streaming later
//! would touch (only this file).

use super::{AudioChannel, AudioChunk, ProviderError, TranscriptSegment, TranscriptionProvider};
use crate::native_messaging::TranscriptionProviderId;
use async_trait::async_trait;
use serde_json::Value;

const DEEPGRAM_LISTEN_URL: &str = "https://api.deepgram.com/v1/listen";
const DEEPGRAM_PROJECTS_URL: &str = "https://api.deepgram.com/v1/projects";

pub struct DeepgramProvider {
    api_key: String,
    client: reqwest::Client,
    base_url: String,
}

impl DeepgramProvider {
    pub fn new(api_key: String) -> Self {
        Self {
            api_key,
            client: reqwest::Client::new(),
            base_url: DEEPGRAM_LISTEN_URL.to_string(),
        }
    }

    /// Test-only constructor pointing at a mock server instead of Deepgram's
    /// real API, so the request/response contract can be verified without
    /// live credentials or network access to Deepgram itself.
    #[cfg(test)]
    fn with_base_url(api_key: String, base_url: String) -> Self {
        Self { api_key, client: reqwest::Client::new(), base_url }
    }
}

#[async_trait]
impl TranscriptionProvider for DeepgramProvider {
    fn id(&self) -> TranscriptionProviderId {
        TranscriptionProviderId::Deepgram
    }

    fn is_streaming(&self) -> bool {
        false // see module-level scope note
    }

    async fn transcribe_chunk(&self, chunk: &AudioChunk) -> Result<Vec<TranscriptSegment>, ProviderError> {
        let response = self
            .client
            .post(&self.base_url)
            .header("Authorization", format!("Token {}", self.api_key))
            .header("Content-Type", "audio/l16")
            .query(&[
                ("encoding", "linear16".to_string()),
                ("sample_rate", chunk.sample_rate_hz.to_string()),
                ("channels", "1".to_string()),
                ("model", "nova-3".to_string()),
                ("punctuate", "true".to_string()),
                ("diarize", "true".to_string()),
            ])
            .body(chunk.pcm16.clone())
            .send()
            .await
            .map_err(|e| ProviderError::Unreachable(e.to_string()))?;

        let status = response.status();
        if status == 401 || status == 403 {
            return Err(ProviderError::AuthFailed(format!("deepgram returned {status}")));
        }
        if status == 429 {
            let retry_after = response
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok());
            return Err(ProviderError::RateLimited { retry_after_secs: retry_after });
        }
        if !status.is_success() {
            return Err(ProviderError::Unreachable(format!("deepgram returned {status}")));
        }

        let body: Value = response
            .json()
            .await
            .map_err(|e| ProviderError::BadResponse(e.to_string()))?;

        parse_response(&body, chunk.channel)
    }
}

/// Cheap, read-only call used purely to validate an API key (settings
/// page's "Test" button, routed through the helper per
/// docs/native-messaging-protocol.md rather than called from the extension).
pub async fn test_key(key: &str) -> Result<(), ProviderError> {
    test_key_at(DEEPGRAM_PROJECTS_URL, key).await
}

async fn test_key_at(url: &str, key: &str) -> Result<(), ProviderError> {
    let client = reqwest::Client::new();
    let response = client
        .get(url)
        .header("Authorization", format!("Token {key}"))
        .send()
        .await
        .map_err(|e| ProviderError::Unreachable(e.to_string()))?;
    let status = response.status();
    if status.is_success() {
        Ok(())
    } else if status == 401 || status == 403 {
        Err(ProviderError::AuthFailed(format!("deepgram returned {status}")))
    } else {
        Err(ProviderError::Unreachable(format!("deepgram returned {status}")))
    }
}

/// Pure parsing of Deepgram's `/v1/listen` response shape. Kept separate
/// from the network call so it's unit-testable with fixture JSON.
fn parse_response(body: &Value, channel: AudioChannel) -> Result<Vec<TranscriptSegment>, ProviderError> {
    let alternative = body
        .pointer("/results/channels/0/alternatives/0")
        .ok_or_else(|| ProviderError::BadResponse("missing results.channels[0].alternatives[0]".into()))?;

    let transcript = alternative
        .get("transcript")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    if transcript.is_empty() {
        return Ok(vec![]);
    }

    if channel == AudioChannel::Mic {
        // The mic channel is unambiguously "you" — no need to diarize our
        // own voice into multiple speakers.
        return Ok(vec![TranscriptSegment { speaker: "you".into(), text: transcript, is_final: true }]);
    }

    // Speaker channel: use word-level diarization to label each distinct
    // remote participant as "them", "them-2", "them-3", ...
    let words = alternative.get("words").and_then(Value::as_array);
    match words {
        Some(words) if !words.is_empty() && words[0].get("speaker").is_some() => {
            Ok(group_by_speaker(words))
        }
        _ => Ok(vec![TranscriptSegment { speaker: "them".into(), text: transcript, is_final: true }]),
    }
}

fn group_by_speaker(words: &[Value]) -> Vec<TranscriptSegment> {
    let mut segments: Vec<TranscriptSegment> = Vec::new();
    let mut current_speaker_idx: Option<i64> = None;
    let mut current_text = String::new();

    for word in words {
        let speaker_idx = word.get("speaker").and_then(Value::as_i64).unwrap_or(0);
        let punctuated = word
            .get("punctuated_word")
            .or_else(|| word.get("word"))
            .and_then(Value::as_str)
            .unwrap_or("");

        if Some(speaker_idx) != current_speaker_idx {
            if let Some(idx) = current_speaker_idx {
                segments.push(TranscriptSegment {
                    speaker: speaker_label(idx),
                    text: current_text.trim().to_string(),
                    is_final: true,
                });
            }
            current_speaker_idx = Some(speaker_idx);
            current_text = String::new();
        }
        current_text.push(' ');
        current_text.push_str(punctuated);
    }
    if let Some(idx) = current_speaker_idx {
        segments.push(TranscriptSegment {
            speaker: speaker_label(idx),
            text: current_text.trim().to_string(),
            is_final: true,
        });
    }
    segments
}

fn speaker_label(diarization_idx: i64) -> String {
    if diarization_idx == 0 {
        "them".to_string()
    } else {
        format!("them-{}", diarization_idx + 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::matchers::{header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn mic_chunk() -> AudioChunk {
        AudioChunk { channel: AudioChannel::Mic, pcm16: vec![0, 1, 2, 3], sample_rate_hz: 16000 }
    }

    fn speaker_chunk() -> AudioChunk {
        AudioChunk { channel: AudioChannel::Speaker, pcm16: vec![4, 5, 6, 7], sample_rate_hz: 16000 }
    }

    #[test]
    fn parses_simple_transcript_for_mic_channel() {
        let body = json!({
            "results": { "channels": [ { "alternatives": [ { "transcript": "hello there" } ] } ] }
        });
        let segments = parse_response(&body, AudioChannel::Mic).unwrap();
        assert_eq!(segments, vec![TranscriptSegment { speaker: "you".into(), text: "hello there".into(), is_final: true }]);
    }

    #[test]
    fn empty_transcript_yields_no_segments() {
        let body = json!({
            "results": { "channels": [ { "alternatives": [ { "transcript": "" } ] } ] }
        });
        assert_eq!(parse_response(&body, AudioChannel::Mic).unwrap(), vec![]);
    }

    #[test]
    fn diarizes_speaker_channel_into_multiple_labeled_segments() {
        let body = json!({
            "results": { "channels": [ { "alternatives": [ {
                "transcript": "hi there how are you",
                "words": [
                    { "word": "hi", "punctuated_word": "Hi", "speaker": 0 },
                    { "word": "there", "punctuated_word": "there,", "speaker": 0 },
                    { "word": "how", "punctuated_word": "How", "speaker": 1 },
                    { "word": "are", "punctuated_word": "are", "speaker": 1 },
                    { "word": "you", "punctuated_word": "you?", "speaker": 1 },
                ]
            } ] } ] }
        });
        let segments = parse_response(&body, AudioChannel::Speaker).unwrap();
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].speaker, "them");
        assert_eq!(segments[0].text, "Hi there,");
        assert_eq!(segments[1].speaker, "them-2");
        assert_eq!(segments[1].text, "How are you?");
    }

    #[test]
    fn speaker_channel_without_diarization_data_falls_back_to_plain_them() {
        let body = json!({
            "results": { "channels": [ { "alternatives": [ { "transcript": "just one voice" } ] } ] }
        });
        let segments = parse_response(&body, AudioChannel::Speaker).unwrap();
        assert_eq!(segments, vec![TranscriptSegment { speaker: "them".into(), text: "just one voice".into(), is_final: true }]);
    }

    #[test]
    fn missing_results_shape_is_a_bad_response_error() {
        let body = json!({ "unexpected": "shape" });
        let err = parse_response(&body, AudioChannel::Mic).unwrap_err();
        assert!(matches!(err, ProviderError::BadResponse(_)));
    }

    #[tokio::test]
    async fn sends_correct_request_and_parses_success_response() {
        let mock_server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/"))
            .and(header("Authorization", "Token test-key"))
            .and(query_param("encoding", "linear16"))
            .and(query_param("sample_rate", "16000"))
            .and(query_param("model", "nova-3"))
            .and(query_param("diarize", "true"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "results": { "channels": [ { "alternatives": [ { "transcript": "mocked transcript" } ] } ] }
            })))
            .mount(&mock_server)
            .await;

        let provider = DeepgramProvider::with_base_url("test-key".into(), format!("{}/", mock_server.uri()));
        let segments = provider.transcribe_chunk(&mic_chunk()).await.unwrap();
        assert_eq!(segments[0].text, "mocked transcript");
    }

    #[tokio::test]
    async fn maps_401_to_auth_failed_error() {
        let mock_server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&mock_server)
            .await;

        let provider = DeepgramProvider::with_base_url("bad-key".into(), format!("{}/", mock_server.uri()));
        let err = provider.transcribe_chunk(&speaker_chunk()).await.unwrap_err();
        assert!(matches!(err, ProviderError::AuthFailed(_)));
    }

    #[tokio::test]
    async fn test_key_succeeds_on_2xx() {
        let mock_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(header("Authorization", "Token good-key"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&mock_server)
            .await;
        assert!(test_key_at(&mock_server.uri(), "good-key").await.is_ok());
    }

    #[tokio::test]
    async fn test_key_reports_auth_failed_on_401() {
        let mock_server = MockServer::start().await;
        Mock::given(method("GET")).respond_with(ResponseTemplate::new(401)).mount(&mock_server).await;
        let err = test_key_at(&mock_server.uri(), "bad-key").await.unwrap_err();
        assert!(matches!(err, ProviderError::AuthFailed(_)));
    }

    #[tokio::test]
    async fn maps_429_to_rate_limited_with_retry_after() {
        let mock_server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(429).insert_header("retry-after", "12"))
            .mount(&mock_server)
            .await;

        let provider = DeepgramProvider::with_base_url("test-key".into(), format!("{}/", mock_server.uri()));
        let err = provider.transcribe_chunk(&mic_chunk()).await.unwrap_err();
        match err {
            ProviderError::RateLimited { retry_after_secs } => assert_eq!(retry_after_secs, Some(12)),
            other => panic!("expected RateLimited, got {other:?}"),
        }
    }
}
