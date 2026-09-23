//! Deepgram transcription provider — default tier. Implements both the
//! synchronous prerecorded (batch) REST endpoint, used for API-key
//! validation and gap-backfill after a WebSocket drop, and the real
//! live-streaming WebSocket endpoint, used for the actual meeting
//! transcript. See
//! `docs/superpowers/specs/2026-09-22-deepgram-live-streaming-design.md`.

use super::{
    provider_client, AudioChannel, AudioChunk, ProviderError, StreamingSession, TranscriptSegment,
    TranscriptionProvider,
};
use crate::native_messaging::TranscriptionProviderId;
use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message as WsMessage;

const DEEPGRAM_LISTEN_URL: &str = "https://api.deepgram.com/v1/listen";
const DEEPGRAM_PROJECTS_URL: &str = "https://api.deepgram.com/v1/projects";
const DEEPGRAM_STREAM_URL: &str = "wss://api.deepgram.com/v1/listen";

pub struct DeepgramProvider {
    api_key: String,
    client: reqwest::Client,
    base_url: String,
    stream_url: String,
}

impl DeepgramProvider {
    pub fn new(api_key: String) -> Self {
        Self {
            api_key,
            client: provider_client(),
            base_url: DEEPGRAM_LISTEN_URL.to_string(),
            stream_url: DEEPGRAM_STREAM_URL.to_string(),
        }
    }

    /// Test-only constructor pointing at a mock server instead of Deepgram's
    /// real API, so the request/response contract can be verified without
    /// live credentials or network access to Deepgram itself.
    #[cfg(test)]
    fn with_base_url(api_key: String, base_url: String) -> Self {
        Self {
            api_key,
            client: provider_client(),
            base_url,
            stream_url: DEEPGRAM_STREAM_URL.to_string(),
        }
    }

    /// Test-only constructor pointing the streaming session at a local fake
    /// WebSocket server instead of Deepgram's real endpoint.
    #[cfg(test)]
    fn with_stream_url(api_key: String, stream_url: String) -> Self {
        Self {
            api_key,
            client: provider_client(),
            base_url: DEEPGRAM_LISTEN_URL.to_string(),
            stream_url,
        }
    }
}

struct DeepgramStreamingSession {
    write: futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        WsMessage,
    >,
    inbound_rx: mpsc::UnboundedReceiver<Vec<TranscriptSegment>>,
    read_task: JoinHandle<()>,
    closed: Arc<AtomicBool>,
    utterance_id: u32,
}

#[async_trait]
impl StreamingSession for DeepgramStreamingSession {
    async fn send_audio(&mut self, pcm16: &[u8]) -> Result<(), ProviderError> {
        if self
            .write
            .send(WsMessage::Binary(pcm16.to_vec()))
            .await
            .is_err()
        {
            self.closed.store(true, Ordering::Relaxed);
            return Err(ProviderError::Unreachable("deepgram stream closed".into()));
        }
        Ok(())
    }

