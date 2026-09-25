//! Linux capture prefers an existing PulseAudio/PipeWire monitor source: the
//! monitor of the sink the meeting app actually plays to when that is
//! discoverable through `pactl` sink-inputs, otherwise the default sink's
//! monitor. Only when no monitor exists at all does it fall back to a virtual
//! null-sink plus a loopback (so the user still hears the meeting). No custom
//! driver — this is all standard PulseAudio module composition, per the
//! non-negotiable constraint against building our own audio driver.
//!
//! Passive calls (`prepare`, `driver_status`, `diagnostics`, `list_devices`)
//! only read `pactl` state. Modules are created solely by an explicit
//! `start_capture`/`setup`/`ensure_virtual_devices`, are tracked, and are
//! unloaded again on `stop_capture` and when the capture object is dropped.
//!
//! The microphone goes through cpal's default (or chosen) input device, the
//! speaker monitor through `parec` (cpal's ALSA enumeration cannot reliably
//! see PipeWire/PulseAudio sources). One supervisor thread owns both and
//! restarts either when it dies or when the default device changes.

use crate::convert::{pump_s16le_mono, PumpExit};
use crate::health::{Backoff, CaptureHealthKind, HealthHub};
use crate::input::{default_input_name, list_input_devices, InputSupervisor};
use crate::session::{
    await_ready, spawn_frame_delivery, CaptureSession, FrameCallback, ReadySender,
};
use crate::{
    capture_ready, AudioCapture, AudioDeviceInfo, AudioDeviceList, AudioDiagnostics, AudioError,
    CaptureHealthEvent, CaptureOptions, CapturedFrame, DriverStatus, PermissionState,
};
use async_trait::async_trait;
use notetaker_core::providers::AudioChannel;
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, oneshot};

const SINK_NAME: &str = "notetaker_sink";
const SINK_MONITOR_NAME: &str = "notetaker_sink.monitor";
const SINK_DESCRIPTION: &str = "AI Notetaker";
const PAREC_SAMPLE_RATE_HZ: u32 = 48_000;
/// `parec` is asked for mono so PulseAudio does the channel downmix and the
/// bytes we store really are mono at the advertised rate.
const PAREC_CHANNELS: usize = 1;
const SOURCE_RESCAN_INTERVAL: Duration = Duration::from_secs(2);
const PAREC_STABLE_UPTIME: Duration = Duration::from_secs(5);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(3);

/// Desktop meeting/VoIP applications whose sink we prefer to follow.
const MEETING_APP_HINTS: &[&str] = &[
    "zoom",
    "teams",
    "slack",
    "webex",
    "skype",
    "discord",
    "whereby",
    "bluejeans",
    "gotomeeting",
    "jitsi",
    "signal",
    "telegram",
    "element",
];
/// Browsers count as a weaker signal (a call in a tab).
const BROWSER_HINTS: &[&str] = &[
    "chrome", "chromium", "firefox", "brave", "msedge", "edge", "vivaldi", "opera",
];

pub struct LinuxAudioCapture {
    session: Arc<CaptureSession>,
    /// PulseAudio module ids this helper loaded and must unload again.
    modules: Arc<Mutex<Vec<String>>>,
    health: HealthHub,
}

impl LinuxAudioCapture {
    pub fn new() -> Self {
        Self {
            session: Arc::new(CaptureSession::new()),
            modules: Arc::new(Mutex::new(Vec::new())),
            health: HealthHub::new(),
        }
    }

    /// Idempotently creates the fallback null-sink + loopback. This mutates
    /// the audio server, so it is only called from explicit setup/start
    /// paths, never from passive preflight. Modules it loads (or adopts from a
    /// crashed earlier run) are unloaded on stop.
    pub fn ensure_virtual_devices(&self) -> Result<(), AudioError> {
        ensure_virtual_devices(&self.modules)
    }

    fn unload_modules_blocking(&self) {
        unload_tracked_modules(&self.modules);
    }
}

impl Default for LinuxAudioCapture {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for LinuxAudioCapture {
    fn drop(&mut self) {
        self.session.stop_blocking();
        self.unload_modules_blocking();
    }
}

#[async_trait]
impl AudioCapture for LinuxAudioCapture {
    fn driver_status(&self) -> DriverStatus {
        if resolve_auto_source().is_some() || run_pactl(&["info"]).is_ok() {
            DriverStatus::Installed
        } else {
            DriverStatus::NotInstalled {
                install_guidance: "AI Notetaker captures meeting audio through PulseAudio/PipeWire — install `pactl` (pulseaudio-utils) and make sure PulseAudio or PipeWire is running.".to_string(),
            }
        }
    }

