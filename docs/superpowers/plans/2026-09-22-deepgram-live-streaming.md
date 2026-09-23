# Deepgram Live-Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Deepgram's batch REST transcription with real WebSocket
live-streaming, so users see corrected partial transcripts as they speak
instead of 5-second batch bursts, without touching any other provider.

**Architecture:** Two persistent WebSocket sessions per active meeting
(mic, speaker), fed directly from the existing disk-persist step in
`Pipeline::handle_audio_chunk`, bypassing the 5-second batch window for
Deepgram only. A WS drop triggers one gap-backfill job through the
*existing* batch retry queue while the session reconnects in the
background. The extension gets an additive `utteranceId` field so it can
replace an in-progress line instead of always appending.

**Tech Stack:** Rust (`tokio-tungstenite`, `futures-util`), existing
`async-trait`/`reqwest`/`wiremock` stack in `helper/`; TypeScript (no new
deps) in `extension/`.

**Spec:** `docs/superpowers/specs/2026-09-22-deepgram-live-streaming-design.md`

## Global Constraints

- Raw audio must hit disk before any network call, every time, no
  exceptions — unchanged in this plan (see spec architecture section).
- No behavior change for Groq/Claude/Gemini/DeepSeek — `is_streaming()`
  stays `false` for all of them; `TranscriptionProvider` gets a **default**
  `open_streaming_session` method so none of them need edits.
- `transcript_partial`'s new `utteranceId` field is additive — old field
  set (`meetingId`, `speaker`, `text`, `isFinal`) is unchanged.
- Never open a raw localhost port for extension↔helper — not touched by
  this plan (Deepgram's WS is helper↔Deepgram, unrelated to Native
  Messaging).
- Follow `helper/CLAUDE.md`: this package owns the AI pipeline; the
  extension stays a thin display layer.

---

### Task 1: Add `utteranceId` to the `transcript_partial` wire message

**Files:**
- Modify: `helper/crates/core/src/native_messaging.rs:138-145` (the
  `TranscriptPartial` variant)
- Modify: `helper/crates/core/src/native_messaging.rs` (the
  `write_then_read_helper_to_extension_message` test, ~line 320)
- Modify: `docs/native-messaging-protocol.md:124-129`
- Modify: `extension/src/types.ts` (`IncomingMessage`'s `transcript_partial`
  variant and `isIncomingMessage`'s validation for it)

**Interfaces:**
- Produces: `HelperToExtension::TranscriptPartial` now has a
  `#[serde(rename = "utteranceId")] utterance_id: u32` field. Every call
  site that constructs this variant must supply it (there are two, in
  `pipeline.rs::transcribe_pending` and the streaming path added in
  Task 5).

- [ ] **Step 1: Update the Rust enum variant**

In `helper/crates/core/src/native_messaging.rs`, change:

```rust
    TranscriptPartial {
        #[serde(rename = "meetingId")]
        meeting_id: Uuid,
        speaker: String,
        text: String,
        #[serde(rename = "isFinal")]
        is_final: bool,
    },
```

to:

```rust
    TranscriptPartial {
        #[serde(rename = "meetingId")]
        meeting_id: Uuid,
        speaker: String,
        text: String,
        #[serde(rename = "isFinal")]
        is_final: bool,
        /// Identifies one in-progress utterance so the extension can
        /// replace a not-yet-final line instead of always appending.
        /// Non-streaming providers emit a fresh id per message (every
        /// message from them is already final).
        #[serde(rename = "utteranceId")]
        utterance_id: u32,
    },
```

- [ ] **Step 2: Update the existing serde round-trip test to fail first**

In the same file, the test `write_then_read_helper_to_extension_message`
constructs a `TranscriptPartial` — add `utterance_id: 0,` to its literal.
Run it before adding the field to confirm the compiler currently rejects
it:

Run: `cd helper && cargo test -p notetaker-core write_then_read_helper_to_extension_message`
Expected: FAIL — `missing field \`utterance_id\`` (compile error, since
Step 1 hasn't landed in your working copy yet if you're doing this test
first; if Step 1 is already applied, this instead fails because the test
literal is missing the field — either way, a red state proves the field
matters).

- [ ] **Step 3: Make the test pass**

Add `utterance_id: 0,` to the test's `TranscriptPartial` literal (same
file, ~line 322). Also grep for any other `TranscriptPartial {` literal in
`helper/crates/core/src/**/*.rs` test modules and add `utterance_id: 0,`
to each so the whole crate compiles.

Run: `cd helper && cargo test -p notetaker-core native_messaging`
Expected: PASS

- [ ] **Step 4: Update the protocol doc**

In `docs/native-messaging-protocol.md`, change the `transcript_partial`
example (~line 124) to:

```jsonc
{
  "type": "transcript_partial",
  "meetingId": "<uuid>",
  "speaker": "you" | "them" | "them-2" | ...,
  "text": "...",
  "isFinal": false,
  "utteranceId": 0
}
```

Add one sentence directly below the example: "`utteranceId` increments
per channel each time a final segment is emitted; the extension uses
`(speaker, utteranceId)` to know whether an incoming message replaces the
currently-shown in-progress line or starts a new one."

- [ ] **Step 5: Update the extension's wire type + validator**

In `extension/src/types.ts`, change the `transcript_partial` member of
`IncomingMessage` (~line 148):

```typescript
  | {
      type: "transcript_partial";
      meetingId: string;
      speaker: Speaker;
      text: string;
      isFinal: boolean;
      utteranceId: number;
    }
```

And in `isIncomingMessage`'s `case "transcript_partial":` branch:

```typescript
    case "transcript_partial":
      return hasNonEmptyString("meetingId") && isSpeaker(message.speaker) && isString("text") &&
        typeof message.isFinal === "boolean" && typeof message.utteranceId === "number" && Number.isInteger(message.utteranceId);
```

- [ ] **Step 6: Run the extension test suite to confirm nothing else broke**

Run: `cd extension && npm test`
Expected: PASS (this step only changed a type + validator; nothing calls
it with a real message yet, so no existing test should reference the
missing field — if one does, add `utteranceId: 0` to that fixture).

- [ ] **Step 7: Commit**

```bash
git add helper/crates/core/src/native_messaging.rs docs/native-messaging-protocol.md extension/src/types.ts
git commit -m "feat: add utteranceId to transcript_partial protocol message"
```

---

### Task 2: Add the `StreamingSession` trait and a default no-op streaming hook

