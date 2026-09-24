//! Windows capture prefers the built-in WASAPI output-loopback path and falls
//! back to the base VB-CABLE package. Only the base package is supported;
//! A+B/C+D variants are deliberately out of scope. Release artifacts stage the
//! complete, checksum-pinned official package beside the helper. The helper
//! launches the vendor installer visibly so Windows can show its normal UAC and
//! administrator flow; it never downloads a driver at runtime or passes an
//! undocumented silent-install switch.
//!
//! **Fallback limitation, flagged rather than faked:** when native WASAPI
//! loopback is unavailable, routing a meeting app's output to CABLE Input means
//! the user stops hearing the meeting through their real speakers unless
//! something plays CABLE Output back out. Windows offers a per-recording-device
//! "Listen to this device" toggle (in Sound Settings > Recording > CABLE Output
//! > Properties > Listen) that accomplishes this, but toggling it
//! programmatically needs direct WASAPI/IMMDevice/IAudioEndpointVolume COM calls
//! beyond what `cpal` exposes. The fallback onboarding therefore keeps that
//! manual step explicit instead of claiming automatic routing.

use crate::device_matching::{find_matching_device, WINDOWS_DEVICE_HINT};
use crate::{
    capture_ready, interleaved_f32_to_mono_pcm16, AudioCapture, AudioDiagnostics, AudioError,
    CapturedFrame, DriverStatus,
};
use async_trait::async_trait;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use notetaker_core::providers::AudioChannel;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::oneshot;

const WASAPI_SAMPLE_RATE_HZ: u32 = 48_000;
const WASAPI_CHANNELS: u16 = 2;
const WASAPI_BUFFER_DURATION_HNS: i64 = 200_000;

/// The exact VB-CABLE download this project is licensed to bundle. The base
/// package only — VB-Audio's terms explicitly exclude the A+B/C+D variants
/// from bundling permission, so this URL must never be swapped for one of
/// those without re-checking the license terms.
pub const VB_CABLE_DOWNLOAD_URL: &str =
    "https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip";
pub const VB_CABLE_ATTRIBUTION_TEXT: &str = "Virtual audio cable by VB-Audio Software (vb-cable.com) — donationware, please consider supporting them.";
const BUNDLED_DRIVER_RELATIVE_PATH: &str = "resources/windows/vb-cable/VBCABLE_Setup_x64.exe";

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

    fn native_loopback_device_name(&self) -> Option<String> {
        probe_wasapi_loopback().ok()
    }

    /// Installs the release-bundled base VB-CABLE package when it is absent.
    /// The release installer UI must display `VB_CABLE_ATTRIBUTION_TEXT` and a
    /// link to vb-cable.com; this crate owns only the device check and launch.
    pub async fn install_if_missing(&self) -> Result<(), AudioError> {
        self.install_bundled_driver()
    }

    fn install_bundled_driver(&self) -> Result<(), AudioError> {
        if self.installed_device_name().is_some() {
            return Ok(());
        }

        let Some(installer) = bundled_driver_path() else {
            return Err(AudioError::DriverSetup(format!(
                "This build does not include the pinned base VB-CABLE installer. Install the base package from {VB_CABLE_DOWNLOAD_URL}, extract the full archive, run VBCABLE_Setup_x64.exe as administrator, reboot if Windows requests it, then check audio again."
            )));
        };

        let status = Command::new(&installer)
            // The official archive contains companion files beside the setup
            // executable; preserve that extracted-package working directory.
            .current_dir(
                installer
                    .parent()
                    .unwrap_or_else(|| std::path::Path::new(".")),
            )
            .status()
            .map_err(|error| {
                AudioError::DriverSetup(format!(
                    "could not launch the bundled VB-CABLE installer at {}: {error}",
                    installer.display()
                ))
            })?;
        if !status.success() {
            return Err(AudioError::DriverSetup(format!(
                "the bundled VB-CABLE installer exited with {status}; approve the administrator prompt and try again"
            )));
        }

        for _ in 0..30 {
            if self.installed_device_name().is_some() {
                return Ok(());
            }
            std::thread::sleep(Duration::from_secs(1));
        }

        Err(AudioError::DriverSetup(
            "VB-CABLE was installed but Windows has not exposed the device yet; reboot Windows if requested, then check audio again".into(),
        ))
    }
}

fn bundled_driver_path() -> Option<PathBuf> {
    let relative_path = PathBuf::from(BUNDLED_DRIVER_RELATIVE_PATH);
    let file_name = relative_path.file_name()?;
    let resource_suffix = relative_path.parent()?;
    let mut candidates = Vec::new();

    if let Ok(executable) = std::env::current_exe() {
        if let Some(parent) = executable.parent() {
            candidates.push(parent.join(&relative_path));
            candidates.push(parent.join("windows").join("vb-cable").join(file_name));
        }
    }
    if let Ok(current_dir) = std::env::current_dir() {
        candidates.push(current_dir.join(&relative_path));
        candidates.push(current_dir.join(resource_suffix).join(file_name));
    }

    candidates.into_iter().find(|path| path.is_file())
}