    fn diagnostics(&self) -> AudioDiagnostics {
        let pactl_available = run_pactl(&["info"]).is_ok();
        let sources = run_pactl(&["list", "short", "sources"]).unwrap_or_default();
        let native_monitor = resolve_auto_source();
        let leftover_virtual = source_is_listed(&sources, SINK_MONITOR_NAME);
        let speaker = native_monitor.clone().or_else(|| {
            if leftover_virtual {
                Some(SINK_MONITOR_NAME.to_string())
            } else if pactl_available {
                Some(format!(
                    "{SINK_DESCRIPTION} virtual output (created when recording starts)"
                ))
            } else {
                None
            }
        });
        let microphone = default_input_name();
        let permission_required = microphone.is_none();
        let driver_installed = speaker.is_some();
        let virtual_device_fallback = native_monitor.is_none() && speaker.is_some();
        let ready = capture_ready(
            driver_installed,
            microphone.is_some(),
            speaker.is_some(),
            true,
            permission_required,
        );
        AudioDiagnostics {
            platform: "linux".to_string(),
            driver: if native_monitor.is_some() {
                "PipeWire/PulseAudio monitor"
            } else {
                SINK_DESCRIPTION
            }
            .to_string(),
            driver_installed,
            microphone,
            speaker,
            ready,
            guidance: if ready {
                if native_monitor.is_some() {
                    "PipeWire/PulseAudio monitor capture is ready. Keep your normal microphone and speakers selected in the meeting app.".to_string()
                } else {
                    "No output monitor was found, so AI Notetaker will create a temporary virtual output when you start recording (it is removed again when recording stops). Choose it as the meeting app's speaker.".to_string()
                }
            } else if !driver_installed {
                "PulseAudio/PipeWire was not found. Make sure pactl is installed and PulseAudio or PipeWire is running, then check again.".to_string()
            } else {
                "No microphone was found. Connect or enable a microphone and check the system audio service, then try again.".to_string()
            },
            native_loopback: native_monitor.is_some(),
            virtual_device_fallback,
            permission_required,
            microphone_permission: PermissionState::NotApplicable,
            screen_permission: PermissionState::NotApplicable,
        }
    }

    fn setup(&self) -> Result<(), AudioError> {
        if resolve_auto_source().is_some() {
            Ok(())
        } else {
            self.ensure_virtual_devices()
        }
    }

    fn subscribe_health(&self) -> broadcast::Receiver<CaptureHealthEvent> {
        self.health.subscribe()
    }

    fn list_devices(&self) -> AudioDeviceList {
        let sources = run_pactl(&["list", "short", "sources"]).unwrap_or_default();
        let default_monitor = default_sink_name().map(|sink| format!("{sink}.monitor"));
        AudioDeviceList {
            microphones: list_input_devices(),
            speakers: monitor_sources(&sources)
                .into_iter()
                .map(|name| AudioDeviceInfo {
                    is_default: default_monitor.as_deref() == Some(name.as_str()),
                    id: name.clone(),
                    name,
                })
                .collect(),
        }
    }

    async fn start_capture(&self, on_frame: FrameCallback) -> Result<(), AudioError> {
        self.start_capture_with_options(CaptureOptions::default(), on_frame)
            .await
    }

    async fn start_capture_with_options(
        &self,
        options: CaptureOptions,
        on_frame: FrameCallback,
    ) -> Result<(), AudioError> {
        // A previous capture must be fully gone (threads joined, parec dead)
        // before a new one may start.
        self.session.stop().await;

        let modules = self.modules.clone();
        let requested = options.clone();
        let route = tokio::task::spawn_blocking(move || resolve_start_route(&requested, &modules))
            .await
            .map_err(|error| AudioError::DriverSetup(format!("route lookup failed: {error}")))??;

        let (tx, rx) = std::sync::mpsc::channel::<CapturedFrame>();
        let (ready_tx, ready_rx) = oneshot::channel::<Result<(), String>>();
        let running = self.session.arm();
        let health = self.health.clone();
        let mic_device = options.mic_device;

        let supervisor = std::thread::spawn(move || {
            run_capture(
                CaptureConfig {
                    parec_program: "parec".to_string(),
                    mic_device,
                    route,
                },
                tx,
                running,
                health,
                ready_tx,
            );
        });
        let delivery = spawn_frame_delivery(rx, on_frame);
        self.session.attach(vec![supervisor, delivery]);

        if let Err(error) = await_ready(ready_rx, STARTUP_TIMEOUT).await {
            self.session.stop().await;
            self.unload_modules_async().await;
            return Err(error);
        }
        Ok(())
    }

