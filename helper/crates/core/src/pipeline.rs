//! Ties storage, providers, and the retry queue into the actual
//! record -> transcribe -> summarize flow, and turns the results into the
//! `HelperToExtension` messages defined by the wire protocol.
//!
//! This is the piece that owns the pipeline per the architecture's
//! non-negotiable constraint ("the desktop helper owns the AI pipeline,
//! not the Chrome extension") — everything above this module is either
//! transport (native_messaging) or a provider implementation detail.

use crate::native_messaging::{ActionItem, ErrorCode, HelperToExtension};
use crate::providers::{AudioChannel, AudioChunk, SummarizationProvider, TranscriptionProvider};
use crate::resilience::RetryQueue;
use crate::storage::{MeetingState, MeetingStore, MIC_FILE, SPEAKER_FILE};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Batch callback-sized audio frames before calling a batch transcription
/// provider. cpal commonly delivers 10–100 ms frames; sending each one to an
/// HTTP API creates hundreds of requests during a meeting without improving
/// transcript quality. Five seconds keeps rolling updates useful while
/// keeping request volume sane.
const TRANSCRIPTION_BATCH_SECONDS: usize = 5;

struct PendingAudio {
    pcm16: Vec<u8>,
    sample_rate_hz: u32,
    start: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetryableChunk {
    pub meeting_id: Uuid,
    pub channel: AudioChannel,
    pub sample_rate_hz: u32,
    /// Path to the audio on disk rather than the bytes themselves — the
    /// retry queue is small JSON, not a second copy of every audio chunk.
    pub audio_ref: RetryAudioRef,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum RetryAudioRef {
    /// Offset range within the channel's on-disk PCM file, so retrying
    /// re-reads exactly the bytes that failed rather than the whole file.
    FileRange {
        channel_file: String,
        start: usize,
        end: usize,
    },
}

pub struct Pipeline {
    store: MeetingStore,
    transcription_provider: Box<dyn TranscriptionProvider>,
    summarization_provider: Box<dyn SummarizationProvider>,
    retry_queue: RetryQueue<RetryableChunk>,
    accepting_audio: bool,
    pending_mic: Option<PendingAudio>,
    pending_speaker: Option<PendingAudio>,
}

impl Pipeline {
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
            retry_queue,
            accepting_audio: false,
            pending_mic: None,
            pending_speaker: None,
        }
    }

    pub fn start_recording(
        &mut self,
        meeting_id: Uuid,
    ) -> Result<HelperToExtension, PipelineError> {
        self.store.create_meeting(meeting_id, Utc::now())?;
        self.accepting_audio = true;
        Ok(HelperToExtension::RecordingStarted { meeting_id })
    }

    /// Persists every callback frame immediately, then batches it for a
    /// provider call. A crash can therefore lose at most the in-memory
    /// transcription batch, never the raw audio.
    pub async fn handle_audio_chunk(
        &mut self,
        meeting_id: Uuid,
        channel: AudioChannel,
        pcm16: &[u8],
        sample_rate_hz: u32,
    ) -> Vec<HelperToExtension> {
        if !self.accepting_audio {
            // Audio callbacks already queued while stop_recording was waiting
            // for the capture device must not reopen a finalized meeting.
            return vec![];
        }
        let channel_file = match channel {
            AudioChannel::Mic => MIC_FILE,
            AudioChannel::Speaker => SPEAKER_FILE,
        };

        // Resilience guarantee: audio hits disk before any network call.
        let existing_len = std::fs::metadata(self.store.audio_path(meeting_id, channel_file))
            .map(|m| m.len() as usize)
            .unwrap_or(0);
        if let Err(e) = self.store.append_audio(meeting_id, channel_file, pcm16) {
            return vec![HelperToExtension::Error {
                meeting_id: Some(meeting_id),
                code: ErrorCode::DeviceNotFound,
                message: format!("failed to persist audio to disk: {e}"),
            }];
        }

        let mut messages = Vec::new();
        let previous = match channel {
            AudioChannel::Mic
                if self
                    .pending_mic
                    .as_ref()
                    .is_some_and(|audio| audio.sample_rate_hz != sample_rate_hz) =>
            {
                self.pending_mic.take()
            }
            AudioChannel::Speaker
                if self
                    .pending_speaker
                    .as_ref()
                    .is_some_and(|audio| audio.sample_rate_hz != sample_rate_hz) =>
            {
                self.pending_speaker.take()
            }
            _ => None,
        };
        if let Some(previous) = previous {
            messages.extend(
                self.transcribe_pending(meeting_id, channel, channel_file, previous)
                    .await,
            );
        }
        let pending = match channel {
            AudioChannel::Mic => &mut self.pending_mic,
            AudioChannel::Speaker => &mut self.pending_speaker,
        };
        let pending_audio = pending.get_or_insert_with(|| PendingAudio {
            pcm16: Vec::new(),
            sample_rate_hz,
            start: existing_len,
        });
        pending_audio.pcm16.extend_from_slice(pcm16);

        let batch_bytes = sample_rate_hz
            .saturating_mul(2)
            .saturating_mul(TRANSCRIPTION_BATCH_SECONDS as u32) as usize;
        if pending_audio.pcm16.len() >= batch_bytes {
            if let Some(batch) = pending.take() {
                messages.extend(
                    self.transcribe_pending(meeting_id, channel, channel_file, batch)
                        .await,
                );
            }
        }
        messages
    }

