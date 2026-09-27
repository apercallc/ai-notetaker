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

use crate::convert::interleaved_f32_to_mono_pcm16;
use crate::device_matching::{find_matching_device, WINDOWS_DEVICE_HINT};
use crate::health::{Backoff, CaptureHealthKind, HealthHub};
use crate::input::{default_input_name, list_input_devices, InputSupervisor};
use crate::session::{
    await_ready, spawn_frame_delivery, CaptureSession, FrameCallback, ReadySender,
};
use crate::timeline::SilenceFiller;
use crate::{
    capture_ready, AudioCapture, AudioDeviceInfo, AudioDeviceList, AudioDiagnostics, AudioError,
    CaptureHealthEvent, CaptureOptions, CapturedFrame, DriverStatus, PermissionState,
};
use async_trait::async_trait;
use cpal::traits::{DeviceTrait, HostTrait};
use notetaker_core::providers::AudioChannel;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, oneshot};

const WASAPI_SAMPLE_RATE_HZ: u32 = 48_000;
const WASAPI_CHANNELS: u16 = 2;
const WASAPI_BUFFER_DURATION_HNS: i64 = 200_000;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(3);
const DEFAULT_ENDPOINT_POLL: Duration = Duration::from_secs(2);
/// WASAPI is polled at this cadence; between packets the loop also tops up
/// silence and services the microphone supervisor.
const LOOPBACK_POLL: Duration = Duration::from_millis(5);
/// A loopback attempt that stayed up at least this long resets the restart
/// backoff: it proved the route works, so the next failure is new.
const RESTART_STABLE_UPTIME: Duration = Duration::from_secs(5);
/// `RPC_E_CHANGED_MODE`: COM is already initialized on this thread in a
/// different apartment (cpal initializes STA). The call is usable through
/// marshalling and took no reference, so no `CoUninitialize` is owed.
const RPC_E_CHANGED_MODE: i32 = -2147417850; // 0x80010106

/// The exact VB-CABLE download this project is licensed to bundle. The base
/// package only — VB-Audio's terms explicitly exclude the A+B/C+D variants
/// from bundling permission, so this URL must never be swapped for one of
/// those without re-checking the license terms.
pub const VB_CABLE_DOWNLOAD_URL: &str =
    "https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip";
pub const VB_CABLE_ATTRIBUTION_TEXT: &str = "Virtual audio cable by VB-Audio Software (vb-cable.com) — donationware, please consider supporting them.";
const BUNDLED_DRIVER_RELATIVE_PATH: &str = "resources/windows/vb-cable/VBCABLE_Setup_x64.exe";

pub struct WindowsAudioCapture {
    session: Arc<CaptureSession>,
    health: HealthHub,
}

impl WindowsAudioCapture {
    pub fn new() -> Self {
        Self {
            session: Arc::new(CaptureSession::new()),
            health: HealthHub::new(),
        }
    }

    fn installed_device_name(&self) -> Option<String> {
        installed_cable_name()
    }

    /// Read-only probe of the native loopback path (no prompt, no install).
    fn native_loopback_device_name(&self) -> Option<String> {
        probe_wasapi_loopback().ok()
    }

    /// Installs the release-bundled base VB-CABLE package when it is absent.
    /// The release installer UI must display `VB_CABLE_ATTRIBUTION_TEXT` and a
    /// link to vb-cable.com; this crate owns only the device check and launch.
    pub async fn install_if_missing(&self) -> Result<(), AudioError> {
        tokio::task::spawn_blocking(install_bundled_driver)
            .await
            .map_err(|error| AudioError::DriverSetup(format!("installer task failed: {error}")))?
    }
}

impl Default for WindowsAudioCapture {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for WindowsAudioCapture {
    fn drop(&mut self) {
        self.session.stop_blocking();
    }
}

fn install_bundled_driver() -> Result<(), AudioError> {
    if installed_cable_name().is_some() {
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
        if installed_cable_name().is_some() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_secs(1));
    }

    Err(AudioError::DriverSetup(
        "VB-CABLE was installed but Windows has not exposed the device yet; reboot Windows if requested, then check audio again".into(),
    ))
}

