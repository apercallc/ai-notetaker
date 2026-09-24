//! Cross-platform virtual-audio-device capture, behind a single trait so
//! swapping a per-OS backend never touches pipeline/orchestration code
//! (spec §7). Per the non-negotiable constraints in the root `CLAUDE.md`:
//! we wrap existing drivers (BlackHole/VB-Cable/PulseAudio-PipeWire), we
//! never build our own, and mic + speaker are always captured as two
//! separate streams, never merged.

pub mod device_matching;

#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "windows")]
pub mod windows;

use async_trait::async_trait;
use notetaker_core::providers::AudioChannel;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AudioError {
    #[error("virtual audio device not found: {0}")]
    DeviceNotFound(String),
    #[error("failed to open audio stream: {0}")]
    StreamError(String),
    #[error("platform-specific driver setup failed: {0}")]
    DriverSetup(String),
}

/// One frame of captured audio from a single channel (mic or speaker),
/// delivered as it arrives.
#[derive(Debug, Clone)]
pub struct CapturedFrame {
    pub channel: AudioChannel,
    pub pcm16: Vec<u8>,
    pub sample_rate_hz: u32,
}

/// Whether the OS-level virtual audio device this platform depends on
/// (BlackHole, VB-CABLE, or the PulseAudio/PipeWire null-sink module) is
/// currently installed and selectable.
pub enum DriverStatus {
    Installed,
    /// Not installed. `install_guidance` is what the onboarding wizard
    /// shows the user — for macOS this is a deep link to Existential
    /// Audio's official download (never a bundled binary, see
    /// `helper/CLAUDE.md`); a future Windows installer may bundle base
    /// VB-CABLE after its attribution/release checks are complete.
    NotInstalled {
        install_guidance: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioDiagnostics {
    pub platform: String,
    pub driver: String,
    pub driver_installed: bool,
    pub microphone: Option<String>,
    pub speaker: Option<String>,
    pub ready: bool,
    pub guidance: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AudioProbe {
    pub mic_frames: u64,
    pub speaker_frames: u64,
    pub passed: bool,
    pub message: String,
}

#[async_trait]
pub trait AudioCapture: Send + Sync {
    /// Checks whether the platform's virtual audio device is installed and
    /// ready to select as a mic/speaker in a meeting app.
    fn driver_status(&self) -> DriverStatus;

    /// Returns a non-invasive snapshot of the devices the backend would use.
    /// This is deliberately separate from `start_capture`: preflight must be
    /// useful before a meeting and must not call a provider or create a note.
    fn diagnostics(&self) -> AudioDiagnostics;

    /// Gives a platform backend a chance to create its existing virtual
    /// devices. It must not download or invent a custom audio driver.
    fn prepare(&self) -> Result<(), AudioError> {
        Ok(())
    }

    /// Begins capturing both channels. Frames are delivered to `on_frame`
    /// as they arrive — the caller (the pipeline) is responsible for
    /// persisting them to disk before anything else happens to them, per
    /// the resilience guarantee.
    async fn start_capture(
        &self,
        on_frame: Box<dyn Fn(CapturedFrame) + Send + Sync>,
    ) -> Result<(), AudioError>;

    async fn stop_capture(&self) -> Result<(), AudioError>;

    /// Exercises both capture callbacks for a short bounded interval. The
    /// default implementation is backend-neutral and intentionally reports
    /// only frame counts; raw frames never leave the helper.
    async fn probe(&self) -> Result<AudioProbe, AudioError> {
        let counts = Arc::new(Mutex::new(AudioProbe::default()));
        let callback_counts = counts.clone();
        self.start_capture(Box::new(move |frame| {
            if let Ok(mut result) = callback_counts.lock() {
                match frame.channel {
                    AudioChannel::Mic => result.mic_frames += 1,
                    AudioChannel::Speaker => result.speaker_frames += 1,
                }
            }
        }))
        .await?;
        tokio::time::sleep(Duration::from_secs(2)).await;
        self.stop_capture().await?;
        // Some backends stop their reader thread asynchronously. Give the
        // callback task a short drain window after stop_capture() so frames
        // already produced by the backend—especially parec's final speaker
        // buffer—are counted before we evaluate the probe.
        tokio::time::sleep(Duration::from_millis(250)).await;
        let mut result = counts.lock().map(|value| value.clone()).unwrap_or_default();
        result.passed = result.mic_frames > 0 && result.speaker_frames > 0;
        result.message = if result.passed {
            "Both microphone and meeting-audio channels produced test frames.".to_string()
        } else {
            "The test did not receive audio on both channels. Check the meeting app's mic/speaker selection and try again.".to_string()
        };
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn driver_status_not_installed_carries_guidance_text() {
        let status = DriverStatus::NotInstalled {
            install_guidance: "go here".into(),
        };
        match status {
            DriverStatus::NotInstalled { install_guidance } => {
                assert_eq!(install_guidance, "go here")
            }
            DriverStatus::Installed => panic!("expected NotInstalled"),
        }
    }

    #[test]
    fn probe_defaults_to_a_failed_empty_result() {
        let result = AudioProbe::default();
        assert_eq!(result.mic_frames, 0);
        assert_eq!(result.speaker_frames, 0);
        assert!(!result.passed);
    }
}
