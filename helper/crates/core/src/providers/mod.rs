//! Provider trait interfaces for BYOK transcription and summarization.
//!
//! Per `helper/CLAUDE.md` and the `notetaker-add-provider` skill: a new
//! provider must implement these traits and nothing else should need to
//! change in the pipeline/orchestration code.
//!
//! **Scope note on Deepgram (flagged deviation, see helper implementation
//! report):** the architecture spec calls for Deepgram's *live-streaming*
//! WebSocket endpoint as the production default. What's implemented here is
//! Deepgram's synchronous prerecorded (batch) REST endpoint instead, because
//! it's realistically testable with a mocked HTTP server in this
//! environment (no live API key, no WebSocket mock harness available). Both
//! shapes satisfy the same `TranscriptionProvider` trait below, so swapping
//! in the streaming client later touches only `deepgram.rs`, not the
//! pipeline — but until that swap happens, the "live partial transcript"
//! experience described in the spec does not yet exist for the default
//! provider (it currently behaves like the "budget" batch tier for partials,
//! while still using Deepgram's model/diarization quality for the final
//! transcript).

pub mod claude;
pub mod deepgram;
pub mod deepseek;
pub mod gemini;
pub mod groq;

use crate::native_messaging::{
    ActionItem, ProviderKind, SummarizationProviderId, TranscriptionProviderId,
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AudioChannel {
    Mic,
    Speaker,
}

#[derive(Debug, Clone)]
pub struct AudioChunk {
    pub channel: AudioChannel,
    /// Raw PCM16 mono samples at the provider's expected sample rate.
    pub pcm16: Vec<u8>,
    pub sample_rate_hz: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TranscriptSegment {
    pub speaker: String,
    pub text: String,
    pub is_final: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Summary {
    pub summary: String,
    pub action_items: Vec<ActionItem>,
}

#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("authentication failed: {0}")]
    AuthFailed(String),
    #[error("rate limited, retry after {retry_after_secs:?}s")]
    RateLimited { retry_after_secs: Option<u64> },
    #[error("provider unreachable: {0}")]
    Unreachable(String),
    #[error("unexpected response shape: {0}")]
    BadResponse(String),
}

/// Provider calls must not be able to hold the pipeline forever when a
/// network, DNS, or upstream service stalls. The timeout is deliberately long
/// enough for a normal five-second audio batch and a summary request while
/// still allowing the retry queue to make progress.
pub(crate) fn provider_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

impl ProviderError {
    pub fn to_error_code(&self) -> crate::native_messaging::ErrorCode {
        use crate::native_messaging::ErrorCode;
        match self {
            ProviderError::AuthFailed(_) => ErrorCode::ProviderAuthFailed,
            ProviderError::RateLimited { .. } => ErrorCode::ProviderRateLimited,
            ProviderError::Unreachable(_) => ErrorCode::ProviderUnreachable,
            ProviderError::BadResponse(_) => ErrorCode::ProviderUnreachable,
        }
    }
}

#[async_trait]
pub trait TranscriptionProvider: Send + Sync {
    fn id(&self) -> TranscriptionProviderId;
    /// True for providers that deliver low-latency partial results as audio
    /// arrives; false for batch providers that only return a transcript
    /// once the full chunk/recording has been sent.
    fn is_streaming(&self) -> bool;
    /// Transcribe one chunk of audio (a meeting is fed as a sequence of
    /// chunks so a batch provider still produces a rolling transcript
    /// without waiting for the whole meeting to end).
    async fn transcribe_chunk(
        &self,
        chunk: &AudioChunk,
    ) -> Result<Vec<TranscriptSegment>, ProviderError>;
}

#[async_trait]
pub trait SummarizationProvider: Send + Sync {
    fn id(&self) -> SummarizationProviderId;
    async fn summarize(&self, transcript: &[TranscriptSegment]) -> Result<Summary, ProviderError>;
}

/// A GET request with `Authorization: Bearer <key>`, treated as a pure key
/// validation probe: 2xx is valid, 401/403 is an invalid key, anything else
/// (including a network failure) is "couldn't check it right now" rather
/// than a verdict on the key itself. Shared by every provider whose
/// validation endpoint uses bearer auth (Groq, DeepSeek); Deepgram (custom
/// `Token` scheme) and Gemini (API key as a query param) have their own.
pub(crate) async fn bearer_auth_test_key(
    url: &str,
    key: &str,
    provider_name: &str,
) -> Result<(), ProviderError> {
    let client = provider_client();
    let response = client
        .get(url)
        .header("Authorization", format!("Bearer {key}"))
        .send()
        .await
        .map_err(|e| ProviderError::Unreachable(e.to_string()))?;
    let status = response.status();
    if status.is_success() {
        Ok(())
    } else if status == 401 || status == 403 {
        Err(ProviderError::AuthFailed(format!(
            "{provider_name} returned {status}"
        )))
    } else {
        Err(ProviderError::Unreachable(format!(
            "{provider_name} returned {status}"
        )))
    }
}

/// Dispatches a "test this key" request to the right provider's validation
/// endpoint, per docs/native-messaging-protocol.md's `test_provider_key`.
/// Returns a ready-to-send `(valid, message)` pair rather than a `Result`,
/// since both outcomes are legitimate wire responses, not error paths.
pub async fn test_provider_key(provider: ProviderKind, key: &str) -> (bool, String) {
    let label = provider_label(provider);
    let result = match provider {
        ProviderKind::Deepgram => deepgram::test_key(key).await,
        ProviderKind::Groq => groq::test_key(key).await,
        ProviderKind::Claude => claude::test_key(key).await,
        ProviderKind::Gemini => gemini::test_key(key).await,
        ProviderKind::Deepseek => deepseek::test_key(key).await,
    };
    match result {
        Ok(()) => (true, format!("{label} key is valid.")),
        Err(ProviderError::AuthFailed(_)) => {
            (false, format!("{label} rejected this key (double-check it was copied in full)."))
        }
        Err(_) => (false, format!("Couldn't reach {label} to check this key — check your network connection and try again.")),
    }
}

fn provider_label(provider: ProviderKind) -> &'static str {
    match provider {
        ProviderKind::Deepgram => "Deepgram",
        ProviderKind::Groq => "Groq",
        ProviderKind::Claude => "Claude",
        ProviderKind::Gemini => "Gemini",
        ProviderKind::Deepseek => "DeepSeek",
    }
}

/// Renders a transcript into the plain-text form sent to summarization
/// providers. Shared so every summarizer prompts against identical input.
pub fn render_transcript(transcript: &[TranscriptSegment]) -> String {
    transcript
        .iter()
        .map(|seg| format!("{}: {}", seg.speaker, seg.text))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Parses a model's JSON-shaped reply (per `SUMMARIZATION_SYSTEM_PROMPT`)
/// into a `Summary`. Shared across every summarization provider since they
/// all use the same prompt and expected reply shape; models occasionally
/// wrap JSON in markdown code fences despite instructions, so that's
/// stripped defensively before parsing.
pub fn parse_summary_json(text: &str) -> Result<Summary, ProviderError> {
    let trimmed = text
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let parsed: serde_json::Value = serde_json::from_str(trimmed)
        .map_err(|e| ProviderError::BadResponse(format!("model reply wasn't valid JSON: {e}")))?;

    let summary = parsed
        .get("summary")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_string();
    let action_items = parsed
        .get("action_items")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let text = item
                        .get("text")
                        .and_then(serde_json::Value::as_str)?
                        .to_string();
                    let owner = item
                        .get("owner")
                        .and_then(serde_json::Value::as_str)
                        .map(String::from);
                    Some(ActionItem { text, owner })
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(Summary {
        summary,
        action_items,
    })
}

pub const SUMMARIZATION_SYSTEM_PROMPT: &str = "You are summarizing a meeting transcript. \
Produce a concise summary of what was discussed, followed by a list of concrete action items. \
Each action item should name an owner when the transcript makes one clear, and be phrased as a \
specific task, not a vague topic. Respond ONLY with JSON matching this shape: \
{\"summary\": string, \"action_items\": [{\"text\": string, \"owner\": string | null}]}";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_transcript_as_speaker_prefixed_lines() {
        let transcript = vec![
            TranscriptSegment {
                speaker: "you".into(),
                text: "let's start".into(),
                is_final: true,
            },
            TranscriptSegment {
                speaker: "them".into(),
                text: "sounds good".into(),
                is_final: true,
            },
        ];
        assert_eq!(
            render_transcript(&transcript),
            "you: let's start\nthem: sounds good"
        );
    }

    #[test]
    fn provider_label_covers_every_kind() {
        assert_eq!(provider_label(ProviderKind::Deepgram), "Deepgram");
        assert_eq!(provider_label(ProviderKind::Groq), "Groq");
        assert_eq!(provider_label(ProviderKind::Claude), "Claude");
        assert_eq!(provider_label(ProviderKind::Gemini), "Gemini");
        assert_eq!(provider_label(ProviderKind::Deepseek), "DeepSeek");
    }

    #[test]
    fn maps_provider_errors_to_wire_error_codes() {
        use crate::native_messaging::ErrorCode;
        assert_eq!(
            ProviderError::AuthFailed("bad key".into()).to_error_code(),
            ErrorCode::ProviderAuthFailed
        );
        assert_eq!(
            ProviderError::RateLimited {
                retry_after_secs: Some(30)
            }
            .to_error_code(),
            ErrorCode::ProviderRateLimited
        );
        assert_eq!(
            ProviderError::Unreachable("timeout".into()).to_error_code(),
            ErrorCode::ProviderUnreachable
        );
    }
}
