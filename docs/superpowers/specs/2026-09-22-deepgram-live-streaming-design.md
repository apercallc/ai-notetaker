# Deepgram Live-Streaming Design

Date: 2026-09-22
Status: Approved, implementation in progress

## Problem

`helper/crates/core/src/providers/deepgram.rs` is implemented against
Deepgram's synchronous prerecorded (batch) REST endpoint
(`POST /v1/listen`), not the live-streaming WebSocket endpoint the
architecture spec (§3, transcription providers) names as the production
default. Today every provider — including Deepgram — gets audio batched
into 5-second windows (`pipeline.rs::TRANSCRIPTION_BATCH_SECONDS`) before a
request is made, so users see transcript updates in ~5s bursts instead of
live captions.

## Goals

- Real Deepgram WebSocket streaming: sub-second partial transcripts as
  audio arrives, corrected into a final segment per utterance.
- Preserve the resilience guarantee: raw audio hits disk before any network
  call, unconditionally, for every provider.
- No behavior change for other providers (Groq, Claude, Gemini, DeepSeek) —
  they stay on the existing batch path.
- No regression to the retry-queue/recovery model used by batch providers.

## Non-goals

- Changing any other provider's transport.
- Cross-browser, calendar, or webapp-auth work (separate sub-projects).
- A generic "streaming provider" abstraction beyond what Deepgram needs —
  YAGNI until a second streaming provider actually exists.

## Architecture

Two long-lived WebSocket sessions per active meeting — one for the mic
channel, one for the speaker channel — opened when `start_recording` runs
for a streaming-capable provider, closed on `stop_recording`/session error.

### Provider trait split

`TranscriptionProvider` (existing, `providers/mod.rs`) stays a
request/response trait — used for the "test key" button and for
gap-backfill (below). It cannot express a persistent session, so a second
trait is added for providers that support it:

```rust
#[async_trait]
pub trait StreamingTranscriptionProvider: Send + Sync {
    async fn open_session(
        &self,
        channel: AudioChannel,
        sample_rate_hz: u32,
    ) -> Result<Box<dyn StreamingSession>, ProviderError>;
}

#[async_trait]
pub trait StreamingSession: Send {
    /// Feed already-persisted PCM16 into the session. Never blocks on a
    /// network response — the WS send is fire-and-forget per frame.
    async fn send_audio(&mut self, pcm16: &[u8]) -> Result<(), ProviderError>;
    /// Drain whatever results have arrived since the last call. Empty
    /// Vec is normal — most calls will not have a result ready yet.
    async fn try_recv_segments(&mut self) -> Vec<(TranscriptSegment, u32)>; // (segment, utterance_id)
    /// True once the session has dropped and needs to be reopened.
    fn is_closed(&self) -> bool;
    async fn close(&mut self) -> Vec<(TranscriptSegment, u32)>; // flush trailing finals
}
```

`DeepgramProvider` implements both traits. `is_streaming()` on the existing
`TranscriptionProvider` trait (already present, currently `false` for
every provider) becomes the pipeline's switch: `true` only for Deepgram
once this lands.

### Utterance IDs

Deepgram's interim-results protocol re-sends the whole current utterance
text on every interim message, revising it until a final. There's no
persistent ID in Deepgram's payload, so the helper assigns one locally:
a `u32` counter per channel, incremented every time a **final** segment is
emitted for that channel. All messages belonging to the same in-progress
utterance carry the counter's current value; the extension uses
`(speaker, utteranceId)` to know whether an incoming message replaces the
currently-displayed provisional line or starts a new one.

### Pipeline changes (`pipeline.rs`)

- `handle_audio_chunk`: unchanged resilience step (persist to disk first).
  For a streaming provider, skip `PendingAudio` batching entirely — call
  `session.send_audio(pcm16)` directly, then `try_recv_segments()` and
  convert each into `HelperToExtension::TranscriptPartial` (now carrying
  `utteranceId`). Non-streaming providers keep the existing 5s-batch path
  unchanged.