**Files:**
- Modify: `helper/crates/core/src/providers/mod.rs`

**Interfaces:**
- Consumes: nothing new (pure trait addition).
- Produces: `pub trait StreamingSession: Send { async fn send_audio(&mut self, pcm16: &[u8]) -> Result<(), ProviderError>; async fn try_recv_segments(&mut self) -> Vec<(TranscriptSegment, u32)>; fn is_closed(&self) -> bool; async fn close(&mut self) -> Vec<(TranscriptSegment, u32)>; }` and `TranscriptionProvider::open_streaming_session(&self, channel: AudioChannel, sample_rate_hz: u32) -> Result<Box<dyn StreamingSession>, ProviderError>` (default: `Err(ProviderError::Unreachable("streaming not supported".into()))`). Task 3 and Task 5 depend on these exact names/signatures.

- [ ] **Step 1: Write a failing test proving the default is "unsupported"**

Add to the `#[cfg(test)] mod tests` block at the bottom of
`helper/crates/core/src/providers/mod.rs` (create the block if this file
has none yet — check first with
`grep -n "mod tests" helper/crates/core/src/providers/mod.rs`):

```rust
    struct BatchOnlyProvider;

    #[async_trait]
    impl TranscriptionProvider for BatchOnlyProvider {
        fn id(&self) -> TranscriptionProviderId {
            TranscriptionProviderId::Groq
        }
        fn is_streaming(&self) -> bool {
            false
        }
        async fn transcribe_chunk(
            &self,
            _chunk: &AudioChunk,
        ) -> Result<Vec<TranscriptSegment>, ProviderError> {
            Ok(vec![])
        }
    }

    #[tokio::test]
    async fn default_open_streaming_session_is_unsupported() {
        let provider = BatchOnlyProvider;
        let err = provider
            .open_streaming_session(AudioChannel::Mic, 16000)
            .await
            .unwrap_err();
        assert!(matches!(err, ProviderError::Unreachable(_)));
    }
```

Run: `cd helper && cargo test -p notetaker-core providers::tests::default_open_streaming_session_is_unsupported`
Expected: FAIL — `no method named \`open_streaming_session\`` (compile error).

- [ ] **Step 2: Add the trait method and `StreamingSession` trait**

In `helper/crates/core/src/providers/mod.rs`, add after the
`TranscriptSegment` struct definition:

```rust
/// A persistent low-latency transcription session opened by a streaming
/// provider. Unlike `TranscriptionProvider::transcribe_chunk`, this is not
/// request/response — audio is pushed in as it's captured and results
/// arrive asynchronously, often before the whole utterance has been said.
#[async_trait]
pub trait StreamingSession: Send {
    /// Feed already-disk-persisted PCM16 into the session. Fire-and-forget
    /// at the network layer — never waits for a transcription result.
    async fn send_audio(&mut self, pcm16: &[u8]) -> Result<(), ProviderError>;
    /// Drain whatever results have arrived since the last call, paired
    /// with a locally-assigned utterance id (see module docs on
    /// `DeepgramProvider` for the increment rule). An empty Vec is the
    /// normal, common case.
    async fn try_recv_segments(&mut self) -> Vec<(TranscriptSegment, u32)>;
    /// True once the underlying connection has dropped and the caller
    /// must open a new session to keep streaming.
    fn is_closed(&self) -> bool;
    /// Signal end-of-audio and drain any trailing final segments.
    async fn close(&mut self) -> Vec<(TranscriptSegment, u32)>;
}
```

Then add this method to the `TranscriptionProvider` trait definition
(inside the existing `pub trait TranscriptionProvider: Send + Sync { ... }`
block):

```rust
    /// Streaming providers override this to open a persistent
    /// low-latency session. Default: unsupported — every batch-only
    /// provider (Groq, and Deepgram's own batch path) keeps this as-is.
    async fn open_streaming_session(
        &self,
        _channel: AudioChannel,
        _sample_rate_hz: u32,
    ) -> Result<Box<dyn StreamingSession>, ProviderError> {
        Err(ProviderError::Unreachable("streaming not supported".into()))
    }
```

- [ ] **Step 3: Run the test to confirm it passes**

Run: `cd helper && cargo test -p notetaker-core providers::tests::default_open_streaming_session_is_unsupported`
Expected: PASS

- [ ] **Step 4: Run the full core test suite to check nothing else broke**

Run: `cd helper && cargo test -p notetaker-core`
Expected: PASS (adding a default trait method must not require changes to
Groq/Claude/Gemini/Deepseek, since it has a default body)

- [ ] **Step 5: Commit**

```bash
git add helper/crates/core/src/providers/mod.rs
git commit -m "feat: add StreamingSession trait with default unsupported hook"
```

---

### Task 3: Implement Deepgram's real WebSocket streaming session

**Files:**
- Modify: `helper/Cargo.toml` (workspace deps)
- Modify: `helper/crates/core/Cargo.toml`
- Modify: `helper/crates/core/src/providers/deepgram.rs`

**Interfaces:**
- Consumes: `StreamingSession`, `TranscriptionProvider::open_streaming_session` (Task 2); `AudioChannel`, `TranscriptSegment`, `ProviderError` (existing, `providers/mod.rs`).
- Produces: `DeepgramProvider::open_streaming_session` (overrides the trait default), `DeepgramProvider::is_streaming() -> true`. Internal `DeepgramStreamingSession` type is not exported — only reached via the trait object. Also produces a refactored `fn segments_from_alternative(alternative: &serde_json::Value, channel: AudioChannel, is_final: bool) -> Vec<TranscriptSegment>` (extracted from the existing `parse_response`, now taking `is_final` as a parameter instead of hardcoding `true`) and `fn parse_streaming_message(body: &serde_json::Value, channel: AudioChannel) -> Option<Vec<TranscriptSegment>>` — both used by Task 4's tests directly (`#[cfg(test)]`-visible via `pub(crate)` or plain module-private since tests live in the same file).

- [ ] **Step 1: Add dependencies**

In `helper/Cargo.toml`, in the `[workspace.dependencies]` table, add:

```toml
tokio-tungstenite = { version = "0.24", features = ["rustls-tls-webpki-roots"] }
futures-util = "0.3"
```

In `helper/crates/core/Cargo.toml`, in `[dependencies]`, add:

```toml
tokio-tungstenite.workspace = true
futures-util.workspace = true
```

Run: `cd helper && cargo build -p notetaker-core`
Expected: succeeds (downloads the new crates — network to crates.io is
reachable, verified during design).