    /// Flushes any sub-threshold audio before final summarization.
    pub async fn flush_pending_audio(&mut self, meeting_id: Uuid) -> Vec<HelperToExtension> {
        let mut messages = Vec::new();
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

    async fn transcribe_pending(
        &mut self,
        meeting_id: Uuid,
        channel: AudioChannel,
        channel_file: &str,
        pending: PendingAudio,
    ) -> Vec<HelperToExtension> {
        let end = pending.start + pending.pcm16.len();
        let chunk = AudioChunk {
            channel,
            pcm16: pending.pcm16,
            sample_rate_hz: pending.sample_rate_hz,
        };
        match self.transcription_provider.transcribe_chunk(&chunk).await {
            Ok(segments) => {
                let mut messages = Vec::new();
                let _ = self.store.append_transcript_segments(meeting_id, &segments);
                for segment in &segments {
                    messages.push(HelperToExtension::TranscriptPartial {
                        meeting_id,
                        speaker: segment.speaker.clone(),
                        text: segment.text.clone(),
                        is_final: segment.is_final,
                    });
                }
                messages
            }
            Err(e) => {
                let retryable = RetryableChunk {
                    meeting_id,
                    channel,
                    sample_rate_hz: chunk.sample_rate_hz,
                    audio_ref: RetryAudioRef::FileRange {
                        channel_file: channel_file.to_string(),
                        start: pending.start,
                        end,
                    },
                };
                let _ = self.retry_queue.enqueue(retryable, Utc::now());
                vec![HelperToExtension::Error {
                    meeting_id: Some(meeting_id),
                    code: e.to_error_code(),
                    message: format!("transcription failed, queued for retry: {e}"),
                }]
            }
        }
    }

    pub async fn stop_recording(
        &mut self,
        meeting_id: Uuid,
    ) -> Result<Vec<HelperToExtension>, PipelineError> {
        self.accepting_audio = false;
        self.store.mark_stopped(meeting_id, Utc::now())?;
        let mut messages = vec![HelperToExtension::RecordingStopped { meeting_id }];
        messages.extend(self.flush_pending_audio(meeting_id).await);

        let transcript = self.store.load_transcript(meeting_id)?;
        match self.summarization_provider.summarize(&transcript).await {
            Ok(summary) => {
                self.store.mark_processed(meeting_id)?;
                messages.push(HelperToExtension::SummaryReady {
                    meeting_id,
                    summary: summary.summary,
                    action_items: summary
                        .action_items
                        .into_iter()
                        .map(|i| ActionItem {
                            text: i.text,
                            owner: i.owner,
                        })
                        .collect(),
                });
            }
            Err(e) => {
                messages.push(HelperToExtension::Error {
                    meeting_id: Some(meeting_id),
                    code: e.to_error_code(),
                    message: format!("summarization failed: {e}"),
                });
            }
        }
        Ok(messages)
    }

    /// Crash recovery: called once on helper startup. Every meeting still
    /// in `Recording` state never saw a clean stop, because raw audio is
    /// written incrementally, that audio is still fully intact on disk.
    pub fn find_recoverable_meetings(&self) -> Result<Vec<HelperToExtension>, PipelineError> {
        Ok(self
            .store
            .find_interrupted_meetings()?
            .into_iter()
            .map(|meta| HelperToExtension::RecoveredRecording {
                meeting_id: meta.id,
                started_at: meta.started_at,
            })
            .collect())
    }

    pub fn retry_queue_len(&self) -> usize {
        self.retry_queue.len()
    }

    /// Consume retry jobs whose backoff has elapsed. The audio range was
    /// persisted before the original provider call, so a retry reads the
    /// exact durable bytes rather than relying on an in-memory frame.
    pub async fn process_due_retries(
        &mut self,
        now: chrono::DateTime<Utc>,
    ) -> Vec<HelperToExtension> {
        let jobs: Vec<_> = self
            .retry_queue
            .due_jobs(now)
            .into_iter()
            .map(|job| (job.id, job.payload.clone()))
            .collect();
        let mut messages = Vec::new();

        for (job_id, job) in jobs {
            let RetryAudioRef::FileRange {
                channel_file,
                start,
                end,
            } = &job.audio_ref;
            let pcm16 =
                match self
                    .store
                    .read_audio_range(job.meeting_id, channel_file, *start, *end)
                {
                    Ok(bytes) => bytes,
                    Err(error) => {
                        let _ = self.retry_queue.record_failure(job_id, now);
                        messages.push(HelperToExtension::Error {
                            meeting_id: Some(job.meeting_id),
                            code: ErrorCode::DeviceNotFound,
                            message: format!("retry could not read saved audio: {error}"),
                        });
                        continue;
                    }
                };

            let chunk = AudioChunk {
                channel: job.channel,
                pcm16,
                sample_rate_hz: job.sample_rate_hz,
            };
            match self.transcription_provider.transcribe_chunk(&chunk).await {
                Ok(segments) => {
                    let _ = self
                        .store
                        .append_transcript_segments(job.meeting_id, &segments);
                    for segment in &segments {
                        messages.push(HelperToExtension::TranscriptPartial {
                            meeting_id: job.meeting_id,
                            speaker: segment.speaker.clone(),
                            text: segment.text.clone(),
                            is_final: segment.is_final,
                        });
                    }
                    if !segments.is_empty() {
                        if let Some(summary_message) =
                            self.resummarize_if_finalized(job.meeting_id).await
                        {
                            messages.push(summary_message);
                        }
                    }
                    let _ = self.retry_queue.record_success(job_id);
                }
                Err(error) => {
                    if let Ok(Some(_exhausted)) = self.retry_queue.record_failure(job_id, now) {
                        messages.push(HelperToExtension::Error {
                            meeting_id: Some(job.meeting_id),
                            code: error.to_error_code(),
                            message: format!("transcription retry exhausted: {error}"),
                        });
                    }
                }
            }
        }

        messages
    }

    async fn resummarize_if_finalized(&self, meeting_id: Uuid) -> Option<HelperToExtension> {
        let meta = self.store.load_meta(meeting_id).ok()?;
        if meta.state == MeetingState::Recording {
            return None;
        }
        let transcript = match self.store.load_transcript(meeting_id) {
            Ok(transcript) => transcript,
            Err(error) => {
                return Some(HelperToExtension::Error {
                    meeting_id: Some(meeting_id),
                    code: ErrorCode::DeviceNotFound,
                    message: format!("could not reload transcript after retry: {error}"),
                });
            }
        };
        match self.summarization_provider.summarize(&transcript).await {
            Ok(summary) => {
                let _ = self.store.mark_processed(meeting_id);
                Some(HelperToExtension::SummaryReady {
                    meeting_id,
                    summary: summary.summary,
                    action_items: summary
                        .action_items
                        .into_iter()
                        .map(|item| ActionItem {
                            text: item.text,
                            owner: item.owner,
                        })
                        .collect(),
                })
            }
            Err(error) => Some(HelperToExtension::Error {
                meeting_id: Some(meeting_id),
                code: error.to_error_code(),
                message: format!("summarization failed after transcription retry: {error}"),
            }),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PipelineError {
    #[error("storage error: {0}")]
    Storage(#[from] crate::storage::StorageError),
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_messaging::{SummarizationProviderId, TranscriptionProviderId};
    use crate::providers::{ProviderError, Summary, TranscriptSegment};
    use async_trait::async_trait;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    struct FakeTranscriber {
        fail_times: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl TranscriptionProvider for FakeTranscriber {
        fn id(&self) -> TranscriptionProviderId {
            TranscriptionProviderId::Deepgram
        }
        fn is_streaming(&self) -> bool {
            false
        }
        async fn transcribe_chunk(
            &self,
            chunk: &AudioChunk,
        ) -> Result<Vec<TranscriptSegment>, ProviderError> {
            if self.fail_times.load(Ordering::SeqCst) > 0 {
                self.fail_times.fetch_sub(1, Ordering::SeqCst);
                return Err(ProviderError::Unreachable("simulated failure".into()));
            }
            let speaker = if chunk.channel == AudioChannel::Mic {
                "you"
            } else {
                "them"
            };
            Ok(vec![TranscriptSegment {
                speaker: speaker.into(),
                text: "fake transcript".into(),
                is_final: true,
            }])
        }
    }

    struct FakeSummarizer;

    #[async_trait]
    impl SummarizationProvider for FakeSummarizer {
        fn id(&self) -> SummarizationProviderId {
            SummarizationProviderId::Claude
        }
        async fn summarize(
            &self,
            _transcript: &[TranscriptSegment],
        ) -> Result<Summary, ProviderError> {
            Ok(Summary {
                summary: "fake summary".into(),
                action_items: vec![],
            })
        }
    }

    fn build_pipeline(fail_times: usize) -> (tempfile::TempDir, Pipeline) {
        let dir = tempfile::tempdir().unwrap();
        let store = MeetingStore::new(dir.path()).unwrap();
        let retry_path = dir.path().join("retry.json");
        let retry_queue = RetryQueue::load_or_create(retry_path).unwrap();
        let pipeline = Pipeline::new(
            store,
            Box::new(FakeTranscriber {
                fail_times: Arc::new(AtomicUsize::new(fail_times)),
            }),
            Box::new(FakeSummarizer),
            retry_queue,
        );
        (dir, pipeline)
    }

    #[tokio::test]
    async fn start_recording_creates_meeting_and_emits_started() {
        let (_dir, mut pipeline) = build_pipeline(0);
        let id = Uuid::new_v4();
        let msg = pipeline.start_recording(id).unwrap();
        assert!(
            matches!(msg, HelperToExtension::RecordingStarted { meeting_id } if meeting_id == id)
        );
    }

    #[tokio::test]
    async fn audio_chunk_is_persisted_before_transcription_is_attempted() {
        let (_dir, mut pipeline) = build_pipeline(0);
        let id = Uuid::new_v4();
        pipeline.start_recording(id).unwrap();

        let messages = pipeline
            .handle_audio_chunk(id, AudioChannel::Mic, &[1, 2, 3, 4], 16000)
            .await;

        assert!(messages.is_empty(), "short frames stay buffered");
        let messages = pipeline.flush_pending_audio(id).await;

        // Transcript arrived successfully...
        assert!(
            matches!(&messages[0], HelperToExtension::TranscriptPartial { speaker, .. } if speaker == "you")
        );
        // ...and the raw audio is genuinely on disk regardless.
        let bytes = std::fs::read(pipeline.store.audio_path(id, MIC_FILE)).unwrap();
        assert_eq!(bytes, vec![1, 2, 3, 4]);
    }

    #[tokio::test]
    async fn batches_callback_audio_until_the_request_window_is_full() {
        let (_dir, mut pipeline) = build_pipeline(0);
        let id = Uuid::new_v4();
        pipeline.start_recording(id).unwrap();

        let batch = vec![0_u8; 16_000 * 2 * TRANSCRIPTION_BATCH_SECONDS];
        let messages = pipeline
            .handle_audio_chunk(id, AudioChannel::Mic, &batch, 16_000)
            .await;

        assert!(matches!(
            messages.as_slice(),
            [HelperToExtension::TranscriptPartial { speaker, .. }] if speaker == "you"
        ));
        assert_eq!(
            std::fs::metadata(pipeline.store.audio_path(id, MIC_FILE))
                .unwrap()
                .len(),
            batch.len() as u64
        );
    }

    #[tokio::test]
    async fn failed_transcription_still_persists_audio_and_queues_retry() {
        let (_dir, mut pipeline) = build_pipeline(1); // fail once
        let id = Uuid::new_v4();
        pipeline.start_recording(id).unwrap();

        let messages = pipeline
            .handle_audio_chunk(id, AudioChannel::Speaker, &[9, 9, 9], 16000)
            .await;
        assert!(messages.is_empty(), "short frames stay buffered");
        let messages = pipeline.flush_pending_audio(id).await;

        assert!(matches!(&messages[0], HelperToExtension::Error { .. }));
        // Audio still safely on disk despite the transcription failure.
        let bytes = std::fs::read(pipeline.store.audio_path(id, SPEAKER_FILE)).unwrap();
        assert_eq!(bytes, vec![9, 9, 9]);
        assert_eq!(pipeline.retry_queue_len(), 1);
    }

    #[tokio::test]
    async fn due_retry_replays_saved_audio_and_clears_the_job() {
        let (_dir, mut pipeline) = build_pipeline(1);
        let id = Uuid::new_v4();
        pipeline.start_recording(id).unwrap();
        pipeline
            .handle_audio_chunk(id, AudioChannel::Mic, &[9, 8, 7], 16000)
            .await;
        pipeline.flush_pending_audio(id).await;

        let messages = pipeline.process_due_retries(Utc::now()).await;
        assert!(matches!(
            &messages[0],
            HelperToExtension::TranscriptPartial { speaker, text, .. }
                if speaker == "you" && text == "fake transcript"
        ));
        assert_eq!(pipeline.retry_queue_len(), 0);
        assert_eq!(pipeline.store.load_transcript(id).unwrap().len(), 1);
    }

    #[tokio::test]
    async fn late_retry_resummarizes_a_meeting_that_was_already_stopped() {
        let (_dir, mut pipeline) = build_pipeline(1);
        let id = Uuid::new_v4();
        pipeline.start_recording(id).unwrap();
        pipeline
            .handle_audio_chunk(id, AudioChannel::Mic, &[9, 8, 7], 16000)
            .await;
        pipeline.flush_pending_audio(id).await;
        pipeline.stop_recording(id).await.unwrap();

        let messages = pipeline.process_due_retries(Utc::now()).await;
        assert!(messages
            .iter()
            .any(|message| matches!(message, HelperToExtension::TranscriptPartial { .. })));
        assert!(messages.iter().any(|message| matches!(
            message,
            HelperToExtension::SummaryReady { summary, .. } if summary == "fake summary"
        )));
    }

    #[tokio::test]
    async fn stop_recording_marks_stopped_and_returns_summary() {
        let (_dir, mut pipeline) = build_pipeline(0);
        let id = Uuid::new_v4();
        pipeline.start_recording(id).unwrap();
        pipeline
            .handle_audio_chunk(id, AudioChannel::Mic, &[1, 2], 16000)
            .await;

        let messages = pipeline.stop_recording(id).await.unwrap();

        assert!(
            matches!(&messages[0], HelperToExtension::RecordingStopped { meeting_id } if *meeting_id == id)
        );
        assert!(messages.iter().any(|message| matches!(
            message,
            HelperToExtension::SummaryReady { summary, .. } if summary == "fake summary"
        )));
    }

    #[tokio::test]
    async fn interrupted_meeting_is_found_as_recoverable_before_stop() {
        let (_dir, mut pipeline) = build_pipeline(0);
        let id = Uuid::new_v4();
        pipeline.start_recording(id).unwrap();

        let recoverable = pipeline.find_recoverable_meetings().unwrap();
        assert_eq!(recoverable.len(), 1);
        assert!(
            matches!(&recoverable[0], HelperToExtension::RecoveredRecording { meeting_id, .. } if *meeting_id == id)
        );
    }

    #[tokio::test]
    async fn stopped_meeting_is_not_flagged_as_recoverable() {
        let (_dir, mut pipeline) = build_pipeline(0);
        let id = Uuid::new_v4();
        pipeline.start_recording(id).unwrap();
        pipeline.stop_recording(id).await.unwrap();

        assert!(pipeline.find_recoverable_meetings().unwrap().is_empty());
    }
}
