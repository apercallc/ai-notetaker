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

/// Whether this platform's system-audio capture path is currently available.
/// Native loopback paths (ScreenCaptureKit/WASAPI/monitor sources) report
/// `Installed` without requiring a virtual device; the documented virtual
/// drivers remain explicit fallbacks.
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
    pub native_loopback: bool,
    pub virtual_device_fallback: bool,
    pub permission_required: bool,
}

/// Applies the cross-platform readiness contract used by every backend.
///
/// A driver being present is not enough: both independent channels must have
/// a route, the physical microphone must be visible, and a known permission
/// gap must fail closed. Keeping this decision in the shared crate makes the
/// platform adapters small and lets the matrix tests exercise missing-device
/// and permission states without requiring the host OS to expose fake audio
/// hardware.
pub fn capture_ready(
    driver_installed: bool,
    microphone_available: bool,
    speaker_available: bool,
    mic_route_available: bool,
    permission_required: bool,
) -> bool {
    driver_installed
        && microphone_available
        && speaker_available
        && mic_route_available
        && !permission_required
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
    /// Checks whether the platform's native or fallback system-audio path is
    /// installed and ready to use.
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

/// Converts the native Windows loopback format (interleaved IEEE-754 f32)
/// into the mono little-endian PCM16 frames consumed by the core pipeline.
/// Keeping this conversion platform-neutral makes it testable on the host
/// build even though the WASAPI reader itself is Windows-only.
#[allow(dead_code)]
pub(crate) fn interleaved_f32_to_mono_pcm16(data: &[u8], channels: usize) -> Vec<u8> {
    if channels == 0 {
        return Vec::new();
    }

    let bytes_per_frame = channels.saturating_mul(std::mem::size_of::<f32>());
    if bytes_per_frame == 0 {
        return Vec::new();
    }

    let frame_count = data.len() / bytes_per_frame;
    let mut pcm16 = Vec::with_capacity(frame_count * std::mem::size_of::<i16>());
    for frame in data[..frame_count * bytes_per_frame].chunks_exact(bytes_per_frame) {
        let mut sum = 0.0_f32;
        for sample in frame.as_chunks::<4>().0 {
            sum += f32::from_le_bytes([sample[0], sample[1], sample[2], sample[3]]);
        }
        let mono = (sum / channels as f32).clamp(-1.0, 1.0);
        pcm16.extend_from_slice(&((mono * i16::MAX as f32).round() as i16).to_le_bytes());
    }
    pcm16
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

    #[test]
    fn interleaved_float_audio_is_downmixed_to_pcm16() {
        let samples = [0.5_f32, -0.5_f32, 1.0, 1.0];
        let bytes = samples
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect::<Vec<_>>();

        let pcm16 = interleaved_f32_to_mono_pcm16(&bytes, 2);
        let values = pcm16
            .as_chunks::<2>()
            .0
            .iter()
            .map(|sample| i16::from_le_bytes(*sample))
            .collect::<Vec<_>>();
        assert_eq!(values, vec![0, i16::MAX]);
    }

    #[test]
    fn malformed_or_zero_channel_audio_produces_no_frames() {
        assert!(interleaved_f32_to_mono_pcm16(&[0; 7], 2).is_empty());
        assert!(interleaved_f32_to_mono_pcm16(&[0; 8], 0).is_empty());
    }

    #[test]
    fn readiness_requires_both_independent_channels_and_permissions() {
        assert!(capture_ready(true, true, true, true, false));
        assert!(!capture_ready(false, true, true, true, false));
        assert!(!capture_ready(true, false, true, true, false));
        assert!(!capture_ready(true, true, false, true, false));
        assert!(!capture_ready(true, true, true, false, false));
        assert!(!capture_ready(true, true, true, true, true));
    }
}