    async fn stop_capture(&self) -> Result<(), AudioError> {
        self.session.stop().await;
        self.unload_modules_async().await;
        Ok(())
    }
}

impl LinuxAudioCapture {
    async fn unload_modules_async(&self) {
        let modules = self.modules.clone();
        let _ = tokio::task::spawn_blocking(move || unload_tracked_modules(&modules)).await;
    }
}

// ---------------------------------------------------------------------------
// Capture supervisor
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
struct SpeakerRoute {
    source: String,
    /// True when the caller chose the source explicitly: never re-routed.
    pinned: bool,
}

struct CaptureConfig {
    parec_program: String,
    mic_device: Option<String>,
    route: SpeakerRoute,
}

fn send_ready(ready_tx: ReadySender, result: Result<(), String>) {
    let _ = ready_tx.send(result);
}

fn run_capture(
    config: CaptureConfig,
    tx: Sender<CapturedFrame>,
    running: Arc<std::sync::atomic::AtomicBool>,
    health: HealthHub,
    ready_tx: ReadySender,
) {
    use std::sync::atomic::Ordering;

    let mut mic = match InputSupervisor::start(
        AudioChannel::Mic,
        config.mic_device.clone(),
        tx.clone(),
        health.clone(),
    ) {
        Ok(mic) => mic,
        Err(error) => {
            send_ready(ready_tx, Err(error.to_string()));
            return;
        }
    };
    let mut speaker = match ParecCapture::spawn(&config.parec_program, &config.route.source, &tx) {
        Ok(speaker) => Some(speaker),
        Err(error) => {
            drop(mic);
            send_ready(ready_tx, Err(error.to_string()));
            return;
        }
    };
    send_ready(ready_tx, Ok(()));

    let mut current_source = config.route.source.clone();
    let pinned = config.route.pinned;
    let mut backoff = Backoff::default();
    let mut retry_at: Option<Instant> = None;
    let mut debouncer = SourceDebouncer::default();
    let mut next_scan = Instant::now() + SOURCE_RESCAN_INTERVAL;

    while running.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(100));
        mic.tick();
        let now = Instant::now();

        if let Some(active) = speaker.as_mut() {
            if active.has_ended() {
                let detail = active.exit_detail();
                health.emit(
                    AudioChannel::Speaker,
                    CaptureHealthKind::SourceEnded,
                    format!("parec for {current_source} stopped: {detail}"),
                );
                if active.uptime() > PAREC_STABLE_UPTIME {
                    backoff.reset();
                }
                if let Some(ended) = speaker.take() {
                    ended.shutdown();
                }
                retry_at = Some(now + backoff.next_delay());
            }
        }

        if speaker.is_none() {
            if retry_at.is_none_or(|due| now >= due) {
                let source = if pinned {
                    current_source.clone()
                } else {
                    resolve_auto_source().unwrap_or_else(|| current_source.clone())
                };
                match ParecCapture::spawn(&config.parec_program, &source, &tx) {
                    Ok(restarted) => {
                        speaker = Some(restarted);
                        current_source = source;
                        retry_at = None;
                        health.emit(
                            AudioChannel::Speaker,
                            CaptureHealthKind::Restarted,
                            format!("meeting-audio capture restarted on {current_source}"),
                        );
                    }
                    Err(error) => {
                        health.emit(
                            AudioChannel::Speaker,
                            CaptureHealthKind::RestartFailed,
                            error.to_string(),
                        );
                        retry_at = Some(now + backoff.next_delay());
                    }
                }
            }
        } else if !pinned && now >= next_scan {
            next_scan = now + SOURCE_RESCAN_INTERVAL;
            if let Some(better) = debouncer.observe(&current_source, resolve_auto_source()) {
                health.emit(
                    AudioChannel::Speaker,
                    CaptureHealthKind::DeviceChanged,
                    format!("switching meeting-audio capture from {current_source} to {better}"),
                );
                if let Some(old) = speaker.take() {
                    old.shutdown();
                }
                match ParecCapture::spawn(&config.parec_program, &better, &tx) {
                    Ok(next) => {
                        speaker = Some(next);
                        current_source = better;
                        backoff.reset();
                    }
                    Err(error) => {
                        health.emit(
                            AudioChannel::Speaker,
                            CaptureHealthKind::RestartFailed,
                            error.to_string(),
                        );
                        retry_at = Some(now + backoff.next_delay());
                    }
                }
            }
        }
    }

    if let Some(active) = speaker.take() {
        active.shutdown();
    }
    drop(mic);
    // `tx` drops here, which lets the frame-delivery thread drain and exit.
}

/// A running `parec` child plus the thread that turns its stdout into frames.
struct ParecCapture {
    child: Child,
    reader: Option<JoinHandle<PumpExit>>,
    /// Cleared before killing so the reader can tell a deliberate stop from a
    /// crash.
    wanted: Arc<std::sync::atomic::AtomicBool>,
    started_at: Instant,
}