- [ ] **Step 2: Refactor `parse_response` to extract a shared,
      is_final-parameterized helper (no behavior change — batch path
      still always passes `true`)**

In `helper/crates/core/src/providers/deepgram.rs`, replace the existing
`parse_response` function body with a version that delegates to a new
`segments_from_alternative`, and update `group_by_speaker` to accept and
apply the `is_final` value instead of hardcoding it:

```rust
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

/// Shared by the batch response parser above and the streaming message
/// parser below — both eventually have one Deepgram "alternative" object
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
        return vec![TranscriptSegment {
            speaker: "you".into(),
            text: transcript,
            is_final,
        }];
    }

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
```

Update `group_by_speaker`'s signature and both `TranscriptSegment` push
sites inside it to take and use `is_final: bool` instead of the literal
`true`:

```rust
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
```

Run: `cd helper && cargo test -p notetaker-core deepgram`
Expected: PASS — every existing test in this file must still pass
unchanged, since batch behavior (`is_final: true` always) is preserved.
This is a refactor step, not a behavior change; if any existing test
fails, stop and fix the refactor before continuing (don't proceed to
Step 3 on red).

- [ ] **Step 3: Write the failing streaming-message parser test**

Add to the `#[cfg(test)] mod tests` block in the same file:

```rust
    #[test]
    fn parses_streaming_interim_message() {
        let body = json!({
            "is_final": false,
            "channel": { "alternatives": [ { "transcript": "hello wor" } ] }
        });
        let segments = parse_streaming_message(&body, AudioChannel::Mic).unwrap();
        assert_eq!(segments, vec![TranscriptSegment { speaker: "you".into(), text: "hello wor".into(), is_final: false }]);
    }

    #[test]
    fn parses_streaming_final_message() {
        let body = json!({
            "is_final": true,
            "channel": { "alternatives": [ { "transcript": "hello world" } ] }
        });
        let segments = parse_streaming_message(&body, AudioChannel::Mic).unwrap();
        assert_eq!(segments, vec![TranscriptSegment { speaker: "you".into(), text: "hello world".into(), is_final: true }]);
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
```

Run: `cd helper && cargo test -p notetaker-core deepgram::tests::parses_streaming_interim_message`
Expected: FAIL — `cannot find function \`parse_streaming_message\``.

- [ ] **Step 4: Implement `parse_streaming_message`**

Add to `helper/crates/core/src/providers/deepgram.rs` (outside the test
module, near `parse_response`):

```rust
/// Parses one message from Deepgram's live-streaming WebSocket protocol.
/// Returns `None` for anything that isn't a transcript result (e.g. the
/// periodic `Metadata` message) or has no words yet.
fn parse_streaming_message(body: &Value, channel: AudioChannel) -> Option<Vec<TranscriptSegment>> {
    let is_final = body.get("is_final").and_then(Value::as_bool).unwrap_or(false);
    let alternative = body.pointer("/channel/alternatives/0")?;
    let segments = segments_from_alternative(alternative, channel, is_final);
    if segments.is_empty() {
        None
    } else {
        Some(segments)
    }
}
```

Run: `cd helper && cargo test -p notetaker-core deepgram::tests`
Expected: PASS (all four new tests plus every pre-existing test in the
file).

- [ ] **Step 5: Add streaming fields to `DeepgramProvider` and a
      test-only streaming base URL override**

Change the `DeepgramProvider` struct and constructors:

```rust
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

    #[cfg(test)]
    fn with_base_url(api_key: String, base_url: String) -> Self {
        Self {
            api_key,
            client: provider_client(),
            base_url,
            stream_url: DEEPGRAM_STREAM_URL.to_string(),
        }
    }

    /// Test-only constructor pointing the streaming session at a local
    /// fake WebSocket server instead of Deepgram's real endpoint.
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
```

Run: `cd helper && cargo build -p notetaker-core --tests`
Expected: compiles (no test yet exercises `with_stream_url`, that's
Task 4).

- [ ] **Step 6: Implement `DeepgramStreamingSession` and
      `open_streaming_session`/`is_streaming`**

Add near the top of `deepgram.rs`:

```rust
use futures_util::{SinkExt, StreamExt};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message as WsMessage;
```

Add the session type and the trait impls (after the existing
`#[async_trait] impl TranscriptionProvider for DeepgramProvider` block):

```rust
struct DeepgramStreamingSession {
    write: futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
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
        if self.write.send(WsMessage::Binary(pcm16.to_vec())).await.is_err() {
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
    // ... existing id()/is_streaming()/transcribe_chunk() stay, except:
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
}
```

Note: this replaces the *whole* existing
`impl TranscriptionProvider for DeepgramProvider` block (add the two new
methods into it — don't create a second `impl` block, Rust doesn't allow
that for the same trait/type pair).

Also change the doc comment at the top of the file (lines 1-7) — replace
the "Implemented against Deepgram's synchronous... not the live-streaming
WebSocket endpoint" note with:

```rust
//! Deepgram transcription provider — default tier. Implements both the
//! synchronous prerecorded (batch) REST endpoint, used for API-key
//! validation and gap-backfill after a WebSocket drop, and the real
//! live-streaming WebSocket endpoint, used for the actual meeting
//! transcript. See `docs/superpowers/specs/2026-09-22-deepgram-live-streaming-design.md`.
```

Run: `cd helper && cargo build -p notetaker-core`
Expected: compiles cleanly.

- [ ] **Step 7: Commit**

```bash
git add helper/Cargo.toml helper/crates/core/Cargo.toml helper/crates/core/src/providers/deepgram.rs helper/Cargo.lock
git commit -m "feat: implement Deepgram WebSocket live-streaming session"
```

---

### Task 4: Test the streaming session against a real local fake Deepgram server

**Files:**
- Modify: `helper/crates/core/src/providers/deepgram.rs` (test module only)

**Interfaces:**
- Consumes: `DeepgramProvider::with_stream_url` (Task 3), `StreamingSession` trait (Task 2).
- Produces: nothing new for other tasks — this task is pure test coverage, closing the "no WebSocket mock harness" gap noted in the original scope comment.

- [ ] **Step 1: Add a real local WebSocket test server helper**

Add to the `#[cfg(test)] mod tests` block:

```rust
    use tokio::net::TcpListener;
    use tokio_tungstenite::accept_async;

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
        format!("ws://{}", addr)
    }
```

