//! macOS capture prefers ScreenCaptureKit's native system-audio stream and
//! falls back to BlackHole when Screen Recording permission is unavailable.
//! The native path requires macOS 13 or newer. BlackHole is never bundled; the app links
//! to Existential Audio's official download when the fallback is selected.
//!
//! The native system stream and the microphone remain independent channels:
//! ScreenCaptureKit owns remote/system audio while cpal owns the user's
//! microphone. This keeps the pipeline's local persistence and provider
//! contracts identical across operating systems.

use crate::device_matching::{find_matching_device, MACOS_DEVICE_HINT};
use crate::{
    capture_ready, interleaved_f32_to_mono_pcm16, AudioCapture, AudioDiagnostics, AudioError,
    CapturedFrame, DriverStatus,
};
use async_trait::async_trait;
use cpal::traits::{DeviceTrait, HostTrait};
use notetaker_core::providers::AudioChannel;
use screencapturekit::prelude::*;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::oneshot;

pub const BLACKHOLE_DOWNLOAD_URL: &str = "https://existential.audio/blackhole/";
const SCREEN_CAPTURE_SAMPLE_RATE_HZ: u32 = 48_000;
const SCREEN_CAPTURE_CHANNELS: usize = 2;

pub struct MacosAudioCapture {
    running: Arc<AtomicBool>,
    session: Arc<crate::session::CaptureSession>,
    health: crate::HealthHub,
}

impl MacosAudioCapture {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            session: Arc::new(crate::session::CaptureSession::new()),
            health: crate::HealthHub::new(),
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

    fn native_system_audio_available(&self) -> bool {
        // Unlike SCShareableContent::get, this never prompts during preflight.
        unsafe { CGPreflightScreenCaptureAccess() }
    }
}

impl Default for MacosAudioCapture {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AudioCapture for MacosAudioCapture {
    fn subscribe_health(&self) -> tokio::sync::broadcast::Receiver<crate::CaptureHealthEvent> {
        self.health.subscribe()
    }
    fn prepare(&self) -> Result<(), AudioError> {
        // ScreenCaptureKit and an already-installed BlackHole require no
        // mutation here. The fallback installer remains an explicit user
        // action because its compiled package is not redistributable by us.
        Ok(())
    }

    fn driver_status(&self) -> DriverStatus {
        if self.native_system_audio_available() || self.installed_device_name().is_some() {
            DriverStatus::Installed
        } else {
            DriverStatus::NotInstalled {
                install_guidance: format!(
                    "Native macOS system-audio capture is unavailable. Grant AI Notetaker Screen Recording permission in System Settings, or download BlackHole from {BLACKHOLE_DOWNLOAD_URL}, install it, and come back here."
                ),
            }
        }
    }

    fn diagnostics(&self) -> AudioDiagnostics {
        let native_loopback = self.native_system_audio_available();
        let fallback_speaker = self.installed_device_name();
        let fallback_available = fallback_speaker.is_some();
        let speaker = if native_loopback {
            Some("ScreenCaptureKit system audio".to_string())
        } else {
            fallback_speaker
        };
        let microphone = cpal::default_host()
            .default_input_device()
            .and_then(|device| device.name().ok());
        let permission_required = microphone.is_none() || (!native_loopback && !fallback_available);
        let driver_installed = speaker.is_some();
        let ready = capture_ready(
            driver_installed,
            microphone.is_some(),
            speaker.is_some(),
            true,
            permission_required,
        );
        AudioDiagnostics {
            platform: "macos".to_string(),
            driver: if native_loopback {
                "ScreenCaptureKit"
            } else {
                "BlackHole"
            }
            .to_string(),
            driver_installed,
            microphone,
            speaker,
            ready,
            guidance: if ready && native_loopback {
                "Native ScreenCaptureKit system-audio capture is available. Keep your meeting app on its normal microphone and speaker; macOS will ask for Screen Recording permission the first time.".to_string()
            } else if ready {
                format!(
                    "BlackHole fallback is available. Create a Multi-Output Device with BlackHole and your normal speakers or headphones so the meeting remains audible. {}",
                    BLACKHOLE_DOWNLOAD_URL
                )
            } else {
                format!(
                    "macOS system-audio capture is not ready. Grant Screen Recording permission or install BlackHole from {BLACKHOLE_DOWNLOAD_URL}, then make sure a microphone is available."
                )
            },
            native_loopback,
            virtual_device_fallback: !native_loopback && fallback_available,
            permission_required,
            microphone_permission: crate::PermissionState::NotApplicable,
            screen_permission: if native_loopback {
                crate::PermissionState::Granted
            } else {
                crate::PermissionState::NotDetermined
            },
        }
    }

