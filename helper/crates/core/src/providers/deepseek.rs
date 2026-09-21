//! DeepSeek V4 Flash summarization provider — budget tier option.
//! OpenAI-compatible chat completions API.

use super::{parse_summary_json, render_transcript, ProviderError, Summary, SummarizationProvider, TranscriptSegment, SUMMARIZATION_SYSTEM_PROMPT};
use crate::native_messaging::SummarizationProviderId;
use async_trait::async_trait;
use serde_json::{json, Value};

const DEEPSEEK_URL: &str = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODELS_URL: &str = "https://api.deepseek.com/v1/models";
const MODEL: &str = "deepseek-chat";

pub async fn test_key(key: &str) -> Result<(), ProviderError> {
    test_key_at(DEEPSEEK_MODELS_URL, key).await
}

async fn test_key_at(url: &str, key: &str) -> Result<(), ProviderError> {
    super::bearer_auth_test_key(url, key, "deepseek").await
}

pub struct DeepSeekProvider {
    api_key: String,
    client: reqwest::Client,
    base_url: String,
}

impl DeepSeekProvider {
    pub fn new(api_key: String) -> Self {
        Self { api_key, client: reqwest::Client::new(), base_url: DEEPSEEK_URL.to_string() }
    }

    #[cfg(test)]
    fn with_base_url(api_key: String, base_url: String) -> Self {
        Self { api_key, client: reqwest::Client::new(), base_url }
    }
}

#[async_trait]
impl SummarizationProvider for DeepSeekProvider {
    fn id(&self) -> SummarizationProviderId {
        SummarizationProviderId::Deepseek
    }

    async fn summarize(&self, transcript: &[TranscriptSegment]) -> Result<Summary, ProviderError> {
        let body = json!({
            "model": MODEL,
            "messages": [
                { "role": "system", "content": SUMMARIZATION_SYSTEM_PROMPT },
                { "role": "user", "content": render_transcript(transcript) }
            ]
        });

        let response = self
            .client
            .post(&self.base_url)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .json(&body)
            .send()
            .await
            .map_err(|e| ProviderError::Unreachable(e.to_string()))?;

        let status = response.status();
        if status == 401 {
            return Err(ProviderError::AuthFailed(format!("deepseek returned {status}")));
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
            return Err(ProviderError::Unreachable(format!("deepseek returned {status}")));
        }

        let body: Value = response.json().await.map_err(|e| ProviderError::BadResponse(e.to_string()))?;
        parse_response(&body)
    }
}

fn parse_response(body: &Value) -> Result<Summary, ProviderError> {
    let text = body
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .ok_or_else(|| ProviderError::BadResponse("missing choices[0].message.content".into()))?;
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
        Mock::given(method("GET")).and(header("Authorization", "Bearer good-key")).respond_with(ResponseTemplate::new(200)).mount(&mock_server).await;
        assert!(test_key_at(&mock_server.uri(), "good-key").await.is_ok());
    }

    #[tokio::test]
    async fn test_key_reports_auth_failed_on_401() {
        let mock_server = MockServer::start().await;
        Mock::given(method("GET")).respond_with(ResponseTemplate::new(401)).mount(&mock_server).await;
        let err = test_key_at(&mock_server.uri(), "bad-key").await.unwrap_err();
        assert!(matches!(err, ProviderError::AuthFailed(_)));
    }

    #[test]
    fn extracts_content_from_openai_compatible_shape() {
        let body = json!({
            "choices": [ { "message": { "content": "{\"summary\": \"ok\", \"action_items\": []}" } } ]
        });
        assert_eq!(parse_response(&body).unwrap().summary, "ok");
    }

    #[test]
    fn missing_choices_is_bad_response() {
        let body = json!({ "unexpected": true });
        assert!(matches!(parse_response(&body).unwrap_err(), ProviderError::BadResponse(_)));
    }

    #[tokio::test]
    async fn sends_bearer_auth_and_parses_success() {
        let mock_server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(header("Authorization", "Bearer test-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "choices": [ { "message": { "content": "{\"summary\": \"mocked\", \"action_items\": []}" } } ]
            })))
            .mount(&mock_server)
            .await;

        let provider = DeepSeekProvider::with_base_url("test-key".into(), mock_server.uri());
        let transcript = vec![TranscriptSegment { speaker: "you".into(), text: "hi".into(), is_final: true }];
        let summary = provider.summarize(&transcript).await.unwrap();
        assert_eq!(summary.summary, "mocked");
    }

    #[tokio::test]
    async fn maps_401_to_auth_failed() {
        let mock_server = MockServer::start().await;
        Mock::given(method("POST")).respond_with(ResponseTemplate::new(401)).mount(&mock_server).await;

        let provider = DeepSeekProvider::with_base_url("bad".into(), mock_server.uri());
        let transcript = vec![TranscriptSegment { speaker: "you".into(), text: "hi".into(), is_final: true }];
        assert!(matches!(provider.summarize(&transcript).await.unwrap_err(), ProviderError::AuthFailed(_)));
    }
}
