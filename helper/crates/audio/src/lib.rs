//! Cross-platform virtual-audio-device capture, behind a single trait so
//! swapping a per-OS backend never touches pipeline/orchestration code
//! (spec §7). Per the non-negotiable constraints in the root `CLAUDE.md`:
//! we wrap existing drivers (BlackHole/VB-Cable/PulseAudio-PipeWire), we
//! never build our own, and mic + speaker are always captured as two
//! separate streams, never merged.

pub mod device_matching;

#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "windows")]
pub mod windows;
#[cfg(target_os = "linux")]
pub mod linux;

use async_trait::async_trait;
use notetaker_core::providers::AudioChannel;
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
    /// `helper/CLAUDE.md`); for Windows, bundling is what actually runs
    /// here since VB-Audio's terms permit it.
    NotInstalled { install_guidance: String },
}

#[async_trait]
pub trait AudioCapture: Send + Sync {
    /// Checks whether the platform's virtual audio device is installed and
    /// ready to select as a mic/speaker in a meeting app.
    fn driver_status(&self) -> DriverStatus;

    /// Begins capturing both channels. Frames are delivered to `on_frame`
    /// as they arrive — the caller (the pipeline) is responsible for
    /// persisting them to disk before anything else happens to them, per
    /// the resilience guarantee.
    async fn start_capture(
        &self,
        on_frame: Box<dyn Fn(CapturedFrame) + Send + Sync>,
    ) -> Result<(), AudioError>;

    async fn stop_capture(&self) -> Result<(), AudioError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn driver_status_not_installed_carries_guidance_text() {
        let status = DriverStatus::NotInstalled { install_guidance: "go here".into() };
        match status {
            DriverStatus::NotInstalled { install_guidance } => assert_eq!(install_guidance, "go here"),
            DriverStatus::Installed => panic!("expected NotInstalled"),
        }
    }
}
