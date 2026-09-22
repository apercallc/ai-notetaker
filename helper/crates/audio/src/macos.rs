//! macOS virtual audio device: BlackHole. Per the verified licensing
//! constraint in the architecture spec (§3.1) and `helper/CLAUDE.md`, this
//! crate never bundles Existential Audio's compiled installer — if
//! BlackHole isn't installed, `driver_status()` returns install guidance
//! (a deep link to their official download) for the app layer to present;
//! it does not silently install anything on this platform.
//!
//! **Known gap, flagged rather than faked:** selecting BlackHole as a
//! meeting app's output device routes that audio only to BlackHole — by
//! default the user would stop hearing the meeting through their real
//! speakers/headphones. A complete implementation needs a macOS
//! Multi-Output Device (BlackHole + the user's real output) so audio keeps
//! playing normally while we also capture it. That requires macOS's
//! aggregate-device CoreAudio APIs (`AudioHardwareCreateAggregateDevice`),
//! which sit below what `cpal`'s cross-platform abstraction exposes and
//! would need direct `coreaudio-sys` bindings — not implemented in this
//! pass. Until it lands, a user following the onboarding wizard would need
//! to create a Multi-Output Device manually in Audio MIDI Setup, which
//! should be documented as an explicit manual step rather than presented
//! as automatic.

use crate::device_matching::{find_matching_device, MACOS_DEVICE_HINT};
use crate::{AudioCapture, AudioDiagnostics, AudioError, CapturedFrame, DriverStatus};
use async_trait::async_trait;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use notetaker_core::providers::AudioChannel;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

pub const BLACKHOLE_DOWNLOAD_URL: &str = "https://existential.audio/blackhole/";

pub struct MacosAudioCapture {
    running: Arc<AtomicBool>,
}

impl MacosAudioCapture {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
        }
    }

    fn installed_device_name(&self) -> Option<String> {
        let host = cpal::default_host();
        let names: Vec<String> = host
            .input_devices()
            .map(|it| it.filter_map(|d| d.name().ok()).collect())
            .unwrap_or_default();
        find_matching_device(&names, MACOS_DEVICE_HINT).map(String::from)
    }
}

impl Default for MacosAudioCapture {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AudioCapture for MacosAudioCapture {
    fn driver_status(&self) -> DriverStatus {
        match self.installed_device_name() {
            Some(_) => DriverStatus::Installed,
            None => DriverStatus::NotInstalled {
                install_guidance: format!(
                    "BlackHole isn't installed yet. Download it from {BLACKHOLE_DOWNLOAD_URL}, install it, then come back here — you may need to log out and back in before it appears as a selectable device."
                ),
            },
        }
    }

    fn diagnostics(&self) -> AudioDiagnostics {
        let speaker = self.installed_device_name();
        let microphone = cpal::default_host()
            .default_input_device()
            .and_then(|device| device.name().ok());
        let driver_installed = speaker.is_some();
        let ready = driver_installed && microphone.is_some();
        AudioDiagnostics {
            platform: "macos".to_string(),
            driver: "BlackHole".to_string(),
            driver_installed,
            microphone,
            speaker,
            ready,
            guidance: if ready {
                "BlackHole and a microphone are available. Confirm your Multi-Output Device keeps meeting audio audible, then run the test.".to_string()
            } else {
                format!("BlackHole is not ready. Download it from {BLACKHOLE_DOWNLOAD_URL}, install it, and create a Multi-Output Device with your normal speakers or headphones.")
            },
        }
    }

    async fn start_capture(
        &self,
        on_frame: Box<dyn Fn(CapturedFrame) + Send + Sync>,
    ) -> Result<(), AudioError> {
        let Some(speaker_device_name) = self.installed_device_name() else {
            return Err(AudioError::DeviceNotFound("BlackHole".to_string()));
        };
        self.running.store(true, Ordering::SeqCst);

        let (tx, rx) = std::sync::mpsc::channel::<CapturedFrame>();
        let running = self.running.clone();
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<Result<(), String>>();

        std::thread::spawn(move || {
            let host = cpal::default_host();
            let speaker_device = host.input_devices().ok().and_then(|mut it| {
                it.find(|d| d.name().ok().as_deref() == Some(speaker_device_name.as_str()))
            });
            let mic_device = host.default_input_device();

            let Some(speaker_device) = speaker_device else {
                let _ = ready_tx.send(Err("BlackHole meeting-audio device was not found".into()));
                return;
            };
            let Some(mic_device) = mic_device else {
                let _ = ready_tx.send(Err("the system microphone was not found".into()));
                return;
            };
            let speaker_stream =
                match build_input_stream(&speaker_device, AudioChannel::Speaker, tx.clone()) {
                    Ok(stream) => stream,
                    Err(error) => {
                        let _ = ready_tx.send(Err(error.to_string()));
                        return;
                    }
                };
            let mic_stream = match build_input_stream(&mic_device, AudioChannel::Mic, tx.clone()) {
                Ok(stream) => stream,
                Err(error) => {
                    let _ = ready_tx.send(Err(error.to_string()));
                    return;
                }
            };
            let _ = ready_tx.send(Ok(()));

            while running.load(Ordering::SeqCst) {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            drop((speaker_stream, mic_stream));
        });

        match tokio::time::timeout(std::time::Duration::from_secs(3), ready_rx).await {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(error))) => {
                self.running.store(false, Ordering::SeqCst);
                return Err(AudioError::StreamError(error));
            }
            Ok(Err(_)) => {
                self.running.store(false, Ordering::SeqCst);
                return Err(AudioError::StreamError(
                    "audio startup thread exited unexpectedly".into(),
                ));
            }
            Err(_) => {
                self.running.store(false, Ordering::SeqCst);
                return Err(AudioError::StreamError("audio startup timed out".into()));
            }
        }

        tokio::spawn(async move {
            while let Ok(frame) = rx.recv() {
                on_frame(frame);
            }
        });

        Ok(())
    }

    async fn stop_capture(&self) -> Result<(), AudioError> {
        self.running.store(false, Ordering::SeqCst);
        Ok(())
    }
}

fn build_input_stream(
    device: &cpal::Device,
    channel: AudioChannel,
    tx: std::sync::mpsc::Sender<CapturedFrame>,
) -> Result<cpal::Stream, AudioError> {
    let config = device
        .default_input_config()
        .map_err(|e| AudioError::StreamError(e.to_string()))?;
    let sample_rate_hz = config.sample_rate().0;
    let stream = device
        .build_input_stream(
            &config.into(),
            move |data: &[f32], _| {
                let pcm16: Vec<u8> = data
                    .iter()
                    .flat_map(|s| ((s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16).to_le_bytes())
                    .collect();
                let _ = tx.send(CapturedFrame {
                    channel,
                    pcm16,
                    sample_rate_hz,
                });
            },
            move |err| tracing::error!("audio stream error: {err}"),
            None,
        )
        .map_err(|e| AudioError::StreamError(e.to_string()))?;
    stream
        .play()
        .map_err(|e| AudioError::StreamError(e.to_string()))?;
    Ok(stream)
}