    async fn start_capture(
        &self,
        on_frame: Box<dyn Fn(CapturedFrame) + Send + Sync>,
    ) -> Result<(), AudioError> {
        self.stop_capture().await?;
        let native_loopback =
            self.native_system_audio_available() || unsafe { CGRequestScreenCaptureAccess() };
        let fallback_device_name = if native_loopback {
            None
        } else {
            Some(
                self.installed_device_name()
                    .ok_or_else(|| AudioError::DeviceNotFound("BlackHole".to_string()))?,
            )
        };
        self.running.store(true, Ordering::SeqCst);

        let (tx, rx) = std::sync::mpsc::channel::<CapturedFrame>();
        let running = self.running.clone();
        let health = self.health.clone();
        let (ready_tx, ready_rx) = oneshot::channel::<Result<(), String>>();

        let worker = std::thread::spawn(move || {
            let host = cpal::default_host();
            let mic_device = host.default_input_device();
            let Some(mic_device) = mic_device else {
                let _ = ready_tx.send(Err("the system microphone was not found".into()));
                return;
            };
            let mic_stream = match build_input_stream(
                &mic_device,
                AudioChannel::Mic,
                tx.clone(),
                health.clone(),
            ) {
                Ok(stream) => stream,
                Err(error) => {
                    let _ = ready_tx.send(Err(error.to_string()));
                    return;
                }
            };

            if native_loopback {
                if let Err(error) = run_screencapturekit_capture(running.clone(), tx, ready_tx) {
                    tracing::error!(%error, "macOS ScreenCaptureKit capture stopped");
                    health.emit(
                        AudioChannel::Speaker,
                        crate::CaptureHealthKind::SourceEnded,
                        error,
                    );
                }
            } else {
                let Some(speaker_device) = fallback_device_name.as_ref().and_then(|name| {
                    host.input_devices().ok().and_then(|mut it| {
                        it.find(|d| d.name().ok().as_deref() == Some(name.as_str()))
                    })
                }) else {
                    let _ = ready_tx.send(Err("macOS BlackHole device was not found".into()));
                    return;
                };
                let speaker_stream =
                    match build_input_stream(&speaker_device, AudioChannel::Speaker, tx, health) {
                        Ok(stream) => stream,
                        Err(error) => {
                            let _ = ready_tx.send(Err(error.to_string()));
                            return;
                        }
                    };
                let _ = ready_tx.send(Ok(()));
                while running.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(100));
                }
                drop(speaker_stream);
            }
            drop(mic_stream);
        });
        let delivery = crate::session::spawn_frame_delivery(rx, on_frame);
        self.session.attach(vec![worker, delivery]);

        match tokio::time::timeout(Duration::from_secs(3), ready_rx).await {
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

        Ok(())
    }

    async fn stop_capture(&self) -> Result<(), AudioError> {
        self.running.store(false, Ordering::SeqCst);
        self.session.stop().await;
        Ok(())
    }
}

fn create_screencapturekit_stream() -> Result<SCStream, String> {
    let content = SCShareableContent::get().map_err(|error| error.to_string())?;
    let display = content
        .displays()
        .into_iter()
        .next()
        .ok_or_else(|| "macOS did not expose a capturable display".to_string())?;
    let filter = SCContentFilter::create()
        .with_display(&display)
        .with_excluding_windows(&[])
        .build()
        .map_err(|error| error.to_string())?;
    let configuration = SCStreamConfiguration::new()
        .with_width(display.width())
        .with_height(display.height())
        .with_captures_audio(true)
        .with_sample_rate(SCREEN_CAPTURE_SAMPLE_RATE_HZ as i32)
        .with_channel_count(SCREEN_CAPTURE_CHANNELS as i32)
        .with_excludes_current_process_audio(true);
    SCStream::new(&filter, &configuration).map_err(|error| error.to_string())
}

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