    async fn try_recv_segments(&mut self) -> Vec<(TranscriptSegment, u32)> {
        let mut out = Vec::new();
        while let Ok(segments) = self.inbound_rx.try_recv() {
            for segment in segments {
                let id = self.utterance_id;
                if segment.is_final {
                    self.utterance_id = self.utterance_id.wrapping_add(1);
                }
                out.push((segment, id));
            }
        }
        out
    }

    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Relaxed)
    }

    async fn close(&mut self) -> Vec<(TranscriptSegment, u32)> {
        let _ = self
            .write
            .send(WsMessage::Text(r#"{"type":"CloseStream"}"#.to_string()))
            .await;
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let trailing = self.try_recv_segments().await;
        self.read_task.abort();
        trailing
    }
}

#[async_trait]
impl TranscriptionProvider for DeepgramProvider {
    fn id(&self) -> TranscriptionProviderId {
        TranscriptionProviderId::Deepgram
    }

    fn is_streaming(&self) -> bool {
        true // real WebSocket streaming — see module docs
    }

    async fn open_streaming_session(
        &self,
        channel: AudioChannel,
        sample_rate_hz: u32,
    ) -> Result<Box<dyn StreamingSession>, ProviderError> {
        let url = format!(
            "{}?encoding=linear16&sample_rate={}&channels=1&model=nova-3&punctuate=true&diarize=true&interim_results=true&endpointing=300",
            self.stream_url, sample_rate_hz
        );
        let mut request = url
            .into_client_request()
            .map_err(|e| ProviderError::Unreachable(e.to_string()))?;
        request.headers_mut().insert(
            "Authorization",
            format!("Token {}", self.api_key)
                .parse()
                .map_err(|_| ProviderError::AuthFailed("invalid api key header".into()))?,
        );
        let (ws_stream, _) = tokio_tungstenite::connect_async(request)
            .await
            .map_err(|e| ProviderError::Unreachable(e.to_string()))?;
        let (write, mut read) = ws_stream.split();
        let (tx, rx) = mpsc::unbounded_channel();
        let closed = Arc::new(AtomicBool::new(false));
        let closed_for_task = closed.clone();
        let read_task = tokio::spawn(async move {
            while let Some(msg) = read.next().await {
                match msg {
                    Ok(WsMessage::Text(text)) => {
                        if let Ok(body) = serde_json::from_str::<Value>(&text) {
                            if let Some(segments) = parse_streaming_message(&body, channel) {
                                let _ = tx.send(segments);
                            }
                        }
                    }
                    Ok(WsMessage::Close(_)) | Err(_) => break,
                    _ => {}
                }
            }
            closed_for_task.store(true, Ordering::Relaxed);
        });
        Ok(Box::new(DeepgramStreamingSession {
            write,
            inbound_rx: rx,
            read_task,
            closed,
            utterance_id: 0,
        }))
    }

    async fn transcribe_chunk(
        &self,
        chunk: &AudioChunk,
    ) -> Result<Vec<TranscriptSegment>, ProviderError> {
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
            return Err(ProviderError::AuthFailed(format!(
                "deepgram returned {status}"
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
                "deepgram returned {status}"
            )));
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
    let client = provider_client();
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
        Err(ProviderError::AuthFailed(format!(
            "deepgram returned {status}"
        )))
    } else {
        Err(ProviderError::Unreachable(format!(
            "deepgram returned {status}"
        )))
    }
}

/// Pure parsing of Deepgram's `/v1/listen` response shape. Kept separate
/// from the network call so it's unit-testable with fixture JSON.
fn parse_response(
    body: &Value,
    channel: AudioChannel,
) -> Result<Vec<TranscriptSegment>, ProviderError> {
    let alternative = body
        .pointer("/results/channels/0/alternatives/0")
        .ok_or_else(|| {
            ProviderError::BadResponse("missing results.channels[0].alternatives[0]".into())
        })?;
    Ok(segments_from_alternative(alternative, channel, true))
}

/// Parses one message from Deepgram's live-streaming WebSocket protocol.
/// Returns `None` for anything that isn't a transcript result (e.g. the
/// periodic `Metadata` message) or has no words yet.
fn parse_streaming_message(body: &Value, channel: AudioChannel) -> Option<Vec<TranscriptSegment>> {
    let is_final = body
        .get("is_final")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let alternative = body.pointer("/channel/alternatives/0")?;
    let segments = segments_from_alternative(alternative, channel, is_final);
    if segments.is_empty() {
        None
    } else {
        Some(segments)
    }
}

/// Shared by the batch response parser above and the streaming message
/// parser above — both eventually have one Deepgram "alternative" object
/// (transcript + optional per-word speaker labels) to turn into segments,
/// differing only in where that object sits in the outer JSON shape and
/// whether the result is final yet.
fn segments_from_alternative(
    alternative: &Value,
    channel: AudioChannel,
    is_final: bool,
) -> Vec<TranscriptSegment> {
    let transcript = alternative
        .get("transcript")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    if transcript.is_empty() {
        return vec![];
    }

    if channel == AudioChannel::Mic {
        // The mic channel is unambiguously "you" — no need to diarize our
        // own voice into multiple speakers.
        return vec![TranscriptSegment {
            speaker: "you".into(),
            text: transcript,
            is_final,
        }];
    }

    // Speaker channel: use word-level diarization to label each distinct
    // remote participant as "them", "them-2", "them-3", ...
    let words = alternative.get("words").and_then(Value::as_array);
    match words {
        Some(words) if !words.is_empty() && words[0].get("speaker").is_some() => {
            group_by_speaker(words, is_final)
        }
        _ => vec![TranscriptSegment {
            speaker: "them".into(),
            text: transcript,
            is_final,
        }],
    }
}

fn group_by_speaker(words: &[Value], is_final: bool) -> Vec<TranscriptSegment> {
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
                    is_final,
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
            is_final,
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
    use tokio::net::TcpListener;
    use tokio_tungstenite::accept_async;
    use wiremock::matchers::{header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// Starts a real local WebSocket server (127.0.0.1, ephemeral port) that
    /// accepts one connection per entry in `sessions`, sends that entry's
    /// scripted JSON messages, then optionally drops the connection —
    /// letting tests exercise reconnect behavior without any live Deepgram
    /// credentials or network access.
    async fn spawn_fake_deepgram_server(sessions: Vec<(Vec<Value>, bool)>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            for (messages, then_drop) in sessions {
                let (stream, _) = match listener.accept().await {
                    Ok(pair) => pair,
                    Err(_) => return,
                };
                let mut ws = match accept_async(stream).await {
                    Ok(ws) => ws,
                    Err(_) => return,
                };
                for message in messages {
                    if ws.send(WsMessage::Text(message.to_string())).await.is_err() {
                        break;
                    }
                }
                if then_drop {
                    let _ = ws.close(None).await;
                }
            }
        });
        // Trailing slash so the query string always has a leading `/` in
        // front of it once `open_streaming_session` appends `?...` — a bare
        // `ws://host:port` has no path, which produces an invalid
        // `GET ?query HTTP/1.1` request line (missing the required leading
        // `/`). Deepgram's real URL already has a path (`/v1/listen`) so
        // this only matters for this fake server's URL.
        format!("ws://{}/", addr)
    }

    #[test]
    fn parses_streaming_interim_message() {
        let body = json!({
            "is_final": false,
            "channel": { "alternatives": [ { "transcript": "hello wor" } ] }
        });
        let segments = parse_streaming_message(&body, AudioChannel::Mic).unwrap();
        assert_eq!(
            segments,
            vec![TranscriptSegment {
                speaker: "you".into(),
                text: "hello wor".into(),
                is_final: false
            }]
        );
    }

    #[test]
    fn parses_streaming_final_message() {
        let body = json!({
            "is_final": true,
            "channel": { "alternatives": [ { "transcript": "hello world" } ] }
        });
        let segments = parse_streaming_message(&body, AudioChannel::Mic).unwrap();
        assert_eq!(
            segments,
            vec![TranscriptSegment {
                speaker: "you".into(),
                text: "hello world".into(),
                is_final: true
            }]
        );
    }

    #[test]
    fn streaming_message_with_empty_transcript_yields_none() {
        let body = json!({
            "is_final": false,
            "channel": { "alternatives": [ { "transcript": "" } ] }
        });
        assert!(parse_streaming_message(&body, AudioChannel::Mic).is_none());
    }

    #[test]
    fn streaming_message_missing_channel_shape_yields_none() {
        let body = json!({ "type": "Metadata" });
        assert!(parse_streaming_message(&body, AudioChannel::Mic).is_none());
    }

    #[tokio::test]
    async fn streaming_session_reports_interim_then_final_with_stable_utterance_id() {
        let messages = vec![
            json!({ "is_final": false, "channel": { "alternatives": [ { "transcript": "hello wor" } ] } }),
            json!({ "is_final": true, "channel": { "alternatives": [ { "transcript": "hello world" } ] } }),
        ];
        let stream_url = spawn_fake_deepgram_server(vec![(messages, false)]).await;
        let provider = DeepgramProvider::with_stream_url("test-key".into(), stream_url);
        let mut session = provider
            .open_streaming_session(AudioChannel::Mic, 16000)
            .await
            .unwrap();

        session.send_audio(&[0, 1, 2, 3]).await.unwrap();

        let mut collected = Vec::new();
        for _ in 0..40 {
            collected.extend(session.try_recv_segments().await);
            if collected.len() >= 2 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }

        assert_eq!(collected.len(), 2);
        assert_eq!(collected[0].0.text, "hello wor");
        assert!(!collected[0].0.is_final);
        assert_eq!(collected[1].0.text, "hello world");
        assert!(collected[1].0.is_final);
        assert_eq!(collected[0].1, collected[1].1);
    }

    #[tokio::test]
    async fn streaming_session_increments_utterance_id_after_a_final() {
        let messages = vec![
            json!({ "is_final": true, "channel": { "alternatives": [ { "transcript": "first" } ] } }),
            json!({ "is_final": true, "channel": { "alternatives": [ { "transcript": "second" } ] } }),
        ];
        let stream_url = spawn_fake_deepgram_server(vec![(messages, false)]).await;
        let provider = DeepgramProvider::with_stream_url("test-key".into(), stream_url);
        let mut session = provider
            .open_streaming_session(AudioChannel::Mic, 16000)
            .await
            .unwrap();
        session.send_audio(&[0, 1]).await.unwrap();

        let mut collected = Vec::new();
        for _ in 0..40 {
            collected.extend(session.try_recv_segments().await);
            if collected.len() >= 2 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }

        assert_eq!(collected.len(), 2);
        assert_ne!(collected[0].1, collected[1].1);
    }

    #[tokio::test]
    async fn streaming_session_reports_closed_after_server_drops_connection() {
        let stream_url = spawn_fake_deepgram_server(vec![(vec![], true)]).await;
        let provider = DeepgramProvider::with_stream_url("test-key".into(), stream_url);
        let session = provider
            .open_streaming_session(AudioChannel::Speaker, 16000)
            .await
            .unwrap();

        let mut closed = false;
        for _ in 0..40 {
            if session.is_closed() {
                closed = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert!(
            closed,
            "session should observe the server closing the connection"
        );
    }

    fn mic_chunk() -> AudioChunk {
        AudioChunk {
            channel: AudioChannel::Mic,
            pcm16: vec![0, 1, 2, 3],
            sample_rate_hz: 16000,
        }
    }

    fn speaker_chunk() -> AudioChunk {
        AudioChunk {
            channel: AudioChannel::Speaker,
            pcm16: vec![4, 5, 6, 7],
            sample_rate_hz: 16000,
        }
    }

    #[test]
    fn parses_simple_transcript_for_mic_channel() {
        let body = json!({
            "results": { "channels": [ { "alternatives": [ { "transcript": "hello there" } ] } ] }
        });
        let segments = parse_response(&body, AudioChannel::Mic).unwrap();
        assert_eq!(
            segments,
            vec![TranscriptSegment {
                speaker: "you".into(),
                text: "hello there".into(),
                is_final: true
            }]
        );
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
        assert_eq!(
            segments,
            vec![TranscriptSegment {
                speaker: "them".into(),
                text: "just one voice".into(),
                is_final: true
            }]
        );
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

        let provider =
            DeepgramProvider::with_base_url("test-key".into(), format!("{}/", mock_server.uri()));
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

        let provider =
            DeepgramProvider::with_base_url("bad-key".into(), format!("{}/", mock_server.uri()));
        let err = provider
            .transcribe_chunk(&speaker_chunk())
            .await
            .unwrap_err();
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
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&mock_server)
            .await;
        let err = test_key_at(&mock_server.uri(), "bad-key")
            .await
            .unwrap_err();
        assert!(matches!(err, ProviderError::AuthFailed(_)));
    }

    #[tokio::test]
    async fn maps_429_to_rate_limited_with_retry_after() {
        let mock_server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(429).insert_header("retry-after", "12"))
            .mount(&mock_server)
            .await;

        let provider =
            DeepgramProvider::with_base_url("test-key".into(), format!("{}/", mock_server.uri()));
        let err = provider.transcribe_chunk(&mic_chunk()).await.unwrap_err();
        match err {
            ProviderError::RateLimited { retry_after_secs } => {
                assert_eq!(retry_after_secs, Some(12))
            }
            other => panic!("expected RateLimited, got {other:?}"),
        }
    }
}