impl Default for WindowsAudioCapture {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AudioCapture for WindowsAudioCapture {
    fn prepare(&self) -> Result<(), AudioError> {
        if self.native_loopback_device_name().is_some() {
            return Ok(());
        }
        if self.installed_device_name().is_some() {
            return Ok(());
        }
        self.install_bundled_driver()
    }

    fn driver_status(&self) -> DriverStatus {
        if self.native_loopback_device_name().is_some() || self.installed_device_name().is_some() {
            DriverStatus::Installed
        } else {
            DriverStatus::NotInstalled {
                install_guidance:
                    "Windows WASAPI loopback is unavailable and VB-CABLE is not installed. Install the base VB-CABLE package from vb-cable.com, then return here and check again."
                        .to_string(),
            }
        }
    }

    fn diagnostics(&self) -> AudioDiagnostics {
        let native_speaker = self.native_loopback_device_name();
        let fallback_speaker = self.installed_device_name();
        let fallback_available = fallback_speaker.is_some();
        let native_loopback = native_speaker.is_some();
        let speaker = native_speaker.or(fallback_speaker);
        let microphone = cpal::default_host()
            .default_input_device()
            .and_then(|device| device.name().ok());
        let permission_required = microphone.is_none();
        let driver_installed = speaker.is_some();
        let ready = capture_ready(
            driver_installed,
            microphone.is_some(),
            speaker.is_some(),
            true,
            permission_required,
        );
        AudioDiagnostics {
            platform: "windows".to_string(),
            driver: if native_loopback {
                "WASAPI loopback"
            } else {
                "VB-CABLE"
            }
            .to_string(),
            driver_installed,
            microphone,
            speaker,
            ready,
            guidance: if ready && native_loopback {
                "Windows WASAPI output loopback is available. The helper captures the default output while keeping your normal speakers or headphones active.".to_string()
            } else if ready {
                format!("VB-CABLE is available. Confirm Listen to this device is enabled so you can hear the meeting, then run the test. {}", VB_CABLE_ATTRIBUTION_TEXT)
            } else {
                format!("Windows audio loopback is not ready. Install the base VB-CABLE package, enable Listen to this device, and try again. {}", VB_CABLE_ATTRIBUTION_TEXT)
            },
            native_loopback,
            virtual_device_fallback: !native_loopback && fallback_available,
            permission_required,
        }
    }

