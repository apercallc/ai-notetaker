use async_trait::async_trait;
use notetaker_core::native_messaging::{
    HelperToExtension, SummarizationProviderId, TranscriptionProviderId,
};
use notetaker_core::pipeline::Pipeline;
use notetaker_core::providers::{
    AudioChannel, AudioChunk, ProviderError, SummarizationProvider, Summary, SummaryOptions,
    TranscriptSegment, TranscriptionProvider,
};
use notetaker_core::resilience::RetryQueue;
use notetaker_core::storage::MeetingStore;
use std::path::Path;
use tempfile::TempDir;
use uuid::Uuid;

const FIXTURE_HEX: &str = include_str!("fixtures/meeting-fixture.pcm16.hex");

fn fixture_audio() -> Vec<u8> {
    FIXTURE_HEX
        .split_whitespace()
        .map(|byte| u8::from_str_radix(byte, 16).expect("fixture must contain hexadecimal bytes"))
        .collect()
}

struct FixtureTranscriber {
    tier: &'static str,
}

#[async_trait]
impl TranscriptionProvider for FixtureTranscriber {
    fn id(&self) -> TranscriptionProviderId {
        if self.tier == "default" {
            TranscriptionProviderId::Deepgram
        } else {
            TranscriptionProviderId::Groq
        }
    }

    fn is_streaming(&self) -> bool {
        false
    }

    async fn transcribe_chunk(
        &self,
        chunk: &AudioChunk,
    ) -> Result<Vec<TranscriptSegment>, ProviderError> {
        Ok(vec![TranscriptSegment {
            speaker: if chunk.channel == AudioChannel::Mic {
                "you"
            } else {
                "them"
            }
            .into(),
            text: format!("{} fixture transcript", self.tier),
            is_final: true,
        }])
    }
}

struct FixtureSummarizer {
    tier: &'static str,
}

#[async_trait]
impl SummarizationProvider for FixtureSummarizer {
    fn id(&self) -> SummarizationProviderId {
        if self.tier == "default" {
            SummarizationProviderId::Claude
        } else {
            SummarizationProviderId::Gemini
        }
    }

    async fn summarize(
        &self,
        transcript: &[TranscriptSegment],
        _options: &SummaryOptions,
    ) -> Result<Summary, ProviderError> {
        assert_eq!(transcript.len(), 2);
        Ok(Summary {
            summary: format!("{} fixture summary", self.tier),
            action_items: vec![],
        })
    }
}

fn build_pipeline(temp_dir: &Path, tier: &'static str) -> Pipeline {
    let store = MeetingStore::new(temp_dir).expect("meeting store");
    let retry_queue = RetryQueue::load_or_create(temp_dir.join("retry.json")).expect("retry queue");
    Pipeline::new(
        store,
        Box::new(FixtureTranscriber { tier }),
        Box::new(FixtureSummarizer { tier }),
        retry_queue,
    )
}

#[tokio::test]
async fn recorded_fixture_completes_default_and_budget_provider_paths() {
    let audio = fixture_audio();
    assert!(!audio.is_empty());

    for tier in ["default", "budget"] {
        let temp_dir = TempDir::new().expect("temporary meeting directory");
        let mut pipeline = build_pipeline(temp_dir.path(), tier);
        let meeting_id = Uuid::new_v4();

        assert!(matches!(
            pipeline.start_recording(meeting_id),
            Ok(HelperToExtension::RecordingStarted { meeting_id: id }) if id == meeting_id
        ));
        pipeline
            .handle_audio_chunk(meeting_id, AudioChannel::Mic, &audio, 16_000)
            .await;
        pipeline
            .handle_audio_chunk(meeting_id, AudioChannel::Speaker, &audio, 16_000)
            .await;

        let messages = pipeline
            .stop_recording(meeting_id)
            .await
            .expect("stop recording");
        assert!(messages.iter().any(|message| matches!(
            message,
            HelperToExtension::TranscriptPartial { text, .. } if text == &format!("{tier} fixture transcript")
        )));
        assert!(messages.iter().any(|message| matches!(
            message,
            HelperToExtension::SummaryReady { summary, .. } if summary == &format!("{tier} fixture summary")
        )));
    }
}