impl ParecCapture {
    fn spawn(program: &str, source: &str, tx: &Sender<CapturedFrame>) -> Result<Self, AudioError> {
        let mut child = spawn_parec_with_source(program, source)?;
        let Some(stdout) = child.stdout.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(AudioError::StreamError(
                "parec did not provide stdout".into(),
            ));
        };
        let wanted = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let reader_wanted = wanted.clone();
        let tx = tx.clone();
        let reader = std::thread::spawn(move || read_parec_frames(stdout, &reader_wanted, tx));
        Ok(Self {
            child,
            reader: Some(reader),
            wanted,
            started_at: Instant::now(),
        })
    }

    fn has_ended(&mut self) -> bool {
        self.reader.as_ref().is_none_or(JoinHandle::is_finished)
            || matches!(self.child.try_wait(), Ok(Some(_)))
    }

    fn uptime(&self) -> Duration {
        self.started_at.elapsed()
    }

    /// Exit status and the tail of stderr, for the health message.
    fn exit_detail(&mut self) -> String {
        let status = match self.child.try_wait() {
            Ok(Some(status)) => status.to_string(),
            Ok(None) => {
                // Reader ended without the process exiting: stop it so stderr
                // reaches EOF below.
                let _ = self.child.kill();
                self.child
                    .wait()
                    .map(|status| status.to_string())
                    .unwrap_or_else(|error| format!("unknown ({error})"))
            }
            Err(error) => format!("unknown ({error})"),
        };
        let mut stderr_text = String::new();
        if let Some(mut stderr) = self.child.stderr.take() {
            let _ = stderr.read_to_string(&mut stderr_text);
        }
        let stderr_text = stderr_text.trim();
        let tail: String = stderr_text
            .chars()
            .rev()
            .take(200)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        if tail.is_empty() {
            format!("exited with {status}")
        } else {
            format!("exited with {status}: {tail}")
        }
    }

    fn shutdown(mut self) {
        self.wanted
            .store(false, std::sync::atomic::Ordering::SeqCst);
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

/// Decides when to move the speaker capture to a different source. A new
/// target must be seen on two consecutive scans, so a meeting app briefly
/// pausing its stream does not make the capture flap between sinks.
#[derive(Debug, Default)]
struct SourceDebouncer {
    pending: Option<String>,
}

impl SourceDebouncer {
    fn observe(&mut self, current: &str, target: Option<String>) -> Option<String> {
        match target {
            Some(target) if target != current => {
                if self.pending.as_deref() == Some(target.as_str()) {
                    self.pending = None;
                    Some(target)
                } else {
                    self.pending = Some(target);
                    None
                }
            }
            _ => {
                self.pending = None;
                None
            }
        }
    }
}

fn spawn_parec_with_source(program: &str, source: &str) -> Result<Child, AudioError> {
    Command::new(program)
        .args([
            "-d",
            source,
            "--raw",
            "--format=s16le",
            "--rate=48000",
            &format!("--channels={PAREC_CHANNELS}"),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AudioError::StreamError(format!("failed to spawn parec: {e}")))
}

fn read_parec_frames(
    stdout: impl Read,
    wanted: &Arc<std::sync::atomic::AtomicBool>,
    tx: Sender<CapturedFrame>,
) -> PumpExit {
    let exit = pump_s16le_mono(stdout, PAREC_CHANNELS, wanted, |pcm16| {
        let _ = tx.send(CapturedFrame {
            channel: AudioChannel::Speaker,
            pcm16,
            sample_rate_hz: PAREC_SAMPLE_RATE_HZ,
        });
    });
    if let PumpExit::ReadError(error) = &exit {
        tracing::error!("parec audio read failed: {error}");
    }
    exit
}

// ---------------------------------------------------------------------------
// Source selection
// ---------------------------------------------------------------------------

fn resolve_start_route(
    options: &CaptureOptions,
    modules: &Mutex<Vec<String>>,
) -> Result<SpeakerRoute, AudioError> {
    let sources = run_pactl(&["list", "short", "sources"])?;
    if let Some(requested) = &options.speaker_device {
        if source_is_listed(&sources, requested) {
            return Ok(SpeakerRoute {
                source: requested.clone(),
                pinned: true,
            });
        }
        tracing::warn!(
            source = requested.as_str(),
            "requested speaker source not found; choosing one automatically"
        );
    }
    if let Some(source) = resolve_auto_source() {
        return Ok(SpeakerRoute {
            source,
            pinned: false,
        });
    }
    // Last resort: no monitor exists, so create the virtual output. This is an
    // explicit start, so mutating the audio server is allowed here.
    ensure_virtual_devices(modules)?;
    let sources = run_pactl(&["list", "short", "sources"])?;
    if !source_is_listed(&sources, SINK_MONITOR_NAME) {
        return Err(AudioError::DeviceNotFound(SINK_MONITOR_NAME.to_string()));
    }
    Ok(SpeakerRoute {
        source: SINK_MONITOR_NAME.to_string(),
        pinned: false,
    })
}

/// Read-only: the monitor source that best represents "what the user hears
/// from the meeting", or `None` if the system has no monitor source.
fn resolve_auto_source() -> Option<String> {
    let sources = run_pactl(&["list", "short", "sources"]).ok()?;
    let default_sink = default_sink_name();
    let meeting_sink = meeting_sink_name();
    choose_speaker_source(&sources, default_sink.as_deref(), meeting_sink.as_deref())
}

fn choose_speaker_source(
    sources: &str,
    default_sink: Option<&str>,
    meeting_sink: Option<&str>,
) -> Option<String> {
    for sink in [meeting_sink, default_sink].into_iter().flatten() {
        let monitor = format!("{sink}.monitor");
        if source_is_listed(sources, &monitor) {
            return Some(monitor);
        }
    }
    monitor_source_from_sources(sources)
}

/// Name of the sink the meeting application is playing to, if discoverable.
fn meeting_sink_name() -> Option<String> {
    let inputs = run_pactl(&["list", "sink-inputs"]).ok()?;
    let sinks = run_pactl(&["list", "short", "sinks"]).ok()?;
    pick_meeting_sink(&parse_sink_inputs(&inputs), &parse_short_sinks(&sinks))
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct SinkInput {
    sink_index: String,
    corked: bool,
    application_name: String,
    binary: String,
    media_name: String,
}

fn parse_sink_inputs(text: &str) -> Vec<SinkInput> {
    let mut inputs: Vec<SinkInput> = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("Sink Input #") {
            inputs.push(SinkInput::default());
            continue;
        }
        let Some(current) = inputs.last_mut() else {
            continue;
        };
        if let Some(index) = trimmed.strip_prefix("Sink: ") {
            current.sink_index = index.trim().to_string();
        } else if let Some(state) = trimmed.strip_prefix("Corked: ") {
            current.corked = state.trim() == "yes";
        } else if let Some(value) = property_value(trimmed, "application.name") {
            current.application_name = value;
        } else if let Some(value) = property_value(trimmed, "application.process.binary") {
            current.binary = value;
        } else if let Some(value) = property_value(trimmed, "media.name") {
            current.media_name = value;
        }
    }
    inputs
}

fn property_value(line: &str, key: &str) -> Option<String> {
    let rest = line.strip_prefix(key)?.trim_start().strip_prefix('=')?;
    Some(rest.trim().trim_matches('"').to_string())
}

fn parse_short_sinks(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|line| {
            let mut columns = line.split_whitespace();
            Some((columns.next()?.to_string(), columns.next()?.to_string()))
        })
        .collect()
}

fn pick_meeting_sink(inputs: &[SinkInput], sinks: &[(String, String)]) -> Option<String> {
    let mut best: Option<(u8, &SinkInput)> = None;
    for input in inputs {
        let haystack = format!("{} {}", input.application_name, input.binary).to_lowercase();
        if haystack.contains("notetaker") || input.media_name.to_lowercase().contains("notetaker") {
            continue;
        }
        let class = if MEETING_APP_HINTS.iter().any(|hint| haystack.contains(hint)) {
            4
        } else if BROWSER_HINTS.iter().any(|hint| haystack.contains(hint)) {
            2
        } else {
            continue;
        };
        let score = class + u8::from(!input.corked);
        if best.is_none_or(|(best_score, _)| score > best_score) {
            best = Some((score, input));
        }
    }
    let (_, chosen) = best?;
    sinks
        .iter()
        .find(|(index, _)| *index == chosen.sink_index)
        .map(|(_, name)| name.clone())
}

// ---------------------------------------------------------------------------
// pactl helpers
// ---------------------------------------------------------------------------

fn run_pactl(args: &[&str]) -> Result<String, AudioError> {
    let output = Command::new("pactl")
        .args(args)
        // Stable, unlocalized output so the text parsers below keep working.
        .env("LC_ALL", "C")
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

fn column(line: &str, index: usize) -> Option<&str> {
    line.split_whitespace().nth(index)
}

fn source_is_listed(sources: &str, source_name: &str) -> bool {
    sources
        .lines()
        .any(|line| column(line, 1) == Some(source_name))
}

fn sink_is_listed(sinks: &str, sink_name: &str) -> bool {
    source_is_listed(sinks, sink_name)
}

/// All monitor sources except the helper's own fallback sink, running ones
/// first (an idle monitor of an unplugged card is a poor default).
fn monitor_sources(sources: &str) -> Vec<String> {
    let mut monitors: Vec<(bool, String)> = sources
        .lines()
        .filter_map(|line| {
            let name = column(line, 1)?;
            (name.ends_with(".monitor") && name != SINK_MONITOR_NAME)
                .then(|| (line.trim_end().ends_with("RUNNING"), name.to_string()))
        })
        .collect();
    monitors.sort_by_key(|(running, _)| !*running);
    monitors.into_iter().map(|(_, name)| name).collect()
}

fn monitor_source_from_sources(sources: &str) -> Option<String> {
    monitor_sources(sources).into_iter().next()
}

fn pactl_info_field(prefix: &str) -> Option<String> {
    run_pactl(&["info"])
        .ok()?
        .lines()
        .find_map(|line| line.strip_prefix(prefix))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && value != "@DEFAULT_SINK@")
}

fn default_sink_name() -> Option<String> {
    pactl_info_field("Default Sink: ")
}

// ---------------------------------------------------------------------------
// Fallback virtual devices (explicit setup only)
// ---------------------------------------------------------------------------

fn ensure_virtual_devices(modules: &Mutex<Vec<String>>) -> Result<(), AudioError> {
    let sinks = run_pactl(&["list", "short", "sinks"]).unwrap_or_default();
    if sink_is_listed(&sinks, SINK_NAME) {
        // Left over from an earlier crashed run: take ownership so it is
        // cleaned up on stop instead of lingering forever.
        adopt_existing_modules(modules);
        return Ok(());
    }
    let sink_module = run_pactl(&[
        "load-module",
        "module-null-sink",
        &format!("sink_name={SINK_NAME}"),
        &format!("sink_properties=device.description={SINK_DESCRIPTION}"),
    ])?;
    track_module(modules, &sink_module);
    // So the user still hears the meeting normally through their real output,
    // instead of it going silently into the null sink.
    if let Some(real_output) = default_sink_name() {
        if let Ok(loopback) = run_pactl(&[
            "load-module",
            "module-loopback",
            &format!("source={SINK_MONITOR_NAME}"),
            &format!("sink={real_output}"),
        ]) {
            track_module(modules, &loopback);
        }
        // Best-effort: capture still works without the loopback, the user
        // just would not hear the meeting.
    }
    Ok(())
}

fn track_module(modules: &Mutex<Vec<String>>, load_module_output: &str) {
    if let Some(id) = parse_module_id(load_module_output) {
        if let Ok(mut guard) = modules.lock() {
            if !guard.contains(&id) {
                guard.push(id);
            }
        }
    }
}

fn parse_module_id(load_module_output: &str) -> Option<String> {
    let id = load_module_output.trim();
    (!id.is_empty() && id.chars().all(|c| c.is_ascii_digit())).then(|| id.to_string())
}

/// Module ids of `module_name` whose arguments contain `argument`.
fn module_ids_with_argument(list: &str, module_name: &str, argument: &str) -> Vec<String> {
    list.lines()
        .filter_map(|line| {
            let mut columns = line.splitn(3, '\t');
            let id = columns.next()?.trim();
            let name = columns.next()?.trim();
            let arguments = columns.next().unwrap_or_default();
            (name == module_name && arguments.contains(argument)).then(|| id.to_string())
        })
        .collect()
}

fn adopt_existing_modules(modules: &Mutex<Vec<String>>) {
    let Ok(list) = run_pactl(&["list", "short", "modules"]) else {
        return;
    };
    let mut found =
        module_ids_with_argument(&list, "module-null-sink", &format!("sink_name={SINK_NAME}"));
    found.extend(module_ids_with_argument(
        &list,
        "module-loopback",
        &format!("source={SINK_MONITOR_NAME}"),
    ));
    if let Ok(mut guard) = modules.lock() {
        for id in found {
            if !guard.contains(&id) {
                guard.push(id);
            }
        }
    }
}

/// Unloads modules this helper loaded, newest first (loopback before sink).
fn unload_tracked_modules(modules: &Mutex<Vec<String>>) {
    let ids: Vec<String> = modules
        .lock()
        .map(|mut guard| guard.drain(..).collect())
        .unwrap_or_default();
    for id in ids.into_iter().rev() {
        if let Err(error) = run_pactl(&["unload-module", &id]) {
            tracing::warn!(module = id.as_str(), %error, "could not unload PulseAudio module");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::convert::S16leMonoConverter;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    fn write_script(dir: &std::path::Path, name: &str, body: &str) -> String {
        let script = dir.join(name);
        fs::write(&script, format!("#!/bin/sh\n{body}\n")).expect("fake script");
        let mut permissions = fs::metadata(&script).expect("metadata").permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&script, permissions).expect("permissions");
        script.to_str().expect("utf8 path").to_string()
    }

    #[test]
    fn source_probe_matches_exact_pulse_source_names() {
        let sources = "2\tnotetaker_sink.monitor\tmodule-null-sink.c\ts16le 2ch 48000Hz\tRUNNING\n3\tnotetaker_mic\tmodule-remap-source.c\ts16le 1ch 48000Hz\tIDLE\n";
        assert!(source_is_listed(sources, SINK_MONITOR_NAME));
        assert!(source_is_listed(sources, "notetaker_mic"));
        assert!(!source_is_listed(sources, "notetaker_sink"));
    }

    #[test]
    fn monitor_probe_ignores_the_helper_fallback_sink_and_prefers_running() {
        let sources = "2\tnotetaker_sink.monitor\tm\ts16le 2ch 48000Hz\tRUNNING\n3\talsa_output.usb.monitor\tm\ts16le 2ch 48000Hz\tSUSPENDED\n4\talsa_output.pci.monitor\tm\ts16le 2ch 48000Hz\tRUNNING\n5\talsa_input.pci\tm\ts16le 2ch 48000Hz\tRUNNING\n";
        assert_eq!(
            monitor_sources(sources),
            vec!["alsa_output.pci.monitor", "alsa_output.usb.monitor"]
        );
        assert_eq!(
            monitor_source_from_sources(sources),
            Some("alsa_output.pci.monitor".to_string())
        );
    }

    #[test]
    fn speaker_source_prefers_meeting_sink_then_default_sink_then_any_monitor() {
        let sources = "1\tspeakers.monitor\tm\tx\tRUNNING\n2\theadset.monitor\tm\tx\tIDLE\n";
        assert_eq!(
            choose_speaker_source(sources, Some("speakers"), Some("headset")),
            Some("headset.monitor".to_string())
        );
        assert_eq!(
            choose_speaker_source(sources, Some("speakers"), None),
            Some("speakers.monitor".to_string())
        );
        // Meeting sink without a listed monitor falls through to the default.
        assert_eq!(
            choose_speaker_source(sources, Some("headset"), Some("gone")),
            Some("headset.monitor".to_string())
        );
        assert_eq!(
            choose_speaker_source(sources, None, None),
            Some("speakers.monitor".to_string())
        );
        assert_eq!(choose_speaker_source("", Some("x"), None), None);
    }

    const SINK_INPUTS: &str = "Sink Input #52\n\tDriver: PipeWire\n\tClient: 91\n\tSink: 62\n\tCorked: no\n\tProperties:\n\t\tapplication.name = \"Firefox\"\n\t\tapplication.process.binary = \"firefox\"\n\t\tmedia.name = \"AudioStream\"\n\nSink Input #57\n\tDriver: PipeWire\n\tSink: 71\n\tCorked: no\n\tProperties:\n\t\tapplication.name = \"ZOOM VoiceEngine\"\n\t\tapplication.process.binary = \"zoom\"\n\nSink Input #60\n\tSink: 62\n\tCorked: no\n\tProperties:\n\t\tapplication.name = \"Music Player\"\n\nSink Input #61\n\tSink: 62\n\tCorked: no\n\tProperties:\n\t\tapplication.name = \"PipeWire ALSA [notetaker-loopback]\"\n\t\tmedia.name = \"Loopback from notetaker_sink.monitor\"\n";
    const SINKS: &str = "62\talsa_output.speakers\tPipeWire\ts32le 2ch 48000Hz\tRUNNING\n71\talsa_output.headset\tPipeWire\ts16le 2ch 48000Hz\tRUNNING\n";

    #[test]
    fn sink_input_parser_reads_sink_cork_and_properties() {
        let inputs = parse_sink_inputs(SINK_INPUTS);
        assert_eq!(inputs.len(), 4);
        assert_eq!(inputs[1].sink_index, "71");
        assert_eq!(inputs[1].application_name, "ZOOM VoiceEngine");
        assert_eq!(inputs[1].binary, "zoom");
        assert!(!inputs[1].corked);
        assert_eq!(inputs[0].media_name, "AudioStream");
    }

    #[test]
    fn meeting_sink_follows_the_meeting_app_not_the_default() {
        let inputs = parse_sink_inputs(SINK_INPUTS);
        let sinks = parse_short_sinks(SINKS);
        // Zoom (desktop app) on the headset beats Firefox on the speakers.
        assert_eq!(
            pick_meeting_sink(&inputs, &sinks),
            Some("alsa_output.headset".to_string())
        );
    }

    #[test]
    fn meeting_sink_ignores_our_own_loopback_and_unrelated_players() {
        let only_noise = parse_sink_inputs(
            "Sink Input #60\n\tSink: 62\n\tCorked: no\n\tProperties:\n\t\tapplication.name = \"Music Player\"\n\nSink Input #61\n\tSink: 71\n\tCorked: no\n\tProperties:\n\t\tmedia.name = \"Loopback from notetaker_sink.monitor\"\n\t\tapplication.name = \"Zoom notetaker\"\n",
        );
        assert_eq!(
            pick_meeting_sink(&only_noise, &parse_short_sinks(SINKS)),
            None
        );
        assert_eq!(pick_meeting_sink(&[], &parse_short_sinks(SINKS)), None);
    }

    #[test]
    fn meeting_sink_prefers_playing_stream_over_corked_one_of_same_kind() {
        let inputs = parse_sink_inputs(
            "Sink Input #1\n\tSink: 62\n\tCorked: yes\n\tProperties:\n\t\tapplication.name = \"Slack\"\n\nSink Input #2\n\tSink: 71\n\tCorked: no\n\tProperties:\n\t\tapplication.name = \"Microsoft Teams\"\n",
        );
        assert_eq!(
            pick_meeting_sink(&inputs, &parse_short_sinks(SINKS)),
            Some("alsa_output.headset".to_string())
        );
    }

    #[test]
    fn meeting_sink_is_none_when_the_sink_index_is_unknown() {
        let inputs = parse_sink_inputs(
            "Sink Input #1\n\tSink: 999\n\tCorked: no\n\tProperties:\n\t\tapplication.name = \"Zoom\"\n",
        );
        assert_eq!(pick_meeting_sink(&inputs, &parse_short_sinks(SINKS)), None);
    }

    #[test]
    fn debouncer_requires_two_consecutive_sightings_and_resets() {
        let mut debouncer = SourceDebouncer::default();
        assert_eq!(
            debouncer.observe("a.monitor", Some("b.monitor".into())),
            None
        );
        assert_eq!(
            debouncer.observe("a.monitor", Some("b.monitor".into())),
            Some("b.monitor".to_string())
        );
        // A flap back to the current source clears the pending switch.
        assert_eq!(
            debouncer.observe("a.monitor", Some("b.monitor".into())),
            None
        );
        assert_eq!(
            debouncer.observe("a.monitor", Some("a.monitor".into())),
            None
        );
        assert_eq!(
            debouncer.observe("a.monitor", Some("b.monitor".into())),
            None
        );
        assert_eq!(debouncer.observe("a.monitor", None), None);
        assert_eq!(
            debouncer.observe("a.monitor", Some("b.monitor".into())),
            None
        );
    }

    #[test]
    fn module_bookkeeping_parses_ids_and_matches_our_modules_only() {
        assert_eq!(parse_module_id("42\n"), Some("42".to_string()));
        assert_eq!(parse_module_id(""), None);
        assert_eq!(
            parse_module_id("Failure: Module initialization failed"),
            None
        );

        let list = "7\tmodule-null-sink\tsink_name=notetaker_sink sink_properties=device.description=AI\n8\tmodule-loopback\tsource=notetaker_sink.monitor sink=alsa_output\n9\tmodule-null-sink\tsink_name=other\n10\tmodule-loopback\tsource=other.monitor sink=x\n";
        assert_eq!(
            module_ids_with_argument(list, "module-null-sink", "sink_name=notetaker_sink"),
            vec!["7"]
        );
        assert_eq!(
            module_ids_with_argument(list, "module-loopback", "source=notetaker_sink.monitor"),
            vec!["8"]
        );
    }

    #[test]
    fn tracked_module_ids_are_deduplicated() {
        let modules = Mutex::new(Vec::new());
        track_module(&modules, "5\n");
        track_module(&modules, "5\n");
        track_module(&modules, "not-a-number");
        assert_eq!(*modules.lock().unwrap(), vec!["5"]);
    }

    #[test]
    fn parec_spawn_uses_raw_mono_contract() {
        let directory = tempfile::tempdir().expect("temp directory");
        let args_file = directory.path().join("args");
        let script = write_script(
            directory.path(),
            "fake-parec",
            &format!(
                "printf '%s\\n' \"$@\" > '{}'\nprintf '\\001\\002\\003\\004'",
                args_file.display()
            ),
        );

        let mut child =
            spawn_parec_with_source(&script, SINK_MONITOR_NAME).expect("fake parec should spawn");
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
            "-d\nnotetaker_sink.monitor\n--raw\n--format=s16le\n--rate=48000\n--channels=1\n"
        );
    }

    #[test]
    fn parec_bytes_reach_the_frame_channel_unmodified_at_mono() {
        // 2 mono samples arriving split across reads, as a pipe would.
        let mut converter = S16leMonoConverter::new(PAREC_CHANNELS);
        let mut mono = converter.push(&[0x10]);
        mono.extend(converter.push(&[0x00, 0x20, 0x00]));
        assert_eq!(mono, vec![0x10, 0x00, 0x20, 0x00]);
    }

    #[test]
    fn parec_child_that_exits_is_reported_with_status_and_stderr() {
        let directory = tempfile::tempdir().expect("temp directory");
        let script = write_script(
            directory.path(),
            "dying-parec",
            "printf '\\001\\000\\002\\000'\necho 'source vanished' >&2\nexit 3",
        );
        let (tx, rx) = std::sync::mpsc::channel();
        let mut capture = ParecCapture::spawn(&script, "gone.monitor", &tx).expect("spawn");

        let started = Instant::now();
        while !capture.has_ended() {
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "parec exit not noticed"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        let detail = capture.exit_detail();
        assert!(detail.contains("source vanished"), "{detail}");
        assert!(detail.contains('3'), "{detail}");
        capture.shutdown();

        let frame = rx
            .try_recv()
            .expect("bytes written before exit are delivered");
        assert_eq!(frame.channel, AudioChannel::Speaker);
        assert_eq!(frame.sample_rate_hz, PAREC_SAMPLE_RATE_HZ);
        assert_eq!(frame.pcm16, vec![1, 0, 2, 0]);
    }

    #[test]
    fn shutdown_kills_a_long_running_parec_and_joins_the_reader() {
        let directory = tempfile::tempdir().expect("temp directory");
        let script = write_script(directory.path(), "sleepy-parec", "exec sleep 30");
        let (tx, _rx) = std::sync::mpsc::channel();
        let mut capture = ParecCapture::spawn(&script, "any", &tx).expect("spawn");
        assert!(!capture.has_ended());
        let started = Instant::now();
        capture.shutdown();
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "shutdown must not wait for parec"
        );
    }
}