    async fn start_capture(
        &self,
        on_frame: Box<dyn Fn(CapturedFrame) + Send + Sync>,
    ) -> Result<(), AudioError> {
        let native_loopback = self.native_loopback_device_name().is_some();
        let speaker_device_name = if native_loopback {
            None
        } else {
            Some(
                self.installed_device_name()
                    .ok_or_else(|| AudioError::DeviceNotFound("VB-CABLE".to_string()))?,
            )
        };
        self.running.store(true, Ordering::SeqCst);

        let (tx, rx) = std::sync::mpsc::channel::<CapturedFrame>();
        let running = self.running.clone();
        let (ready_tx, ready_rx) = oneshot::channel::<Result<(), String>>();

        std::thread::spawn(move || {
            let host = cpal::default_host();
            let mic_device = host.default_input_device();

            let Some(mic_device) = mic_device else {
                let _ = ready_tx.send(Err("the system microphone was not found".into()));
                return;
            };
            let mic_stream = match build_input_stream(&mic_device, AudioChannel::Mic, tx.clone()) {
                Ok(stream) => stream,
                Err(error) => {
                    let _ = ready_tx.send(Err(error.to_string()));
                    return;
                }
            };

            if native_loopback {
                if let Err(error) = run_wasapi_loopback(running.clone(), tx, ready_tx) {
                    tracing::error!(%error, "Windows WASAPI loopback stopped");
                }
            } else {
                let Some(speaker_device) = speaker_device_name.as_ref().and_then(|name| {
                    host.input_devices().ok().and_then(|mut it| {
                        it.find(|d| d.name().ok().as_deref() == Some(name.as_str()))
                    })
                }) else {
                    let _ =
                        ready_tx.send(Err("Windows VB-CABLE loopback device was not found".into()));
                    return;
                };
                let speaker_stream =
                    match build_input_stream(&speaker_device, AudioChannel::Speaker, tx) {
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
                drop(speaker_stream);
            }
            drop(mic_stream);
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

/// Checks the actual shared-mode loopback initialization path. Merely having
/// a default output endpoint is not enough: WASAPI loopback is a capture client
/// initialized against a render endpoint with the loopback stream flag.
fn probe_wasapi_loopback() -> Result<String, String> {
    std::thread::spawn(probe_wasapi_loopback_on_thread)
        .join()
        .map_err(|_| "WASAPI capability probe thread panicked".to_string())?
}

fn probe_wasapi_loopback_on_thread() -> Result<String, String> {
    wasapi::initialize_mta()
        .ok()
        .map_err(|error| format!("could not initialize Windows audio COM: {error}"))?;
    let result: Result<String, String> = (|| {
        let enumerator = wasapi::DeviceEnumerator::new().map_err(|error| error.to_string())?;
        let device = enumerator
            .get_default_device(&wasapi::Direction::Render)
            .map_err(|error| error.to_string())?;
        let name = device
            .get_friendlyname()
            .map_err(|error| error.to_string())?;
        let mut audio_client = device
            .get_iaudioclient()
            .map_err(|error| error.to_string())?;
        let format = wasapi::WaveFormat::new(
            32,
            32,
            &wasapi::SampleType::Float,
            WASAPI_SAMPLE_RATE_HZ as usize,
            WASAPI_CHANNELS as usize,
            None,
        );
        let mode = wasapi::StreamMode::PollingShared {
            autoconvert: true,
            buffer_duration_hns: WASAPI_BUFFER_DURATION_HNS,
        };
        audio_client
            .initialize_client(&format, &wasapi::Direction::Capture, &mode)
            .map_err(|error| error.to_string())?;
        Ok(name)
    })();
    wasapi::deinitialize();
    result
}

fn run_wasapi_loopback(
    running: Arc<AtomicBool>,
    tx: std::sync::mpsc::Sender<CapturedFrame>,
    ready_tx: oneshot::Sender<Result<(), String>>,
) -> Result<(), String> {
    if let Err(error) = wasapi::initialize_mta().ok() {
        let message = format!("could not initialize Windows audio COM: {error}");
        let _ = ready_tx.send(Err(message.clone()));
        return Err(message);
    }
    let mut ready_sent = false;
    let mut ready_sender = Some(ready_tx);
    let result: Result<(), String> = (|| {
        let enumerator = wasapi::DeviceEnumerator::new().map_err(|error| error.to_string())?;
        let device = enumerator
            .get_default_device(&wasapi::Direction::Render)
            .map_err(|error| error.to_string())?;
        let mut audio_client = device
            .get_iaudioclient()
            .map_err(|error| error.to_string())?;
        let format = wasapi::WaveFormat::new(
            32,
            32,
            &wasapi::SampleType::Float,
            WASAPI_SAMPLE_RATE_HZ as usize,
            WASAPI_CHANNELS as usize,
            None,
        );
        let mode = wasapi::StreamMode::PollingShared {
            autoconvert: true,
            buffer_duration_hns: WASAPI_BUFFER_DURATION_HNS,
        };
        audio_client
            .initialize_client(&format, &wasapi::Direction::Capture, &mode)
            .map_err(|error| error.to_string())?;
        let capture_client = audio_client
            .get_audiocaptureclient()
            .map_err(|error| error.to_string())?;
        audio_client
            .start_stream()
            .map_err(|error| error.to_string())?;

        let Some(sender) = ready_sender.take() else {
            return Err("WASAPI readiness sender was already consumed".to_string());
        };
        ready_sent = true;
        if sender.send(Ok(())).is_err() {
            return Ok(());
        }

        let bytes_per_frame = format.get_blockalign() as usize;
        while running.load(Ordering::SeqCst) {
            let packet_frames = capture_client
                .get_next_packet_size()
                .map_err(|error| error.to_string())?
                .unwrap_or_default();
            if packet_frames == 0 {
                std::thread::sleep(Duration::from_millis(5));
                continue;
            }

            let mut raw = vec![0_u8; packet_frames as usize * bytes_per_frame];
            let (frames_read, buffer_info) = capture_client
                .read_from_device(&mut raw)
                .map_err(|error| error.to_string())?;
            raw.truncate(frames_read as usize * bytes_per_frame);
            let pcm16 = if buffer_info.flags.silent {
                vec![0_u8; frames_read as usize * std::mem::size_of::<i16>()]
            } else {
                interleaved_f32_to_mono_pcm16(&raw, WASAPI_CHANNELS as usize)
            };
            if !pcm16.is_empty() {
                let _ = tx.send(CapturedFrame {
                    channel: AudioChannel::Speaker,
                    pcm16,
                    sample_rate_hz: WASAPI_SAMPLE_RATE_HZ,
                });
            }
        }

        audio_client
            .stop_stream()
            .map_err(|error| error.to_string())?;
        Ok(())
    })();
    if !ready_sent {
        if let Err(error) = &result {
            if let Some(sender) = ready_sender {
                let _ = sender.send(Err(error.clone()));
            }
        }
    }
    wasapi::deinitialize();
    result
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