- Only **final** segments are appended to the on-disk transcript
  (`store.append_transcript_segments`) and count toward
  `mark_audio_transcribed`. Interim segments are broadcast to the
  extension only, never persisted — this keeps `recover_recording` and
  `resummarize_if_finalized` untouched, since they only ever see the
  already-existing "final segments on disk" shape.
- `flush_pending_audio`/`stop_recording`: for a streaming provider, call
  `session.close()` on both channels and emit any trailing final segments
  it returns, instead of flushing a `PendingAudio` batch (there isn't one).

### Resilience: WS drop mid-meeting

When `send_audio` or the receive loop reports the session is closed:

1. The gap is exactly the byte range already persisted to disk but not yet
   acknowledged as sent over the dead session (tracked the same way
   `PendingAudio.start` already tracks offsets for batch providers).
2. Pipeline enqueues **one** job into the existing `RetryQueue<RetryableChunk>`
   for that byte range, using Deepgram's already-tested batch
   `transcribe_chunk` (the existing `TranscriptionProvider` impl) as the
   backfill mechanism — reusing `process_due_retries` unchanged. This is
   the same retry queue and job shape batch providers already use; nothing
   new to build there.
3. Independently, the pipeline attempts to reopen the WS session with
   capped exponential backoff. Once reconnected, new audio (from the
   reconnect point forward) streams live again; the gap was already
   covered by step 2.

This means a streaming provider never loses a transcript segment to a
network blip — it just gets that one segment slightly later, via REST
instead of WS, exactly like a batch-provider retry looks today.

### Protocol change (`docs/native-messaging-protocol.md` + both sides)

`transcript_partial` gains an additive field:

```jsonc
{ "type": "transcript_partial", "meetingId": "...", "speaker": "them-2",
  "text": "how are", "isFinal": false, "utteranceId": 4 }
```

Backward compatible: non-streaming providers emit a fresh `utteranceId`
per message (every message from them is already final), so existing
behavior is unchanged for Groq/Claude/Gemini/DeepSeek.

### Extension change

`handleTranscriptPartial` (`extension/src/lib/backgroundController.ts:249`)
currently always appends a new transcript row. New behavior:

- If an existing row for `(speaker, utteranceId)` is not yet final, replace
  its text in place instead of appending.
- When a message arrives with `isFinal: true`, commit that row as final;
  the next message for that speaker (necessarily a new `utteranceId`)
  starts a fresh row.
- Transcript UI (`extension/src/`) gets a subtle visual treatment
  (reduced opacity or dashed underline) for the not-yet-final row, matching
  the existing `is_final` field already threaded through
  `types.ts`/`internalMessages.ts`. Covered by a `notetaker-design-reviewer`
  pass once built.

## Testing

- **Helper:** a real local WebSocket server started in-test
  (`tokio-tungstenite`, bind `127.0.0.1:0`) speaking a minimal
  Deepgram-shaped streaming protocol (interim/final JSON messages over the
  same wire shape `parse_response` already parses for words/speakers).
  This resolves the "no WebSocket mock harness" gap noted in the original
  implementation's scope comment — no live Deepgram credentials needed.
  Covers: interim→final sequencing and utterance-id assignment, mid-stream
  disconnect triggering exactly one REST backfill job via the existing
  `wiremock` batch mock, and reconnect resuming live streaming after.
- **Extension:** unit tests for the replace-vs-append logic in
  `handleTranscriptPartial` keyed on `(speaker, utteranceId)`.
- Existing `DeepgramProvider` (batch) tests are unchanged — still exercised
  by the key-test button and the gap-backfill path.

## Dependencies

Adds `tokio-tungstenite` (+ `futures-util` for the split sink/stream) to
`helper/crates/core/Cargo.toml`. Verified reachable from this environment
(`https://index.crates.io/config.json` returns 200).

## Rollout

Deepgram is the "default tier" provider (per README/cost docs), so this
change affects the default experience once merged. No feature flag —
`is_streaming()` being `true` for `DeepgramProvider` is the switch, and the
existing per-provider selection in settings already lets a user pick a
different (batch) provider if they'd rather not use streaming.
