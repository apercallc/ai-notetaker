//! Linux virtual audio device: a PulseAudio/PipeWire null-sink (for the
//! "speaker" side, i.e. remote participants' audio) plus a loopback so the
//! user still hears the meeting normally, and a remap-source alias of the
//! real microphone (for the "mic" side). No custom driver — this is all
//! standard PulseAudio module composition, per the non-negotiable
//! constraint against building our own audio driver.
//!
//! Module setup shells out to `pactl` (present on both PulseAudio and
//! PipeWire-with-pulse-compat systems, which covers the large majority of
//! desktop Linux). Capture itself uses `cpal`, same as the other
//! platforms, reading from the null sink's monitor and from the real
//! default input device.

use crate::device_matching::{find_matching_device, LINUX_DEVICE_HINT};
use crate::{AudioCapture, AudioError, CapturedFrame, DriverStatus};
use async_trait::async_trait;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use notetaker_core::providers::AudioChannel;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

const SINK_NAME: &str = "notetaker_sink";
const SINK_DESCRIPTION: &str = "AI Notetaker";
const MIC_SOURCE_NAME: &str = "notetaker_mic";

pub struct LinuxAudioCapture {
    running: Arc<AtomicBool>,
}

impl LinuxAudioCapture {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Idempotently creates the null-sink + loopback + mic-remap modules if
    /// they don't already exist. Safe to call on every helper startup.
    pub fn ensure_virtual_devices(&self) -> Result<(), AudioError> {
        if !module_exists(SINK_NAME)? {
            run_pactl(&[
                "load-module",
                "module-null-sink",
                &format!("sink_name={SINK_NAME}"),
                &format!("sink_properties=device.description={SINK_DESCRIPTION}"),
            ])?;
            // So the user still hears the meeting normally through their
            // real output, instead of it going silently into the null sink.
            if let Some(real_output) = default_sink_name()? {
                run_pactl(&[
                    "load-module",
                    "module-loopback",
                    &format!("source={SINK_NAME}.monitor"),
                    &format!("sink={real_output}"),
                ])
                .ok(); // best-effort: audio capture still works without this, just silently to the user
            }
        }
        if !module_exists(MIC_SOURCE_NAME)? {
            if let Some(real_input) = default_source_name()? {
                run_pactl(&[
                    "load-module",
                    "module-remap-source",
                    &format!("master={real_input}"),
                    &format!("source_name={MIC_SOURCE_NAME}"),
                ])?;
            }
        }
        Ok(())
    }
}

impl Default for LinuxAudioCapture {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AudioCapture for LinuxAudioCapture {
    fn driver_status(&self) -> DriverStatus {
        match module_exists(SINK_NAME) {
            Ok(true) => DriverStatus::Installed,
            _ => DriverStatus::NotInstalled {
                install_guidance: "AI Notetaker sets up its virtual audio devices automatically on Linux via PulseAudio/PipeWire — if this still shows as missing, ensure `pactl` is installed and PulseAudio or PipeWire is running.".to_string(),
            },
        }
    }

    async fn start_capture(
        &self,
        on_frame: Box<dyn Fn(CapturedFrame) + Send + Sync>,
    ) -> Result<(), AudioError> {
        self.ensure_virtual_devices()?;
        self.running.store(true, Ordering::SeqCst);

        let (tx, rx) = std::sync::mpsc::channel::<CapturedFrame>();
        let running = self.running.clone();

        // cpal::Stream is not Send, so the streams live entirely on this
        // dedicated OS thread; only CapturedFrame values cross to the
        // async side, via a plain mpsc channel.
        std::thread::spawn(move || {
            let host = cpal::default_host();
            let device_names: Vec<String> = host
                .input_devices()
                .map(|it| it.filter_map(|d| d.name().ok()).collect())
                .unwrap_or_default();

            let speaker_device =
                find_matching_device(&device_names, &format!("{SINK_NAME}.monitor"))
                    .or_else(|| find_matching_device(&device_names, LINUX_DEVICE_HINT))
                    .and_then(|name| {
                        host.input_devices()
                            .ok()?
                            .find(|d| d.name().ok().as_deref() == Some(name))
                    });
            let mic_device = host.default_input_device();

            let _speaker_stream = speaker_device
                .and_then(|d| build_input_stream(&d, AudioChannel::Speaker, tx.clone()).ok());
            let _mic_stream =
                mic_device.and_then(|d| build_input_stream(&d, AudioChannel::Mic, tx.clone()).ok());

            while running.load(Ordering::SeqCst) {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            // Streams drop here, stopping capture.
        });

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
        .map_err(|e| AudioError::StreamError(format!("no default input config: {e}")))?;
    let sample_rate_hz = config.sample_rate().0;

    let stream = device
        .build_input_stream(
            &config.into(),
            move |data: &[f32], _| {
                let pcm16: Vec<u8> = data
                    .iter()
                    .flat_map(|sample| {
                        ((sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16).to_le_bytes()
                    })
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

fn run_pactl(args: &[&str]) -> Result<String, AudioError> {
    let output = Command::new("pactl")
        .args(args)
        .output()
        .map_err(|e| AudioError::DriverSetup(format!("failed to run pactl: {e}")))?;
    if !output.status.success() {
        return Err(AudioError::DriverSetup(format!(
            "pactl {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn module_exists(name_fragment: &str) -> Result<bool, AudioError> {
    let sinks = run_pactl(&["list", "short", "sinks"]).unwrap_or_default();
    let sources = run_pactl(&["list", "short", "sources"]).unwrap_or_default();
    Ok(sinks.contains(name_fragment) || sources.contains(name_fragment))
}

fn default_sink_name() -> Result<Option<String>, AudioError> {
    let info = run_pactl(&["info"]).unwrap_or_default();
    Ok(info
        .lines()
        .find_map(|l| l.strip_prefix("Default Sink: "))
        .map(String::from))
}

fn default_source_name() -> Result<Option<String>, AudioError> {
    let info = run_pactl(&["info"]).unwrap_or_default();
    Ok(info
        .lines()
        .find_map(|l| l.strip_prefix("Default Source: "))
        .map(String::from))
}
