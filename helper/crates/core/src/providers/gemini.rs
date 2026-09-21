//! Gemini Flash summarization provider — budget tier option.

use super::{
    parse_summary_json, provider_client, render_transcript, ProviderError, SummarizationProvider,
    Summary, TranscriptSegment, SUMMARIZATION_SYSTEM_PROMPT,
};
use crate::native_messaging::SummarizationProviderId;
use async_trait::async_trait;
use serde_json::{json, Value};

const GEMINI_URL: &str =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";
const GEMINI_MODELS_URL: &str = "https://generativelanguage.googleapis.com/v1beta/models";

pub async fn test_key(key: &str) -> Result<(), ProviderError> {
    test_key_at(GEMINI_MODELS_URL, key).await
}

async fn test_key_at(url: &str, key: &str) -> Result<(), ProviderError> {
    let client = provider_client();
    let response = client
        .get(url)
        .query(&[("key", key)])
        .send()
        .await
        .map_err(|e| ProviderError::Unreachable(e.to_string()))?;
    let status = response.status();
    if status.is_success() {
        Ok(())
    } else if status == 401 || status == 403 {
        Err(ProviderError::AuthFailed(format!(
            "gemini returned {status}"
        )))
    } else {
        Err(ProviderError::Unreachable(format!(
            "gemini returned {status}"
        )))
    }
}

pub struct GeminiProvider {
    api_key: String,
    client: reqwest::Client,
    base_url: String,
}

impl GeminiProvider {
    pub fn new(api_key: String) -> Self {
        Self {
            api_key,
            client: provider_client(),
            base_url: GEMINI_URL.to_string(),
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
impl SummarizationProvider for GeminiProvider {
    fn id(&self) -> SummarizationProviderId {
        SummarizationProviderId::Gemini
    }

    async fn summarize(&self, transcript: &[TranscriptSegment]) -> Result<Summary, ProviderError> {
        let body = json!({
            "system_instruction": { "parts": [{ "text": SUMMARIZATION_SYSTEM_PROMPT }] },
            "contents": [{ "parts": [{ "text": render_transcript(transcript) }] }]
        });

        let response = self
            .client
            .post(&self.base_url)
            .query(&[("key", &self.api_key)])
            .json(&body)
            .send()
            .await
            .map_err(|e| ProviderError::Unreachable(e.to_string()))?;

        let status = response.status();
        if status == 401 || status == 403 {
            return Err(ProviderError::AuthFailed(format!(
                "gemini returned {status}"
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
                "gemini returned {status}"
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
        .pointer("/candidates/0/content/parts/0/text")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ProviderError::BadResponse("missing candidates[0].content.parts[0].text".into())
        })?;
    parse_summary_json(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::matchers::{method, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn test_key_succeeds_on_2xx() {
        let mock_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(query_param("key", "good-key"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&mock_server)
            .await;
        assert!(test_key_at(&mock_server.uri(), "good-key").await.is_ok());
    }

    #[tokio::test]
    async fn test_key_reports_auth_failed_on_403() {
        let mock_server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(403))
            .mount(&mock_server)
            .await;
        let err = test_key_at(&mock_server.uri(), "bad-key")
            .await
            .unwrap_err();
        assert!(matches!(err, ProviderError::AuthFailed(_)));
    }

    #[test]
    fn extracts_text_from_gemini_response_shape() {
        let body = json!({
            "candidates": [ { "content": { "parts": [ { "text": "{\"summary\": \"ok\", \"action_items\": []}" } ] } } ]
        });
        assert_eq!(parse_response(&body).unwrap().summary, "ok");
    }

    #[test]
    fn missing_candidates_is_bad_response() {
        let body = json!({ "unexpected": true });
        assert!(matches!(
            parse_response(&body).unwrap_err(),
            ProviderError::BadResponse(_)
        ));
    }

    #[tokio::test]
    async fn sends_api_key_as_query_param_and_parses_success() {
        let mock_server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(query_param("key", "test-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "candidates": [ { "content": { "parts": [ { "text": "{\"summary\": \"mocked\", \"action_items\": []}" } ] } } ]
            })))
            .mount(&mock_server)
            .await;

        let provider = GeminiProvider::with_base_url("test-key".into(), mock_server.uri());
        let transcript = vec![TranscriptSegment {
            speaker: "you".into(),
            text: "hi".into(),
            is_final: true,
        }];
        let summary = provider.summarize(&transcript).await.unwrap();
        assert_eq!(summary.summary, "mocked");
    }

    #[tokio::test]
    async fn maps_403_to_auth_failed() {
        let mock_server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(403))
            .mount(&mock_server)
            .await;

        let provider = GeminiProvider::with_base_url("bad".into(), mock_server.uri());
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
