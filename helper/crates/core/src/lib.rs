//! Shared, platform-agnostic core for the AI Notetaker desktop helper:
//! the Native Messaging wire protocol, provider clients, local storage,
//! the retry queue, and the pipeline that ties them together.
//!
//! Deliberately has no dependency on any specific audio backend (that
//! lives in the `notetaker-audio` crate) or on Tauri (that lives in the
//! `notetaker-app` binary crate) — per spec §7, swapping either of those
//! should never require a change here.

pub mod audio_container;
pub mod native_messaging;
pub mod pipeline;
pub mod providers;
pub mod resilience;
pub mod storage;

use crate::native_messaging::{SummarizationProviderId, TranscriptionProviderId};
use crate::providers::{claude::ClaudeProvider, deepgram::DeepgramProvider, deepseek::DeepSeekProvider, gemini::GeminiProvider, groq::GroqProvider};
use crate::providers::{SummarizationProvider, TranscriptionProvider};

/// Builds the configured transcription provider from a settings message's
/// provider choice + key. Centralized here so the mapping from wire-level
/// provider IDs to concrete implementations lives in exactly one place.
pub fn build_transcription_provider(id: TranscriptionProviderId, api_key: String) -> Box<dyn TranscriptionProvider> {
    match id {
        TranscriptionProviderId::Deepgram => Box::new(DeepgramProvider::new(api_key)),
        TranscriptionProviderId::Groq => Box::new(GroqProvider::new(api_key)),
    }
}

pub fn build_summarization_provider(id: SummarizationProviderId, api_key: String) -> Box<dyn SummarizationProvider> {
    match id {
        SummarizationProviderId::Claude => Box::new(ClaudeProvider::new(api_key)),
        SummarizationProviderId::Gemini => Box::new(GeminiProvider::new(api_key)),
        SummarizationProviderId::Deepseek => Box::new(DeepSeekProvider::new(api_key)),
    }
}
