//! Linux virtual audio device: a PulseAudio/PipeWire null-sink (for the
//! "speaker" side, i.e. remote participants' audio) plus a loopback so the
//! user still hears the meeting normally, and a remap-source alias of the
//! real microphone (for the "mic" side). No custom driver — this is all
//! standard PulseAudio module composition, per the non-negotiable
//! constraint against building our own audio driver.
//!
//! Module setup shells out to `pactl` (present on both PulseAudio and
//! PipeWire-with-pulse-compat systems, which covers the large majority of
//! desktop Linux). The microphone still uses cpal's default input device,
//! while the null-sink monitor is captured through `parec`: cpal's ALSA
//! enumeration cannot reliably see PipeWire/PulseAudio sources.

use crate::{AudioCapture, AudioDiagnostics, AudioError, CapturedFrame, DriverStatus};
use async_trait::async_trait;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use notetaker_core::providers::AudioChannel;
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

const SINK_NAME: &str = "notetaker_sink";
const SINK_MONITOR_NAME: &str = "notetaker_sink.monitor";
const SINK_DESCRIPTION: &str = "AI Notetaker";
const MIC_SOURCE_NAME: &str = "notetaker_mic";
const PAREC_SAMPLE_RATE_HZ: u32 = 48_000;

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

    fn diagnostics(&self) -> AudioDiagnostics {
        let driver_installed = matches!(self.driver_status(), DriverStatus::Installed);
        let host = cpal::default_host();
        let microphone = host
            .default_input_device()
            .and_then(|device| device.name().ok());
        let sources = run_pactl(&["list", "short", "sources"]).unwrap_or_default();
        let speaker =
            source_is_listed(&sources, SINK_MONITOR_NAME).then(|| SINK_MONITOR_NAME.to_string());
        let mic_source_available = source_is_listed(&sources, MIC_SOURCE_NAME);
        let ready =
            driver_installed && microphone.is_some() && speaker.is_some() && mic_source_available;
        AudioDiagnostics {
            platform: "linux".to_string(),
            driver: SINK_DESCRIPTION.to_string(),
            driver_installed,
            microphone,
            speaker,
            ready,
            guidance: if ready {
                "Audio devices are ready. In your meeting app, choose your physical/default microphone as Microphone and AI Notetaker as Speaker/Output. Keep your normal headphones or speakers as the system output.".to_string()
            } else if !driver_installed {
                "AI Notetaker will create its PulseAudio/PipeWire devices when you check again. Make sure pactl and PulseAudio/PipeWire are available.".to_string()
            } else {
                "The virtual device exists, but the microphone or PulseAudio/PipeWire sources are not available yet. Check the system audio service and try again.".to_string()
            },
        }
    }

    fn prepare(&self) -> Result<(), AudioError> {
        self.ensure_virtual_devices()
    }

    async fn start_capture(
        &self,
        on_frame: Box<dyn Fn(CapturedFrame) + Send + Sync>,
    ) -> Result<(), AudioError> {
        self.ensure_virtual_devices()?;
        let sources = run_pactl(&["list", "short", "sources"])?;
        if !source_is_listed(&sources, SINK_MONITOR_NAME) {
            return Err(AudioError::DeviceNotFound(SINK_MONITOR_NAME.to_string()));
        }
        self.running.store(true, Ordering::SeqCst);

        let (tx, rx) = std::sync::mpsc::channel::<CapturedFrame>();
        let running = self.running.clone();
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<Result<(), String>>();

        // cpal::Stream is not Send, so the mic stream lives entirely on this
        // dedicated OS thread. The parec child and its reader stay on the
        // same thread too; only CapturedFrame values cross to the async side,
        // via a plain mpsc channel.
        std::thread::spawn(move || {
            let host = cpal::default_host();
            let mic_device = host.default_input_device();
            let Some(mic_device) = mic_device else {
                let _ = ready_tx.send(Err("the system microphone was not found".into()));
                return;
            };

            let mut parec = match spawn_parec() {
                Ok(child) => child,
                Err(error) => {
                    let _ = ready_tx.send(Err(error.to_string()));
                    return;
                }
            };
            let Some(parec_stdout) = parec.stdout.take() else {
                let _ = parec.kill();
                let _ = parec.wait();
                let _ = ready_tx.send(Err("parec did not provide stdout".into()));
                return;
            };

            let mic_stream = match build_input_stream(&mic_device, AudioChannel::Mic, tx.clone()) {
                Ok(stream) => stream,
                Err(error) => {
                    let _ = parec.kill();
                    let _ = parec.wait();
                    let _ = ready_tx.send(Err(error.to_string()));
                    return;
                }
            };

            let speaker_running = running.clone();
            let speaker_thread = std::thread::spawn(move || {
                read_parec_frames(parec_stdout, speaker_running, tx);
            });
            let _ = ready_tx.send(Ok(()));

            while running.load(Ordering::SeqCst) {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            let _ = parec.kill();
            let _ = parec.wait();
            drop(mic_stream);
            let _ = speaker_thread.join();
            // The cpal stream and parec child both stop here.
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

fn spawn_parec() -> Result<Child, AudioError> {
    spawn_parec_with_program("parec")
}

fn spawn_parec_with_program(program: &str) -> Result<Child, AudioError> {
    Command::new(program)
        .args([
            "-d",
            SINK_MONITOR_NAME,
            "--raw",
            "--format=s16le",
            "--rate=48000",
            "--channels=2",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AudioError::StreamError(format!("failed to spawn parec: {e}")))
}

fn read_parec_frames(
    mut stdout: impl Read,
    running: Arc<AtomicBool>,
    tx: std::sync::mpsc::Sender<CapturedFrame>,
) {
    let mut buffer = [0_u8; 19_200]; // 100 ms of 48 kHz, 16-bit, stereo PCM.
    loop {
        match stdout.read(&mut buffer) {
            Ok(0) => break,
            Ok(bytes_read) => {
                let _ = tx.send(CapturedFrame {
                    channel: AudioChannel::Speaker,
                    pcm16: buffer[..bytes_read].to_vec(),
                    sample_rate_hz: PAREC_SAMPLE_RATE_HZ,
                });
            }
            Err(error) => {
                if running.load(Ordering::SeqCst) {
                    tracing::error!("parec audio read failed: {error}");
                }
                break;
            }
        }
    }
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

fn source_is_listed(sources: &str, source_name: &str) -> bool {
    sources.lines().any(|line| {
        line.split_whitespace()
            .nth(1)
            .is_some_and(|name| name == source_name)
    })
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn source_probe_matches_exact_pulse_source_names() {
        let sources = "2 notetaker_sink.monitor module-null-sink.c s16le 2ch 48000Hz RUNNING\n3 notetaker_mic module-remap-source.c s16le 1ch 48000Hz IDLE\n";
        assert!(source_is_listed(sources, SINK_MONITOR_NAME));
        assert!(source_is_listed(sources, MIC_SOURCE_NAME));
        assert!(!source_is_listed(sources, "notetaker_sink"));
    }

    #[test]
    fn parec_spawn_uses_raw_dual_channel_contract() {
        let directory = tempfile::tempdir().expect("temp directory");
        let script = directory.path().join("fake-parec");
        let args_file = directory.path().join("args");
        fs::write(
            &script,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\nprintf '\\001\\002\\003\\004'\n",
                args_file.display()
            ),
        )
        .expect("fake parec script");
        let mut permissions = fs::metadata(&script)
            .expect("script metadata")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&script, permissions).expect("script permissions");

        let mut child = spawn_parec_with_program(script.to_str().expect("script path"))
            .expect("fake parec should spawn");
        let mut output = Vec::new();
        child
            .stdout
            .take()
            .expect("stdout")
            .read_to_end(&mut output)
            .expect("read fake parec output");
        assert_eq!(child.wait().expect("fake parec exit").code(), Some(0));
        assert_eq!(output, vec![1, 2, 3, 4]);
        assert_eq!(
            fs::read_to_string(args_file).expect("captured args"),
            "-d\nnotetaker_sink.monitor\n--raw\n--format=s16le\n--rate=48000\n--channels=2\n"
        );
    }
}