- [ ] **Step 2: Write the failing interim-then-final sequencing test**

```rust
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
        for _ in 0..20 {
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
        // Same utterance id for the interim and the final that completes it.
        assert_eq!(collected[0].1, collected[1].1);
    }
```

Run: `cd helper && cargo test -p notetaker-core deepgram::tests::streaming_session_reports_interim_then_final_with_stable_utterance_id`
Expected: FAIL initially only if Task 3's implementation has a bug —
otherwise this should already PASS since Task 3 fully implements the
session. If it fails, debug against Task 3's implementation before
continuing (this test is the first real exercise of that code against an
actual socket).

- [ ] **Step 3: Write the failing next-utterance-gets-a-new-id test**

```rust
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
        for _ in 0..20 {
            collected.extend(session.try_recv_segments().await);
            if collected.len() >= 2 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }

        assert_eq!(collected.len(), 2);
        assert_ne!(collected[0].1, collected[1].1);
    }
```

Run: `cd helper && cargo test -p notetaker-core deepgram::tests::streaming_session_increments_utterance_id_after_a_final`
Expected: PASS

- [ ] **Step 4: Write the failing disconnect-detection test**

```rust
    #[tokio::test]
    async fn streaming_session_reports_closed_after_server_drops_connection() {
        let stream_url = spawn_fake_deepgram_server(vec![(vec![], true)]).await;
        let provider = DeepgramProvider::with_stream_url("test-key".into(), stream_url);
        let mut session = provider
            .open_streaming_session(AudioChannel::Speaker, 16000)
            .await
            .unwrap();

        let mut closed = false;
        for _ in 0..20 {
            if session.is_closed() {
                closed = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert!(closed, "session should observe the server closing the connection");
    }
```

Run: `cd helper && cargo test -p notetaker-core deepgram::tests::streaming_session_reports_closed_after_server_drops_connection`
Expected: PASS

- [ ] **Step 5: Run the full file's tests together**

Run: `cd helper && cargo test -p notetaker-core deepgram`
Expected: PASS — every batch test (unchanged) plus every new streaming
test.

- [ ] **Step 6: Commit**

```bash
git add helper/crates/core/src/providers/deepgram.rs
git commit -m "test: exercise Deepgram streaming session against a real local WS server"
```

---

### Task 5: Wire streaming into the pipeline

**Files:**
- Modify: `helper/crates/core/src/pipeline.rs`

**Interfaces:**
- Consumes: `TranscriptionProvider::is_streaming()`/`open_streaming_session` (Task 2/3), `StreamingSession` (Task 2), `HelperToExtension::TranscriptPartial` with `utterance_id` (Task 1).
- Produces: `Pipeline` behavior change only — no new public methods. `handle_audio_chunk`, `flush_pending_audio`, and `stop_recording`'s existing signatures are unchanged; callers in `crates/app/src/main.rs` need no changes.

- [ ] **Step 1: Add streaming state fields to `Pipeline`**

In `helper/crates/core/src/pipeline.rs`, add to the `Pipeline` struct and
`Pipeline::new`:

```rust
pub struct Pipeline {
    store: MeetingStore,
    transcription_provider: Box<dyn TranscriptionProvider>,
    summarization_provider: Box<dyn SummarizationProvider>,
    summary_options: SummaryOptions,
    retry_queue: RetryQueue<RetryableChunk>,
    accepting_audio: bool,
    pending_mic: Option<PendingAudio>,
    pending_speaker: Option<PendingAudio>,
    // --- streaming-provider state (unused when is_streaming() is false) ---
    mic_session: Option<Box<dyn StreamingSession>>,
    speaker_session: Option<Box<dyn StreamingSession>>,
    /// Byte offset in the channel's on-disk file that has never been
    /// handed to any streaming session (either none has ever opened, or
    /// the previous one dropped). `None` means fully caught up.
    mic_stream_gap_start: Option<usize>,
    speaker_stream_gap_start: Option<usize>,
}
```

```rust
    pub fn new(
        store: MeetingStore,
        transcription_provider: Box<dyn TranscriptionProvider>,
        summarization_provider: Box<dyn SummarizationProvider>,
        retry_queue: RetryQueue<RetryableChunk>,
    ) -> Self {
        Self {
            store,
            transcription_provider,
            summarization_provider,
            summary_options: SummaryOptions::default(),
            retry_queue,
            accepting_audio: false,
            pending_mic: None,
            pending_speaker: None,
            mic_session: None,
            speaker_session: None,
            mic_stream_gap_start: None,
            speaker_stream_gap_start: None,
        }
    }
```

Run: `cd helper && cargo build -p notetaker-core`
Expected: FAIL — every other `Pipeline` struct literal (in tests) that
constructs it directly would break, but there are none (tests all go
through `Pipeline::new`) — this should actually compile. If it doesn't,
the error will name the exact literal to fix.

- [ ] **Step 2: Write the failing streaming end-to-end pipeline test**

Add to the `#[cfg(test)] mod tests` block in `pipeline.rs`, alongside the
existing `FakeTranscriber`. First add a fake streaming provider +
session:

```rust
    struct FakeStreamingSession {
        outbox: std::collections::VecDeque<(TranscriptSegment, u32)>,
        closed: bool,
    }

    #[async_trait]
    impl crate::providers::StreamingSession for FakeStreamingSession {
        async fn send_audio(&mut self, _pcm16: &[u8]) -> Result<(), ProviderError> {
            if self.closed {
                return Err(ProviderError::Unreachable("closed".into()));
            }
            Ok(())
        }
        async fn try_recv_segments(&mut self) -> Vec<(TranscriptSegment, u32)> {
            self.outbox.drain(..).collect()
        }
        fn is_closed(&self) -> bool {
            self.closed
        }
        async fn close(&mut self) -> Vec<(TranscriptSegment, u32)> {
            self.outbox.drain(..).collect()
        }
    }

    struct FakeStreamingTranscriber {
        next_segment: std::sync::Mutex<Option<(TranscriptSegment, u32)>>,
    }

    #[async_trait]
    impl TranscriptionProvider for FakeStreamingTranscriber {
        fn id(&self) -> TranscriptionProviderId {
            TranscriptionProviderId::Deepgram
        }
        fn is_streaming(&self) -> bool {
            true
        }
        async fn transcribe_chunk(
            &self,
            _chunk: &AudioChunk,
        ) -> Result<Vec<TranscriptSegment>, ProviderError> {
            Ok(vec![])
        }
        async fn open_streaming_session(
            &self,
            _channel: AudioChannel,
            _sample_rate_hz: u32,
        ) -> Result<Box<dyn crate::providers::StreamingSession>, ProviderError> {
            let mut outbox = std::collections::VecDeque::new();
            if let Some(seg) = self.next_segment.lock().unwrap().take() {
                outbox.push_back(seg);
            }
            Ok(Box::new(FakeStreamingSession {
                outbox,
                closed: false,
            }))
        }
    }
```

