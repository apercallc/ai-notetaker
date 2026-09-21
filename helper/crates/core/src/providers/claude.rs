//! Claude (Anthropic Messages API) summarization provider — default tier.

use super::{
    parse_summary_json, render_transcript, ProviderError, SummarizationProvider, Summary,
    TranscriptSegment, SUMMARIZATION_SYSTEM_PROMPT,
};
use crate::native_messaging::SummarizationProviderId;
use async_trait::async_trait;
use serde_json::{json, Value};

const ANTHROPIC_MESSAGES_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODELS_URL: &str = "https://api.anthropic.com/v1/models";
const MODEL: &str = "claude-haiku-4-5";
const ANTHROPIC_VERSION: &str = "2023-06-01";

pub async fn test_key(key: &str) -> Result<(), ProviderError> {
    test_key_at(ANTHROPIC_MODELS_URL, key).await
}

async fn test_key_at(url: &str, key: &str) -> Result<(), ProviderError> {
    let client = reqwest::Client::new();
    let response = client
        .get(url)
        .header("x-api-key", key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .send()
        .await
        .map_err(|e| ProviderError::Unreachable(e.to_string()))?;
    let status = response.status();
    if status.is_success() {
        Ok(())
    } else if status == 401 {
        Err(ProviderError::AuthFailed(format!(
            "claude returned {status}"
        )))
    } else {
        Err(ProviderError::Unreachable(format!(
            "claude returned {status}"
        )))
    }
}

pub struct ClaudeProvider {
    api_key: String,
    client: reqwest::Client,
    base_url: String,
}

impl ClaudeProvider {
    pub fn new(api_key: String) -> Self {
        Self {
            api_key,
            client: reqwest::Client::new(),
            base_url: ANTHROPIC_MESSAGES_URL.to_string(),
        }
    }

    #[cfg(test)]
    fn with_base_url(api_key: String, base_url: String) -> Self {
        Self {
            api_key,
            client: reqwest::Client::new(),
            base_url,
        }
    }
}

#[async_trait]
impl SummarizationProvider for ClaudeProvider {
    fn id(&self) -> SummarizationProviderId {
        SummarizationProviderId::Claude
    }

    async fn summarize(&self, transcript: &[TranscriptSegment]) -> Result<Summary, ProviderError> {
        let body = json!({
            "model": MODEL,
            "max_tokens": 1024,
            "system": SUMMARIZATION_SYSTEM_PROMPT,
            "messages": [{ "role": "user", "content": render_transcript(transcript) }]
        });

        let response = self
            .client
            .post(&self.base_url)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| ProviderError::Unreachable(e.to_string()))?;

        let status = response.status();
        if status == 401 {
            return Err(ProviderError::AuthFailed(format!(
                "claude returned {status}"
            )));
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
                "claude returned {status}"
            )));
        }

        let body: Value = response
            .json()
            .await
            .map_err(|e| ProviderError::BadResponse(e.to_string()))?;
        parse_response(&body)
    }
}

fn parse_response(body: &Value) -> Result<Summary, ProviderError> {
    let text = body
        .pointer("/content/0/text")
        .and_then(Value::as_str)
        .ok_or_else(|| ProviderError::BadResponse("missing content[0].text".into()))?;

    parse_summary_json(text)
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
            .and(header("x-api-key", "good-key"))
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
    fn parses_clean_json_reply() {
        let text = r#"{"summary": "discussed roadmap", "action_items": [{"text": "ship v1", "owner": "alex"}]}"#;
        let summary = parse_summary_json(text).unwrap();
        assert_eq!(summary.summary, "discussed roadmap");
        assert_eq!(summary.action_items[0].text, "ship v1");
        assert_eq!(summary.action_items[0].owner, Some("alex".into()));
    }

    #[test]
    fn strips_markdown_code_fences_before_parsing() {
        let text = "```json\n{\"summary\": \"x\", \"action_items\": []}\n```";
        let summary = parse_summary_json(text).unwrap();
        assert_eq!(summary.summary, "x");
    }

    #[test]
    fn action_item_owner_defaults_to_none_when_absent() {
        let text = r#"{"summary": "x", "action_items": [{"text": "follow up"}]}"#;
        let summary = parse_summary_json(text).unwrap();
        assert_eq!(summary.action_items[0].owner, None);
    }

    #[test]
    fn non_json_reply_is_a_bad_response_error() {
        assert!(matches!(
            parse_summary_json("not json at all").unwrap_err(),
            ProviderError::BadResponse(_)
        ));
    }

    #[test]
    fn extracts_text_from_full_anthropic_response_shape() {
        let body = json!({
            "content": [ { "type": "text", "text": "{\"summary\": \"ok\", \"action_items\": []}" } ]
        });
        assert_eq!(parse_response(&body).unwrap().summary, "ok");
    }

    #[tokio::test]
    async fn sends_anthropic_headers_and_parses_success() {
        let mock_server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(header("x-api-key", "test-key"))
            .and(header("anthropic-version", "2023-06-01"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "content": [ { "type": "text", "text": "{\"summary\": \"mocked\", \"action_items\": []}" } ]
            })))
            .mount(&mock_server)
            .await;

        let provider = ClaudeProvider::with_base_url("test-key".into(), mock_server.uri());
        let transcript = vec![TranscriptSegment {
            speaker: "you".into(),
            text: "hi".into(),
            is_final: true,
        }];
        let summary = provider.summarize(&transcript).await.unwrap();
        assert_eq!(summary.summary, "mocked");
    }

    #[tokio::test]
    async fn maps_401_to_auth_failed() {
        let mock_server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&mock_server)
            .await;

        let provider = ClaudeProvider::with_base_url("bad".into(), mock_server.uri());
        let transcript = vec![TranscriptSegment {
            speaker: "you".into(),
            text: "hi".into(),
            is_final: true,
        }];
        assert!(matches!(
            provider.summarize(&transcript).await.unwrap_err(),
            ProviderError::AuthFailed(_)
        ));
    }
}