fn installed_cable_name() -> Option<String> {
    let host = cpal::default_host();
    let names: Vec<String> = host
        .input_devices()
        .map(|it| it.filter_map(|d| d.name().ok()).collect())
        .unwrap_or_default();
    find_matching_device(&names, WINDOWS_DEVICE_HINT).map(String::from)
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

#[async_trait]
impl AudioCapture for WindowsAudioCapture {
    fn driver_status(&self) -> DriverStatus {
        if self.native_loopback_device_name().is_some() || self.installed_device_name().is_some() {
            DriverStatus::Installed
        } else {
            DriverStatus::NotInstalled {
                install_guidance: format!(
                    "Windows WASAPI loopback is unavailable and VB-CABLE is not installed. Install the base VB-CABLE package from {VB_CABLE_DOWNLOAD_URL} (or use the helper's setup step), then return here and check again."
                ),
            }
        }
    }

    fn diagnostics(&self) -> AudioDiagnostics {
        let native_speaker = self.native_loopback_device_name();
        let fallback_speaker = self.installed_device_name();
        let fallback_available = fallback_speaker.is_some();
        let native_loopback = native_speaker.is_some();
        let speaker = native_speaker.or(fallback_speaker);
        let microphone = default_input_name();
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
            microphone_permission: PermissionState::NotApplicable,
            screen_permission: PermissionState::NotApplicable,
        }
    }

    /// Explicit, user-initiated setup: installs the bundled base VB-CABLE
    /// package only when neither native loopback nor an existing CABLE works.
    /// Passive preflight (`prepare`/`diagnostics`) never reaches this.
    fn setup(&self) -> Result<(), AudioError> {
        if self.native_loopback_device_name().is_some() || self.installed_device_name().is_some() {
            return Ok(());
        }
        install_bundled_driver()
    }

    fn subscribe_health(&self) -> broadcast::Receiver<CaptureHealthEvent> {
        self.health.subscribe()
    }

    fn list_devices(&self) -> AudioDeviceList {
        let mut speakers = wasapi_render_endpoint_names()
            .into_iter()
            .map(|name| AudioDeviceInfo {
                id: name.clone(),
                name,
                is_default: false,
            })
            .collect::<Vec<_>>();
        if let Some(default) = default_render_endpoint_name() {
            for speaker in &mut speakers {
                speaker.is_default = speaker.name == default;
            }
        }
        // VB-CABLE Output shows up as a recording device; expose it as a
        // selectable speaker route too when it is installed.
        if let Some(cable) = installed_cable_name() {
            if !speakers.iter().any(|speaker| speaker.name == cable) {
                speakers.push(AudioDeviceInfo {
                    id: cable.clone(),
                    name: cable,
                    is_default: false,
                });
            }
        }
        AudioDeviceList {
            microphones: list_input_devices(),
            speakers,
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
        // A previous capture must be fully gone (threads joined, loopback
        // client released) before a new one may start.
        self.session.stop().await;

        let (tx, rx) = std::sync::mpsc::channel::<CapturedFrame>();
        let (ready_tx, ready_rx) = oneshot::channel::<Result<(), String>>();
        let running = self.session.arm();
        let health = self.health.clone();

        let supervisor = std::thread::spawn(move || {
            run_capture(options, tx, running, health, ready_tx);
        });
        let delivery = spawn_frame_delivery(rx, on_frame);
        self.session.attach(vec![supervisor, delivery]);

        if let Err(error) = await_ready(ready_rx, STARTUP_TIMEOUT).await {
            self.session.stop().await;
            return Err(error);
        }
        Ok(())
    }

    async fn stop_capture(&self) -> Result<(), AudioError> {
        self.session.stop().await;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// WASAPI plumbing
// ---------------------------------------------------------------------------

/// Runs `operation` on a fresh thread with COM initialized for it. Used by the
/// read-only probes: the calling thread may already run another apartment.
fn wasapi_operation_on_thread<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    std::thread::spawn(move || {
        if let Err(error) = initialize_com_for_wasapi() {
            return Err(format!("could not initialize Windows audio COM: {error}"));
        }
        let result = operation();
        wasapi::deinitialize();
        result
    })
    .join()
    .map_err(|_| "WASAPI probe thread panicked".to_string())?
}

/// Checks the actual shared-mode loopback initialization path. Merely having
/// a default output endpoint is not enough: WASAPI loopback is a capture client
/// initialized against a render endpoint with the loopback stream flag.
fn probe_wasapi_loopback() -> Result<String, String> {
    wasapi_operation_on_thread(|| {
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
    })
}

/// Friendly names of every active render endpoint (read-only; active devices
/// only, because the collection is enumerated with `DEVICE_STATE_ACTIVE`).
fn wasapi_render_endpoint_names() -> Vec<String> {
    wasapi_operation_on_thread(|| {
        let enumerator = wasapi::DeviceEnumerator::new().map_err(|error| error.to_string())?;
        let collection = enumerator
            .get_device_collection(&wasapi::Direction::Render)
            .map_err(|error| error.to_string())?;
        Ok(collection
            .into_iter()
            .filter_map(|device| device.ok())
            .filter_map(|device| device.get_friendlyname().ok())
            .collect())
    })
    .unwrap_or_default()
}

fn default_render_endpoint_name() -> Option<String> {
    wasapi_operation_on_thread(|| {
        let enumerator = wasapi::DeviceEnumerator::new().map_err(|error| error.to_string())?;
        let device = enumerator
            .get_default_device(&wasapi::Direction::Render)
            .map_err(|error| error.to_string())?;
        device.get_friendlyname().map_err(|error| error.to_string())
    })
    .ok()
}

/// Initializes COM for WASAPI use on the current thread. Returns `true` when a
/// reference was taken (a matching `CoUninitialize` is owed), `false` when the
/// thread already runs a different apartment (cpal initializes STA on threads
/// it enumerates devices from) — in that case COM is usable through
/// marshalling and no reference was taken.
fn initialize_com_for_wasapi() -> Result<bool, String> {
    let hr = wasapi::initialize_mta();
    if hr.is_ok() {
        return Ok(true);
    }
    if hr.0 == RPC_E_CHANGED_MODE {
        return Ok(false);
    }
    Err(format!(
        "Windows audio COM initialization failed: {:#010X}",
        hr.0
    ))
}

// ---------------------------------------------------------------------------
// Capture supervisor
// ---------------------------------------------------------------------------

/// Which speaker route a recording uses, resolved once at startup.
enum SpeakerPlan {
    /// Native WASAPI output loopback; `Some(name)` pins the endpoint, `None`
    /// follows the system default output when it changes.
    WasapiLoopback(Option<String>),
    /// VB-CABLE Output capture through cpal (always pinned by name).
    CableInput(String),
}

fn resolve_speaker_plan(
    requested: Option<&str>,
    health: &HealthHub,
) -> Result<SpeakerPlan, String> {
    if let Some(id) = requested {
        if wasapi_render_endpoint_names().iter().any(|name| name == id) {
            return Ok(SpeakerPlan::WasapiLoopback(Some(id.to_string())));
        }
        if cpal_input_exists(id) {
            return Ok(SpeakerPlan::CableInput(id.to_string()));
        }
        // Unknown id: keep the recording alive rather than fail it — fall
        // back to the automatic route and say so on the health channel.
        health.emit(
            AudioChannel::Speaker,
            CaptureHealthKind::StreamError,
            format!("requested speaker device \"{id}\" was not found; using the default output"),
        );
    }
    if probe_wasapi_loopback().is_ok() {
        Ok(SpeakerPlan::WasapiLoopback(None))
    } else if let Some(cable) = installed_cable_name() {
        Ok(SpeakerPlan::CableInput(cable))
    } else {
        Err(format!(
            "Windows WASAPI loopback is unavailable and VB-CABLE is not installed. Run the helper's audio setup, or install the base VB-CABLE package from {VB_CABLE_DOWNLOAD_URL}, and try again."
        ))
    }
}

fn cpal_input_exists(name: &str) -> bool {
    cpal::default_host()
        .input_devices()
        .map(|mut devices| devices.any(|d| d.name().ok().as_deref() == Some(name)))
        .unwrap_or(false)
}

/// Owns the whole capture on one thread: the microphone supervisor, and either
/// the WASAPI loopback (with restart/backoff and silence synthesis) or the
/// VB-CABLE fallback. Returns when `running` clears or the route is
/// unusable; `ready_tx` carries the startup verdict.
fn run_capture(
    options: CaptureOptions,
    tx: Sender<CapturedFrame>,
    running: Arc<AtomicBool>,
    health: HealthHub,
    ready_tx: ReadySender,
) {
    // The microphone's first open must succeed: recording without the user's
    // voice is a start failure, not a degradation.
    let mut mic = match InputSupervisor::start(
        AudioChannel::Mic,
        options.mic_device.clone(),
        tx.clone(),
        health.clone(),
    ) {
        Ok(mic) => mic,
        Err(error) => {
            let _ = ready_tx.send(Err(error.to_string()));
            return;
        }
    };

    let plan = match resolve_speaker_plan(options.speaker_device.as_deref(), &health) {
        Ok(plan) => plan,
        Err(message) => {
            let _ = ready_tx.send(Err(message));
            return;
        }
    };

    match plan {
        SpeakerPlan::WasapiLoopback(pinned) => {
            run_wasapi_loopback(pinned, &tx, &running, &health, ready_tx, &mut mic);
        }
        SpeakerPlan::CableInput(name) => {
            let mut speaker =
                match InputSupervisor::start(AudioChannel::Speaker, Some(name), tx, health) {
                    Ok(speaker) => speaker,
                    Err(error) => {
                        let _ = ready_tx.send(Err(error.to_string()));
                        return;
                    }
                };
            let _ = ready_tx.send(Ok(()));
            while running.load(Ordering::SeqCst) {
                mic.tick();
                speaker.tick();
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }
}

/// Why one loopback attempt ended.
enum AttemptOutcome {
    /// The session's running flag cleared; stop cleanly.
    Stopped,
    /// The stream failed (endpoint invalidated, read error, ...). Restart
    /// with backoff.
    Failed(String),
    /// The system default render endpoint changed and capture follows it.
    DefaultChanged(String),
}

fn run_wasapi_loopback(
    pinned: Option<String>,
    tx: &Sender<CapturedFrame>,
    running: &Arc<AtomicBool>,
    health: &HealthHub,
    ready_tx: ReadySender,
    mic: &mut InputSupervisor,
) {
    let mut ready = Some(ready_tx);
    let mut backoff = Backoff::default();
    let mut retry_at: Option<Instant> = None;
    let mut first_attempt = true;

    while running.load(Ordering::SeqCst) {
        if let Some(due) = retry_at {
            if Instant::now() < due {
                mic.tick();
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            retry_at = None;
        }

        let started_at = Instant::now();
        let announce_restart = !first_attempt;
        let outcome = run_wasapi_attempt(
            pinned.as_deref(),
            tx,
            running,
            health,
            ready.take(),
            announce_restart,
            mic,
        );
        first_attempt = false;

        match outcome {
            AttemptOutcome::Stopped => break,
            AttemptOutcome::DefaultChanged(name) => {
                health.emit(
                    AudioChannel::Speaker,
                    CaptureHealthKind::DeviceChanged,
                    format!("default output device changed to {name}; following it"),
                );
                backoff.reset();
            }
            AttemptOutcome::Failed(message) => {
                // An invalidated endpoint (default device switch, USB unplug)
                // surfaces here as a read/initialize failure; re-resolving the
                // default endpoint on the next attempt is the recovery.
                health.emit(
                    AudioChannel::Speaker,
                    CaptureHealthKind::SourceEnded,
                    message,
                );
                if started_at.elapsed() >= RESTART_STABLE_UPTIME {
                    backoff.reset();
                }
                retry_at = Some(Instant::now() + backoff.next_delay());
            }
        }
    }
}

/// One WASAPI loopback session: open the render endpoint, initialize the
/// loopback capture client, then poll packets until the session stops, the
/// stream fails, or (unpinned) the default endpoint changes.
fn run_wasapi_attempt(
    pinned: Option<&str>,
    tx: &Sender<CapturedFrame>,
    running: &Arc<AtomicBool>,
    health: &HealthHub,
    ready: Option<ReadySender>,
    announce_restart: bool,
    mic: &mut InputSupervisor,
) -> AttemptOutcome {
    let Ok(owns_com_reference) = initialize_com_for_wasapi() else {
        return AttemptOutcome::Failed("could not initialize Windows audio COM".into());
    };

    let outcome = wasapi_loopback_body(pinned, tx, running, health, ready, announce_restart, mic);

    if owns_com_reference {
        wasapi::deinitialize();
    }
    outcome
}

fn wasapi_loopback_body(
    pinned: Option<&str>,
    tx: &Sender<CapturedFrame>,
    running: &Arc<AtomicBool>,
    health: &HealthHub,
    ready: Option<ReadySender>,
    announce_restart: bool,
    mic: &mut InputSupervisor,
) -> AttemptOutcome {
    let enumerator = match wasapi::DeviceEnumerator::new() {
        Ok(enumerator) => enumerator,
        Err(error) => return AttemptOutcome::Failed(error.to_string()),
    };
    let device = match pinned {
        Some(name) => match enumerator.get_device_with_name(name) {
            Ok(device) => device,
            Err(error) => return AttemptOutcome::Failed(error.to_string()),
        },
        None => match enumerator.get_default_device(&wasapi::Direction::Render) {
            Ok(device) => device,
            Err(error) => return AttemptOutcome::Failed(error.to_string()),
        },
    };
    let opened_name = device.get_friendlyname().ok();

    let mut audio_client = match device.get_iaudioclient() {
        Ok(client) => client,
        Err(error) => return AttemptOutcome::Failed(error.to_string()),
    };
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
    if let Err(error) = audio_client.initialize_client(&format, &wasapi::Direction::Capture, &mode)
    {
        return AttemptOutcome::Failed(error.to_string());
    }
    let capture_client = match audio_client.get_audiocaptureclient() {
        Ok(client) => client,
        Err(error) => return AttemptOutcome::Failed(error.to_string()),
    };
    if let Err(error) = audio_client.start_stream() {
        return AttemptOutcome::Failed(error.to_string());
    }

    if announce_restart {
        health.emit(
            AudioChannel::Speaker,
            CaptureHealthKind::Restarted,
            "output loopback capture re-established",
        );
    }
    if let Some(sender) = ready {
        if sender.send(Ok(())).is_err() {
            // The caller stopped waiting; the running flag will clear.
            let _ = audio_client.stop_stream();
            return AttemptOutcome::Stopped;
        }
    }

    let bytes_per_frame = format.get_blockalign() as usize;
    // WASAPI loopback delivers nothing while the output is silent, unlike the
    // microphone. Synthesize zero-filled PCM by wall clock so the speaker
    // timeline never runs shorter than the mic's.
    let mut filler = SilenceFiller::new(WASAPI_SAMPLE_RATE_HZ, Instant::now());
    let mut next_default_check = Instant::now() + DEFAULT_ENDPOINT_POLL;
    let mut outcome = AttemptOutcome::Stopped;

    'poll: loop {
        mic.tick();

        if !running.load(Ordering::SeqCst) {
            break 'poll;
        }

        // Follow the system default output (only when not pinned to a device).
        if pinned.is_none() && Instant::now() >= next_default_check {
            next_default_check = Instant::now() + DEFAULT_ENDPOINT_POLL;
            if let Some(current) = default_render_endpoint_name_on_thread(&enumerator) {
                if opened_name.as_deref() != Some(current.as_str()) {
                    outcome = AttemptOutcome::DefaultChanged(current);
                    break 'poll;
                }
            }
        }

        if let Some(silence) = filler.silence_due(Instant::now()) {
            let _ = tx.send(CapturedFrame {
                channel: AudioChannel::Speaker,
                pcm16: silence,
                sample_rate_hz: WASAPI_SAMPLE_RATE_HZ,
            });
        }

        let packet_frames = match capture_client.get_next_packet_size() {
            Ok(frames) => frames.unwrap_or_default(),
            Err(error) => {
                outcome = AttemptOutcome::Failed(error.to_string());
                break 'poll;
            }
        };
        if packet_frames == 0 {
            std::thread::sleep(LOOPBACK_POLL);
            continue;
        }

        let mut raw = vec![0_u8; packet_frames as usize * bytes_per_frame];
        let (frames_read, buffer_info) = match capture_client.read_from_device(&mut raw) {
            Ok(result) => result,
            Err(error) => {
                outcome = AttemptOutcome::Failed(error.to_string());
                break 'poll;
            }
        };
        if frames_read == 0 {
            std::thread::sleep(LOOPBACK_POLL);
            continue;
        }
        raw.truncate(frames_read as usize * bytes_per_frame);
        let pcm16 = if buffer_info.flags.silent {
            vec![0_u8; frames_read as usize * std::mem::size_of::<i16>()]
        } else {
            interleaved_f32_to_mono_pcm16(&raw, WASAPI_CHANNELS as usize)
        };
        if !pcm16.is_empty() {
            filler.note_real_frames(frames_read as u64);
            let _ = tx.send(CapturedFrame {
                channel: AudioChannel::Speaker,
                pcm16,
                sample_rate_hz: WASAPI_SAMPLE_RATE_HZ,
            });
        }
    }

    let _ = audio_client.stop_stream();
    outcome
}

/// Default-endpoint check inside the polling loop, without spawning a thread:
/// COM is already initialized on this thread and the enumerator is live.
fn default_render_endpoint_name_on_thread(enumerator: &wasapi::DeviceEnumerator) -> Option<String> {
    enumerator
        .get_default_device(&wasapi::Direction::Render)
        .and_then(|device| device.get_friendlyname())
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn changed_mode_com_means_no_reference_owed() {
        // A failed init with any other code is an error; RPC_E_CHANGED_MODE
        // specifically means "usable, no CoUninitialize owed".
        assert_eq!(RPC_E_CHANGED_MODE, -2147417850);
    }

    #[test]
    fn bundled_installer_path_never_reaches_into_the_archive_root() {
        let relative = PathBuf::from(BUNDLED_DRIVER_RELATIVE_PATH);
        assert!(relative.ends_with("VBCABLE_Setup_x64.exe"));
    }
}