Then the test itself:

```rust
    #[tokio::test]
    async fn streaming_provider_emits_partial_without_waiting_for_batch_window() {
        let dir = tempfile::tempdir().unwrap();
        let store = MeetingStore::new(dir.path()).unwrap();
        let retry_queue = RetryQueue::load_or_create(dir.path().join("retry.json")).unwrap();
        let provider = FakeStreamingTranscriber {
            next_segment: std::sync::Mutex::new(Some((
                TranscriptSegment {
                    speaker: "you".into(),
                    text: "hi".into(),
                    is_final: true,
                },
                0,
            ))),
        };
        let mut pipeline = Pipeline::new(
            store,
            Box::new(provider),
            Box::new(FakeSummarizer),
            retry_queue,
        );
        let meeting_id = Uuid::new_v4();
        pipeline.start_recording(meeting_id).unwrap();

        // One tiny chunk — far below TRANSCRIPTION_BATCH_SECONDS worth of
        // audio, which would never flush on the batch path.
        let messages = pipeline
            .handle_audio_chunk(meeting_id, AudioChannel::Mic, &[0, 1, 2, 3], 16000)
            .await;

        assert!(messages.iter().any(|m| matches!(
            m,
            HelperToExtension::TranscriptPartial { text, is_final: true, .. } if text == "hi"
        )));
    }
```

Run: `cd helper && cargo test -p notetaker-core pipeline::tests::streaming_provider_emits_partial_without_waiting_for_batch_window`
Expected: FAIL — `handle_audio_chunk` doesn't branch on `is_streaming()`
yet, so this chunk just gets buffered into `pending_mic` and no message
is emitted.

- [ ] **Step 3: Implement the streaming branch in `handle_audio_chunk`**

In `pipeline.rs`, right after the existing disk-persist block (the
`if let Err(e) = self.store.append_audio(...)` check and the
`mark_audio_sample_rate` call — keep both exactly as-is, persistence is
identical for both paths) and before the existing `PendingAudio`
batching logic, insert a branch:

```rust
        if self.transcription_provider.is_streaming() {
            return self
                .handle_streaming_audio_chunk(
                    meeting_id,
                    channel,
                    channel_file,
                    pcm16,
                    sample_rate_hz,
                    existing_len,
                )
                .await;
        }
```

(This replaces the rest of the function body for the streaming path —
the existing `PendingAudio` batching code below stays untouched and only
runs for non-streaming providers.)

Add the new method:

```rust
    async fn handle_streaming_audio_chunk(
        &mut self,
        meeting_id: Uuid,
        channel: AudioChannel,
        channel_file: &str,
        pcm16: &[u8],
        sample_rate_hz: u32,
        existing_len: usize,
    ) -> Vec<HelperToExtension> {
        let (session, gap_start) = match channel {
            AudioChannel::Mic => (&mut self.mic_session, &mut self.mic_stream_gap_start),
            AudioChannel::Speaker => (&mut self.speaker_session, &mut self.speaker_stream_gap_start),
        };

        if session.is_none() || session.as_ref().is_some_and(|s| s.is_closed()) {
            *session = None;
            gap_start.get_or_insert(existing_len);
            match self
                .transcription_provider
                .open_streaming_session(channel, sample_rate_hz)
                .await
            {
                Ok(new_session) => *session = Some(new_session),
                Err(_) => {
                    // Stay disconnected; audio keeps accumulating on disk
                    // (already persisted above) and the gap keeps growing
                    // until a future call successfully reopens a session.
                    return vec![];
                }
            }
        }

        let mut messages = Vec::new();

        // A session just (re)opened and there's untranscribed history —
        // backfill it exactly once through the existing batch retry path.
        if let Some(start) = gap_start.take() {
            if start < existing_len {
                let backfill = self
                    .store
                    .read_audio_range(meeting_id, channel_file, start, existing_len)
                    .unwrap_or_default();
                if !backfill.is_empty() {
                    messages.extend(
                        self.transcribe_pending(
                            meeting_id,
                            channel,
                            channel_file,
                            PendingAudio {
                                pcm16: backfill,
                                sample_rate_hz,
                                start,
                            },
                        )
                        .await,
                    );
                }
            }
        }

        let session = match channel {
            AudioChannel::Mic => self.mic_session.as_mut(),
            AudioChannel::Speaker => self.speaker_session.as_mut(),
        }
        .expect("session was just ensured to be Some above");

        let streamed_through = existing_len + pcm16.len();
        if session.send_audio(pcm16).await.is_err() {
            let gap_start = match channel {
                AudioChannel::Mic => &mut self.mic_stream_gap_start,
                AudioChannel::Speaker => &mut self.speaker_stream_gap_start,
            };
            gap_start.get_or_insert(existing_len);
            return messages;
        }

        let received = session.try_recv_segments().await;
        let mut saw_final = false;
        for (segment, utterance_id) in received {
            if segment.is_final {
                saw_final = true;
                let _ = self.store.append_transcript_segments(meeting_id, &[segment.clone()]);
            }
            messages.push(HelperToExtension::TranscriptPartial {
                meeting_id,
                speaker: segment.speaker,
                text: segment.text,
                is_final: segment.is_final,
                utterance_id,
            });
        }
        if saw_final {
            let _ = self.store.mark_audio_transcribed(meeting_id, channel_file, streamed_through);
        }
        messages
    }
```

Run: `cd helper && cargo test -p notetaker-core pipeline::tests::streaming_provider_emits_partial_without_waiting_for_batch_window`
Expected: PASS

- [ ] **Step 4: Fix the two existing `transcribe_pending` call sites and
      any other `TranscriptPartial` literal to supply `utterance_id`**

`transcribe_pending` (used by the non-streaming batch path and now also
by the gap-backfill call above) already builds `TranscriptPartial`
messages — find that literal (~line 252, inside the `Ok(segments) =>`
arm of `transcribe_pending`) and give every batch-sourced message a
fresh, always-final id. Since batch segments are always final and there's
no cross-call state to track for them, use a simple per-call counter
seeded from the existing loop:

```rust
                        for (index, segment) in segments.iter().enumerate() {
                            messages.push(HelperToExtension::TranscriptPartial {
                                meeting_id,
                                speaker: segment.speaker.clone(),
                                text: segment.text.clone(),
                                is_final: segment.is_final,
                                utterance_id: (end as u32).wrapping_add(index as u32),
                            });
                        }
```

(Change `for segment in &segments` to `for (index, segment) in segments.iter().enumerate()` at that site. Using the batch's end-offset plus index keeps ids stable and unique per call without adding new per-channel counter state to the non-streaming path — non-streaming providers never need replace-in-place semantics since every message from them is already final.)

Run: `cd helper && cargo build -p notetaker-core --tests`
Expected: compiles. Then:

Run: `cd helper && cargo test -p notetaker-core`
Expected: PASS — full core suite, including every pre-existing pipeline
test (none of their assertions inspect `utterance_id`, so this is
additive).

- [ ] **Step 5: Write the failing WS-drop-triggers-one-gap-backfill-job test**

```rust
    struct DropsAfterOneSendSession {
        closed: std::sync::atomic::AtomicBool,
    }

    #[async_trait]
    impl crate::providers::StreamingSession for DropsAfterOneSendSession {
        async fn send_audio(&mut self, _pcm16: &[u8]) -> Result<(), ProviderError> {
            self.closed.store(true, std::sync::atomic::Ordering::Relaxed);
            Err(ProviderError::Unreachable("dropped".into()))
        }
        async fn try_recv_segments(&mut self) -> Vec<(TranscriptSegment, u32)> {
            vec![]
        }
        fn is_closed(&self) -> bool {
            self.closed.load(std::sync::atomic::Ordering::Relaxed)
        }
        async fn close(&mut self) -> Vec<(TranscriptSegment, u32)> {
            vec![]
        }
    }

    struct DropsThenRecoversTranscriber {
        attempts: std::sync::atomic::AtomicUsize,
    }

    #[async_trait]
    impl TranscriptionProvider for DropsThenRecoversTranscriber {
        fn id(&self) -> TranscriptionProviderId {
            TranscriptionProviderId::Deepgram
        }
        fn is_streaming(&self) -> bool {
            true
        }
        async fn transcribe_chunk(
            &self,
            chunk: &AudioChunk,
        ) -> Result<Vec<TranscriptSegment>, ProviderError> {
            Ok(vec![TranscriptSegment {
                speaker: "you".into(),
                text: format!("backfilled {} bytes", chunk.pcm16.len()),
                is_final: true,
            }])
        }
        async fn open_streaming_session(
            &self,
            _channel: AudioChannel,
            _sample_rate_hz: u32,
        ) -> Result<Box<dyn crate::providers::StreamingSession>, ProviderError> {
            self.attempts.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Ok(Box::new(DropsAfterOneSendSession {
                closed: std::sync::atomic::AtomicBool::new(false),
            }))
        }
    }

    #[tokio::test]
    async fn ws_drop_enqueues_one_gap_backfill_job_via_existing_retry_queue() {
        let dir = tempfile::tempdir().unwrap();
        let store = MeetingStore::new(dir.path()).unwrap();
        let retry_queue = RetryQueue::load_or_create(dir.path().join("retry.json")).unwrap();
        let provider = DropsThenRecoversTranscriber {
            attempts: std::sync::atomic::AtomicUsize::new(0),
        };
        let mut pipeline = Pipeline::new(store, Box::new(provider), Box::new(FakeSummarizer), retry_queue);
        let meeting_id = Uuid::new_v4();
        pipeline.start_recording(meeting_id).unwrap();

        // First chunk: session opens, send_audio fails immediately (fake
        // session drops on first send) -> gap starts at offset 0.
        let _ = pipeline
            .handle_audio_chunk(meeting_id, AudioChannel::Mic, &[9, 9], 16000)
            .await;
        // Second chunk: session is closed, so a new one opens; the gap
        // [0, existing_len) must get backfilled via transcribe_chunk
        // (the batch path) before new audio streams live again.
        let messages = pipeline
            .handle_audio_chunk(meeting_id, AudioChannel::Mic, &[8, 8], 16000)
            .await;

        assert!(messages.iter().any(|m| matches!(
            m,
            HelperToExtension::TranscriptPartial { text, .. } if text.starts_with("backfilled")
        )));
    }
```

Run: `cd helper && cargo test -p notetaker-core pipeline::tests::ws_drop_enqueues_one_gap_backfill_job_via_existing_retry_queue`
Expected: PASS if Step 3's implementation is correct (this test exercises
the gap-tracking branch added there — if it fails, the bug is in the
`gap_start`/`is_closed` handling in `handle_streaming_audio_chunk`, not
in new code this step adds).

- [ ] **Step 6: Handle `flush_pending_audio` and `stop_recording` for a
      streaming provider (close sessions, emit trailing finals)**

In `flush_pending_audio`, add at the top (before the existing
`pending_mic`/`pending_speaker` flush logic, which stays as the
non-streaming path):

```rust
    pub async fn flush_pending_audio(&mut self, meeting_id: Uuid) -> Vec<HelperToExtension> {
        let mut messages = Vec::new();
        if let Some(mut session) = self.mic_session.take() {
            for (segment, utterance_id) in session.close().await {
                if segment.is_final {
                    let _ = self.store.append_transcript_segments(meeting_id, &[segment.clone()]);
                }
                messages.push(HelperToExtension::TranscriptPartial {
                    meeting_id,
                    speaker: segment.speaker,
                    text: segment.text,
                    is_final: segment.is_final,
                    utterance_id,
                });
            }
        }
        if let Some(mut session) = self.speaker_session.take() {
            for (segment, utterance_id) in session.close().await {
                if segment.is_final {
                    let _ = self.store.append_transcript_segments(meeting_id, &[segment.clone()]);
                }
                messages.push(HelperToExtension::TranscriptPartial {
                    meeting_id,
                    speaker: segment.speaker,
                    text: segment.text,
                    is_final: segment.is_final,
                    utterance_id,
                });
            }
        }
        if let Some(batch) = self.pending_mic.take() {
            messages.extend(
                self.transcribe_pending(meeting_id, AudioChannel::Mic, MIC_FILE, batch)
                    .await,
            );
        }
        if let Some(batch) = self.pending_speaker.take() {
            messages.extend(
                self.transcribe_pending(meeting_id, AudioChannel::Speaker, SPEAKER_FILE, batch)
                    .await,
            );
        }
        messages
    }
```