fn run_screencapturekit_capture(
    running: Arc<AtomicBool>,
    tx: std::sync::mpsc::Sender<CapturedFrame>,
    ready_tx: oneshot::Sender<Result<(), String>>,
) -> Result<(), String> {
    let mut ready_sender = Some(ready_tx);
    let mut ready_sent = false;
    let result: Result<(), String> = (|| {
        let mut stream = create_screencapturekit_stream()?;
        let audio_tx = tx;
        stream
            .add_output_handler(
                move |sample: CMSampleBuffer, _output_type: SCStreamOutputType| {
                    match screencapturekit_sample_to_pcm16(&sample) {
                        Ok((pcm16, sample_rate_hz)) if !pcm16.is_empty() => {
                            let _ = audio_tx.send(CapturedFrame {
                                channel: AudioChannel::Speaker,
                                pcm16,
                                sample_rate_hz,
                            });
                        }
                        Ok(_) => {}
                        Err(error) => {
                            tracing::debug!(%error, "ignoring unsupported ScreenCaptureKit audio buffer");
                        }
                    }
                },
                SCStreamOutputType::Audio,
            )
            .map_err(|error| error.to_string())?;
        stream.start_capture().map_err(|error| error.to_string())?;

        let Some(sender) = ready_sender.take() else {
            return Err("ScreenCaptureKit readiness sender was already consumed".to_string());
        };
        ready_sent = true;
        if sender.send(Ok(())).is_err() {
            let _ = stream.stop_capture();
            return Ok(());
        }

        while running.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(100));
        }
        stream.stop_capture().map_err(|error| error.to_string())?;
        Ok(())
    })();
    if !ready_sent {
        if let Err(error) = &result {
            if let Some(sender) = ready_sender {
                let _ = sender.send(Err(error.clone()));
            }
        }
    }
    result
}

fn screencapturekit_sample_to_pcm16(sample: &CMSampleBuffer) -> Result<(Vec<u8>, u32), String> {
    let format = sample
        .format_description()
        .ok_or_else(|| "ScreenCaptureKit audio sample had no format description".to_string())?;
    let sample_rate_hz = format
        .audio_sample_rate()
        .unwrap_or(SCREEN_CAPTURE_SAMPLE_RATE_HZ as f64)
        .round() as u32;
    let bits_per_sample = format.audio_bits_per_channel().unwrap_or(32);
    if bits_per_sample != 32 || !format.audio_is_float() || format.audio_is_big_endian() {
        return Err(format!(
            "unsupported ScreenCaptureKit audio format: {bits_per_sample}-bit {}endian {}",
            if format.audio_is_big_endian() {
                "big "
            } else {
                "little "
            },
            if format.audio_is_float() {
                "float"
            } else {
                "integer"
            },
        ));
    }

    let buffers = sample.audio_buffer_list().map_err(|status| {
        format!("could not copy ScreenCaptureKit audio buffer list ({status})")
    })?;
    if buffers.num_buffers() == 0 {
        return Ok((Vec::new(), sample_rate_hz));
    }
    if buffers.num_buffers() == 1 {
        let buffer = buffers
            .get(0)
            .ok_or_else(|| "ScreenCaptureKit returned an empty audio buffer".to_string())?;
        let channels = buffer.number_channels.max(1) as usize;
        return Ok((
            interleaved_f32_to_mono_pcm16(buffer.data(), channels),
            sample_rate_hz,
        ));
    }

    let mut channel_buffers = Vec::with_capacity(buffers.num_buffers());
    let mut total_channels = 0_usize;
    let mut frame_count = usize::MAX;
    for buffer in &buffers {
        let channels = buffer.number_channels.max(1) as usize;
        let frames = buffer.data().len() / (std::mem::size_of::<f32>() * channels);
        frame_count = frame_count.min(frames);
        total_channels = total_channels.saturating_add(channels);
        channel_buffers.push((buffer.data(), channels));
    }
    if frame_count == 0 || total_channels == 0 {
        return Ok((Vec::new(), sample_rate_hz));
    }

    let mut pcm16 = Vec::with_capacity(frame_count * std::mem::size_of::<i16>());
    for frame_index in 0..frame_count {
        let mut sum = 0.0_f32;
        for (data, channels) in &channel_buffers {
            for channel_index in 0..*channels {
                let offset = (frame_index * *channels + channel_index) * std::mem::size_of::<f32>();
                let sample_bytes = &data[offset..offset + std::mem::size_of::<f32>()];
                sum += f32::from_le_bytes([
                    sample_bytes[0],
                    sample_bytes[1],
                    sample_bytes[2],
                    sample_bytes[3],
                ]);
            }
        }
        let mono = (sum / total_channels as f32).clamp(-1.0, 1.0);
        pcm16.extend_from_slice(&((mono * i16::MAX as f32).round() as i16).to_le_bytes());
    }
    Ok((pcm16, sample_rate_hz))
}

fn build_input_stream(
    device: &cpal::Device,
    channel: AudioChannel,
    tx: std::sync::mpsc::Sender<CapturedFrame>,
    health: crate::HealthHub,
) -> Result<cpal::Stream, AudioError> {
    crate::input::build_input_stream(
        device,
        channel,
        tx,
        Arc::new(move |error| health.emit(channel, crate::CaptureHealthKind::StreamError, error)),
    )
}
