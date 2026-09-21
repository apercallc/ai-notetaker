//! Groq (Whisper Large-v3 Turbo) transcription provider — budget tier.
//!
//! Batch-only by nature (Whisper has no diarization and Groq exposes no
//! streaming endpoint for it) — this is the documented trade-off from the
//! architecture spec's cost table: cheaper, but no per-speaker labeling on
//! the "them" side and no true live partials.

use super::{
    provider_client, AudioChannel, AudioChunk, ProviderError, TranscriptSegment,
    TranscriptionProvider,
};
use crate::native_messaging::TranscriptionProviderId;
use async_trait::async_trait;
use serde_json::Value;

const GROQ_TRANSCRIPTIONS_URL: &str = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODELS_URL: &str = "https://api.groq.com/openai/v1/models";

pub async fn test_key(key: &str) -> Result<(), ProviderError> {
    test_key_at(GROQ_MODELS_URL, key).await
}

async fn test_key_at(url: &str, key: &str) -> Result<(), ProviderError> {
    super::bearer_auth_test_key(url, key, "groq").await
}

pub struct GroqProvider {
    api_key: String,
    client: reqwest::Client,
    base_url: String,
}

impl GroqProvider {
    pub fn new(api_key: String) -> Self {
        Self {
            api_key,
            client: provider_client(),
            base_url: GROQ_TRANSCRIPTIONS_URL.to_string(),
        }
    }

    #[cfg(test)]
    fn with_base_url(api_key: String, base_url: String) -> Self {
        Self {
            api_key,
            client: provider_client(),
            base_url,
        }
    }
}

#[async_trait]
impl TranscriptionProvider for GroqProvider {
    fn id(&self) -> TranscriptionProviderId {
        TranscriptionProviderId::Groq
    }

    fn is_streaming(&self) -> bool {
        false
    }

    async fn transcribe_chunk(
        &self,
        chunk: &AudioChunk,
    ) -> Result<Vec<TranscriptSegment>, ProviderError> {
        // Whisper's API expects a decodable audio file, not bare PCM; a real
        // implementation wraps chunk.pcm16 in a minimal WAV container here.
        // That wrapping is a pure, easily-testable function in its own
        // right — kept out of scope for this pass, see the helper
        // implementation report for what's left.
        let wav_bytes = crate::audio_container::pcm16_to_wav(&chunk.pcm16, chunk.sample_rate_hz);

        let part = reqwest::multipart::Part::bytes(wav_bytes)
            .file_name("chunk.wav")
            .mime_str("audio/wav")
            .map_err(|e| ProviderError::BadResponse(e.to_string()))?;
        let form = reqwest::multipart::Form::new()
            .part("file", part)
            .text("model", "whisper-large-v3-turbo")
            .text("response_format", "json");

        let response = self
            .client
            .post(&self.base_url)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .multipart(form)
            .send()
            .await
            .map_err(|e| ProviderError::Unreachable(e.to_string()))?;

        let status = response.status();
        if status == 401 || status == 403 {
            return Err(ProviderError::AuthFailed(format!("groq returned {status}")));
        }
        if status == 429 {
            let retry_after = response
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok());
            return Err(ProviderError::RateLimited {
                retry_after_secs: retry_after,
            });
        }
        if !status.is_success() {
            return Err(ProviderError::Unreachable(format!(
                "groq returned {status}"
            )));
        }

        let body: Value = response
            .json()
            .await
            .map_err(|e| ProviderError::BadResponse(e.to_string()))?;
        parse_response(&body, chunk.channel)
    }
}

fn parse_response(
    body: &Value,
    channel: AudioChannel,
) -> Result<Vec<TranscriptSegment>, ProviderError> {
    let text = body
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| ProviderError::BadResponse("missing text field".into()))?
        .trim()
        .to_string();

    if text.is_empty() {
        return Ok(vec![]);
    }

    let speaker = if channel == AudioChannel::Mic {
        "you"
    } else {
        "them"
    };
    Ok(vec![TranscriptSegment {
        speaker: speaker.into(),
        text,
        is_final: true,
    }])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::matchers::{header, method};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn test_key_succeeds_on_2xx() {
        let mock_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(header("Authorization", "Bearer good-key"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&mock_server)
            .await;
        assert!(test_key_at(&mock_server.uri(), "good-key").await.is_ok());
    }

    #[tokio::test]
    async fn test_key_reports_auth_failed_on_401() {
        let mock_server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&mock_server)
            .await;
        let err = test_key_at(&mock_server.uri(), "bad-key")
            .await
            .unwrap_err();
        assert!(matches!(err, ProviderError::AuthFailed(_)));
    }

    #[test]
    fn parses_text_field_for_mic_channel() {
        let body = json!({ "text": "  hello from mic  " });
        let segments = parse_response(&body, AudioChannel::Mic).unwrap();
        assert_eq!(
            segments,
            vec![TranscriptSegment {
                speaker: "you".into(),
                text: "hello from mic".into(),
                is_final: true
            }]
        );
    }

    #[test]
    fn speaker_channel_has_no_diarization_labels_them_plainly() {
        let body = json!({ "text": "hello from the room" });
        let segments = parse_response(&body, AudioChannel::Speaker).unwrap();
        assert_eq!(segments[0].speaker, "them");
    }

    #[test]
    fn empty_text_yields_no_segments() {
        let body = json!({ "text": "   " });
        assert_eq!(parse_response(&body, AudioChannel::Mic).unwrap(), vec![]);
    }

    #[test]
    fn missing_text_field_is_bad_response() {
        let body = json!({ "unexpected": true });
        assert!(matches!(
            parse_response(&body, AudioChannel::Mic).unwrap_err(),
            ProviderError::BadResponse(_)
        ));
    }

    #[tokio::test]
    async fn sends_bearer_auth_and_parses_success() {
        let mock_server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(header("Authorization", "Bearer test-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "text": "mocked" })))
            .mount(&mock_server)
            .await;

        let provider = GroqProvider::with_base_url("test-key".into(), mock_server.uri());
        let chunk = AudioChunk {
            channel: AudioChannel::Mic,
            pcm16: vec![0, 0],
            sample_rate_hz: 16000,
        };
        let segments = provider.transcribe_chunk(&chunk).await.unwrap();
        assert_eq!(segments[0].text, "mocked");
    }

    #[tokio::test]
    async fn maps_403_to_auth_failed() {
        let mock_server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(403))
            .mount(&mock_server)
            .await;

        let provider = GroqProvider::with_base_url("bad".into(), mock_server.uri());
        let chunk = AudioChunk {
            channel: AudioChannel::Mic,
            pcm16: vec![0, 0],
            sample_rate_hz: 16000,
        };
        assert!(matches!(
            provider.transcribe_chunk(&chunk).await.unwrap_err(),
            ProviderError::AuthFailed(_)
        ));
    }
}
