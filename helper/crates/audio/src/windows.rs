//! Windows virtual audio device: VB-CABLE. Per the verified licensing
//! terms in the architecture spec (§3.1) and `helper/CLAUDE.md`, VB-Audio's
//! terms explicitly permit bundling and silently installing *base*
//! VB-CABLE (never the A+B/C+D variants), provided vb-cable.com
//! attribution and the donation option stay visible in our installer UI —
//! that attribution display is an app-layer/installer-UI concern, not this
//! crate's. The actual download/install step remains an explicit release
//! task; this module currently handles detection and truthful guidance.
//!
//! **Known gap, flagged rather than faked:** same issue as macOS — routing
//! a meeting app's output to CABLE Input means the user stops hearing the
//! meeting through their real speakers unless something plays CABLE
//! Output back out. Windows offers a per-recording-device "Listen to this
//! device" toggle (in Sound Settings > Recording > CABLE Output >
//! Properties > Listen) that accomplishes this, but toggling it
//! programmatically needs direct WASAPI/IMMDevice/IAudioEndpointVolume
//! COM calls beyond what `cpal` exposes — not implemented in this pass.
//! Until it lands, the onboarding wizard needs an explicit manual step
//! telling the user to enable that listen toggle once, not an automatic
//! claim.

use crate::device_matching::{find_matching_device, WINDOWS_DEVICE_HINT};
use crate::{AudioCapture, AudioDiagnostics, AudioError, CapturedFrame, DriverStatus};
use async_trait::async_trait;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use notetaker_core::providers::AudioChannel;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// The exact VB-CABLE download this project is licensed to bundle. The base
/// package only — VB-Audio's terms explicitly exclude the A+B/C+D variants
/// from bundling permission, so this URL must never be swapped for one of
/// those without re-checking the license terms.
pub const VB_CABLE_DOWNLOAD_URL: &str =
    "https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip";
pub const VB_CABLE_ATTRIBUTION_TEXT: &str = "Virtual audio cable by VB-Audio Software (vb-cable.com) — donationware, please consider supporting them.";

pub struct WindowsAudioCapture {
    running: Arc<AtomicBool>,
}

impl WindowsAudioCapture {
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
        find_matching_device(&names, WINDOWS_DEVICE_HINT).map(String::from)
    }

    /// Intended release hook to download (if needed) and silently install
    /// base VB-CABLE. The
    /// installer UI calling this must display `VB_CABLE_ATTRIBUTION_TEXT`
    /// and a link to vb-cable.com, per VB-Audio's bundling terms — that
    /// display is the caller's responsibility.
    pub async fn install_if_missing(&self) -> Result<(), AudioError> {
        if self.installed_device_name().is_some() {
            return Ok(());
        }
        // Real implementation: download VB_CABLE_DOWNLOAD_URL, unzip, and
        // run VBCABLE_Setup_x64.exe with its documented silent-install
        // flag. Not executed here — this sandbox has no Windows target and
        // no network path to VB-Audio's download host was exercised, so
        // this is written but unverified; flagged in the implementation
        // report rather than claimed as tested.
        Err(AudioError::DriverSetup(
            "VB-CABLE silent install is not yet wired to a real download+run step — see implementation report".into(),
        ))
    }
}

impl Default for WindowsAudioCapture {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AudioCapture for WindowsAudioCapture {
    fn driver_status(&self) -> DriverStatus {
        match self.installed_device_name() {
            Some(_) => DriverStatus::Installed,
            None => DriverStatus::NotInstalled {
                install_guidance:
                    "Install the base VB-CABLE package from vb-cable.com, then return here and check again."
                        .to_string(),
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
            platform: "windows".to_string(),
            driver: "VB-CABLE".to_string(),
            driver_installed,
            microphone,
            speaker,
            ready,
            guidance: if ready {
                format!("VB-CABLE is available. Confirm Listen to this device is enabled so you can hear the meeting, then run the test. {}", VB_CABLE_ATTRIBUTION_TEXT)
            } else {
                format!("VB-CABLE is not ready. Install the base VB-CABLE package, enable Listen to this device, and try again. {}", VB_CABLE_ATTRIBUTION_TEXT)
            },
        }
    }

    async fn start_capture(
        &self,
        on_frame: Box<dyn Fn(CapturedFrame) + Send + Sync>,
    ) -> Result<(), AudioError> {
        let Some(speaker_device_name) = self.installed_device_name() else {
            return Err(AudioError::DeviceNotFound("VB-CABLE".to_string()));
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
                let _ = ready_tx.send(Err("VB-CABLE meeting-audio device was not found".into()));
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