`stop_recording` and `recover_recording` already call
`flush_pending_audio`/reuse `transcribe_pending` respectively and need no
further changes — closing the sessions here is sufficient, and
`recover_recording`'s existing batch-only tail logic (spec's documented
"known limitation") is intentionally left as-is.

- [ ] **Step 7: Write the failing stop-recording-closes-session test**

```rust
    #[tokio::test]
    async fn stop_recording_closes_streaming_sessions_and_flushes_trailing_final() {
        let dir = tempfile::tempdir().unwrap();
        let store = MeetingStore::new(dir.path()).unwrap();
        let retry_queue = RetryQueue::load_or_create(dir.path().join("retry.json")).unwrap();
        let provider = FakeStreamingTranscriber {
            next_segment: std::sync::Mutex::new(None),
        };
        let mut pipeline = Pipeline::new(store, Box::new(provider), Box::new(FakeSummarizer), retry_queue);
        let meeting_id = Uuid::new_v4();
        pipeline.start_recording(meeting_id).unwrap();
        let _ = pipeline
            .handle_audio_chunk(meeting_id, AudioChannel::Mic, &[1, 2], 16000)
            .await;

        assert!(pipeline.mic_session.is_some());
        let _ = pipeline.stop_recording(meeting_id).await.unwrap();
        assert!(pipeline.mic_session.is_none(), "session must be closed and cleared on stop");
    }
```

Run: `cd helper && cargo test -p notetaker-core pipeline::tests::stop_recording_closes_streaming_sessions_and_flushes_trailing_final`
Expected: PASS

- [ ] **Step 8: Run the full helper test suite**

Run: `cd helper && cargo test --workspace`
Expected: PASS — every crate (`notetaker-core`, `notetaker-audio`,
`notetaker-app`) green.

- [ ] **Step 9: Commit**

```bash
git add helper/crates/core/src/pipeline.rs
git commit -m "feat: stream Deepgram audio through the pipeline with gap-backfill on WS drop"
```

---

### Task 6: Extension — replace-in-place for in-progress utterances

**Files:**
- Modify: `extension/src/lib/backgroundController.ts:249-266`
  (`handleTranscriptPartial`)
- Modify: `extension/src/lib/internalMessages.ts:40` (`TRANSCRIPT_UPDATE`)
- Modify: `extension/src/types.ts` (`TranscriptSegment` interface)
- Test: `extension/tests/backgroundController.test.ts` (existing describe
  block, add tests after the `"appends transcript_partial segments..."`
  test at ~line 137)

**Interfaces:**
- Consumes: `IncomingMessage`'s `transcript_partial` variant with
  `utteranceId: number` (Task 1).
- Produces: `TRANSCRIPT_UPDATE` internal message gains `utteranceId: number`
  — Task 7 (popup.ts) depends on this exact field name.

- [ ] **Step 1: Add `utteranceId` to the stored/broadcast types**

In `extension/src/types.ts`, add to `TranscriptSegment`:

```typescript
export interface TranscriptSegment {
  speaker: Speaker;
  text: string;
  timestamp: string;
  isFinal: boolean;
  /** Absent on segments recorded before this field existed. */
  utteranceId?: number;
}
```

In `extension/src/lib/internalMessages.ts`, change the
`TRANSCRIPT_UPDATE` variant:

```typescript
  | { type: "TRANSCRIPT_UPDATE"; meetingId: string; speaker: Speaker; text: string; isFinal: boolean; utteranceId: number }
```

- [ ] **Step 2: Write the failing replace-in-place test**

The test file is `extension/tests/backgroundController.test.ts` (not
`src/lib/`). It already has an exact pattern for this in the
`"appends transcript_partial segments..."` test (~line 137): build a
`createFakeClient()`, `controller.startRecording()` to create the meeting
record, `client.emit("transcript_partial", {...})` to deliver a message,
`vi.waitFor` to await the async storage round-trip, then `getMeeting`.
Add these two tests in the same `describe("BackgroundController", ...)`
block, right after that existing test:

```typescript
  it("replaces an in-progress line in place instead of appending", async () => {
    const client = createFakeClient();
    const controller = new BackgroundController(client, vi.fn());
    await controller.init();
    const meetingId = await controller.startRecording();

    client.emit("transcript_partial", { meetingId, speaker: "you", text: "hello wor", isFinal: false, utteranceId: 1 });
    await vi.waitFor(async () => {
      expect((await getMeeting(meetingId))?.transcript).toHaveLength(1);
    });

    client.emit("transcript_partial", { meetingId, speaker: "you", text: "hello world", isFinal: true, utteranceId: 1 });
    await vi.waitFor(async () => {
      const meeting = await getMeeting(meetingId);
      expect(meeting?.transcript).toHaveLength(1);
      expect(meeting?.transcript[0].text).toBe("hello world");
      expect(meeting?.transcript[0].isFinal).toBe(true);
    });
  });

  it("starts a new row for a new utteranceId", async () => {
    const client = createFakeClient();
    const controller = new BackgroundController(client, vi.fn());
    await controller.init();
    const meetingId = await controller.startRecording();

    client.emit("transcript_partial", { meetingId, speaker: "you", text: "first", isFinal: true, utteranceId: 1 });
    client.emit("transcript_partial", { meetingId, speaker: "you", text: "second", isFinal: true, utteranceId: 2 });

    await vi.waitFor(async () => {
      expect((await getMeeting(meetingId))?.transcript).toHaveLength(2);
    });
  });
```

Existing tests in this file that emit `transcript_partial` without
`utteranceId` (e.g. the two at ~lines 144 and 169) keep passing unchanged
— `utteranceId` comes through as `undefined` for them, and Vitest's
`toEqual` ignores `undefined`-valued properties on both sides, so their
existing exact-shape assertions (e.g. line 158's `toEqual([{ speaker,
text, isFinal, timestamp }])`) still match.

Run: `cd extension && npm test -- backgroundController`
Expected: FAIL — both new tests show 2 and 3 transcript rows respectively
instead of 1 and 2, since `handleTranscriptPartial` still always pushes.

- [ ] **Step 3: Implement replace-in-place**

Replace `handleTranscriptPartial` in
`extension/src/lib/backgroundController.ts`:

```typescript
  private async handleTranscriptPartial(
    msg: Extract<IncomingMessage, { type: "transcript_partial" }>,
  ): Promise<void> {
    const meeting = await updateMeeting(msg.meetingId, (current) => {
      const existingIndex = current.transcript.findIndex(
        (segment) => segment.speaker === msg.speaker && segment.utteranceId === msg.utteranceId && !segment.isFinal,
      );
      const updated: TranscriptSegment = {
        speaker: msg.speaker,
        text: msg.text,
        isFinal: msg.isFinal,
        utteranceId: msg.utteranceId,
        timestamp: new Date().toISOString(),
      };
      if (existingIndex >= 0) {
        current.transcript[existingIndex] = updated;
      } else {
        current.transcript.push(updated);
      }
      return current;
    });
    if (!meeting) return;
    this.broadcast({
      type: "TRANSCRIPT_UPDATE",
      meetingId: msg.meetingId,
      speaker: msg.speaker,
      text: msg.text,
      isFinal: msg.isFinal,
      utteranceId: msg.utteranceId,
    });
  }
```

(Add `TranscriptSegment` to this file's existing import from `"../types"`
if it isn't already imported.)

Run: `cd extension && npm test -- backgroundController`
Expected: PASS

- [ ] **Step 4: Run the full extension test suite**

Run: `cd extension && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add extension/src/types.ts extension/src/lib/internalMessages.ts extension/src/lib/backgroundController.ts extension/tests/backgroundController.test.ts
git commit -m "feat: replace in-progress transcript line instead of always appending"
```

---

### Task 7: Extension — live "in progress" line in the popup UI

**Files:**
- Modify: `extension/src/popup/popup.ts:99-105` (`appendTranscriptLine`)
  and its two call sites (~lines 120, 134)
- Modify: `extension/src/popup/popup.css` (existing `.transcript-line`
  rule). Note: `extension/src/meeting/meeting.ts`/`meeting.css` also
  render transcript lines but only for a finished meeting's static
  history/export view (no live listener) — out of scope, no changes
  needed there.

**Interfaces:**
- Consumes: `TRANSCRIPT_UPDATE`'s `utteranceId` (Task 6),
  `MeetingRecord.transcript[].utteranceId` (Task 6).

- [ ] **Step 1: Rewrite `appendTranscriptLine` to replace in place**

```typescript
function appendTranscriptLine(
  container: HTMLElement,
  speaker: Speaker,
  text: string,
  isFinal: boolean,
  utteranceId: number | undefined,
): void {
  const key = utteranceId === undefined ? null : `${speaker}:${utteranceId}`;
  const existing = key ? container.querySelector<HTMLElement>(`[data-utterance-key="${CSS.escape(key)}"]`) : null;
  const line = existing ?? document.createElement("div");
  line.className = isFinal ? "transcript-line" : "transcript-line transcript-line-provisional";
  line.innerHTML = `<span class="speaker">${escapeHtml(speakerLabel(speaker))}:</span>${escapeHtml(text)}`;
  if (key) {
    if (isFinal) {
      line.removeAttribute("data-utterance-key");
    } else {
      line.dataset.utteranceKey = key;
    }
  }
  if (!existing) container.appendChild(line);
  container.scrollTop = container.scrollHeight;
}
```

Note the `isFinal`-true branch clears `data-utterance-key` so a later
message that happens to reuse a numerically-wrapped id (`u32::wrapping_add`
in the helper, extremely unlikely in one meeting's lifetime but not
impossible) can never match a stale finalized line — a fresh element gets
created instead.

- [ ] **Step 2: Update both call sites**

At ~line 120 (initial render from stored history):

```typescript
  for (const segment of meeting?.transcript ?? []) {
    appendTranscriptLine(transcriptView, segment.speaker, segment.text, segment.isFinal, segment.utteranceId);
  }
```

At ~line 134 (live update listener):

```typescript
    if (message.type === "TRANSCRIPT_UPDATE" && message.meetingId === meetingId) {
      appendTranscriptLine(transcriptView, message.speaker, message.text, message.isFinal, message.utteranceId);
    }
```

- [ ] **Step 3: Add the provisional-line style**

In the stylesheet found by the earlier grep, add next to the existing
`.transcript-line` rule:

```css
.transcript-line-provisional {
  opacity: 0.65;
  font-style: italic;
}
```

- [ ] **Step 4: Run the extension build and test suite**

Run: `cd extension && npm run build && npm test`
Expected: both PASS (TypeScript compiles, no existing test asserts the
old 4-argument-less `appendTranscriptLine` signature — if one does,
update its call to pass `true, undefined` to preserve prior behavior for
that fixture).

- [ ] **Step 5: Commit**

```bash
git add extension/src/popup/popup.ts extension/src/popup/popup.css
git commit -m "feat: show in-progress transcript line distinctly and replace it in place"
```

---

### Task 8: Full verification pass

**Files:** none (verification only).

- [ ] **Step 1: Helper — full workspace check**

Run: `cd helper && cargo fmt --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace`
Expected: all PASS. Fix any clippy lint or fmt diff this plan's new code
introduced before proceeding (existing pre-plan lints, if any, are out of
scope — only fix what this plan's diff touches).

- [ ] **Step 2: Extension — full check**

Run: `cd extension && npm run lint && npm test && npm run build`
Expected: all PASS.

- [ ] **Step 3: Update `TODO.md`**

In `TODO.md`, find the line:

```
- [ ] Deepgram integration — **implemented against the batch REST
      endpoint, not the live-streaming endpoint** the spec names as
      default; ...
```

Replace the whole bullet with:

```
- [x] Deepgram integration — real WebSocket live-streaming implemented
      per `docs/superpowers/specs/2026-09-22-deepgram-live-streaming-design.md`;
      gap-backfill via the existing batch retry queue on a WS drop; batch
      REST path retained for key-test and backfill. Live handshake against
      Deepgram's real streaming endpoint with a live API key remains
      release-owner validation (this sandbox has no live credentials).
```

- [ ] **Step 4: Run the `notetaker-guardrails-reviewer` agent**

This changes `helper/` (new dependency, new network-facing session type)
and `extension/` (new message field) — both trigger the project's
"run before committing" rule in the root `CLAUDE.md`. Dispatch the
`notetaker-guardrails-reviewer` agent against the diff since
`main`. Address any finding it raises before considering this
sub-project done.

- [ ] **Step 5: Commit the TODO update**

```bash
git add TODO.md
git commit -m "docs: mark Deepgram live-streaming done in TODO"
```
