//! Lifecycle plumbing shared by the three platform backends: the "running"
//! flag, the worker threads that must be joined on stop (so a fast
//! stop-then-start can never leave an old capture alive), the startup
//! handshake, and delivery of frames to the app's callback, with the backlog
//! accounting that keeps a stalled disk from growing memory without a signal.

use crate::health::{CaptureHealthKind, HealthHub};
#[cfg(any(target_os = "linux", target_os = "windows", test))]
use crate::AudioError;
use crate::CapturedFrame;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SendError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
#[cfg(any(target_os = "linux", target_os = "windows", test))]
use std::time::Duration;
#[cfg(any(target_os = "linux", target_os = "windows", test))]
use tokio::sync::oneshot;

pub(crate) type FrameCallback = Box<dyn Fn(CapturedFrame) + Send + Sync>;
#[cfg(any(target_os = "linux", target_os = "windows"))]
pub(crate) type ReadySender = oneshot::Sender<Result<(), String>>;

pub(crate) struct CaptureSession {
    running: Arc<AtomicBool>,
    workers: Mutex<Vec<JoinHandle<()>>>,
}

impl CaptureSession {
    pub(crate) fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            workers: Mutex::new(Vec::new()),
        }
    }

    #[cfg(test)]
    pub(crate) fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// Marks the session running and returns the flag the worker threads poll.
    /// Call before spawning them, so they do not observe a stale `false`.
    #[cfg(any(target_os = "linux", target_os = "windows", test))]
    pub(crate) fn arm(&self) -> Arc<AtomicBool> {
        self.running.store(true, Ordering::SeqCst);
        self.running.clone()
    }

    /// Registers the worker threads that own the capture so `stop` can join
    /// them.
    pub(crate) fn attach(&self, workers: Vec<JoinHandle<()>>) {
        if let Ok(mut guard) = self.workers.lock() {
            guard.extend(workers);
        }
    }

    /// Signals stop and joins every worker. Blocking; call from a blocking
    /// context (or via [`Self::stop`]).
    pub(crate) fn stop_blocking(&self) {
        self.running.store(false, Ordering::SeqCst);
        let handles: Vec<JoinHandle<()>> = self
            .workers
            .lock()
            .map(|mut guard| guard.drain(..).collect())
            .unwrap_or_default();
        for handle in handles {
            if handle.join().is_err() {
                tracing::error!("an audio capture worker panicked");
            }
        }
    }

    /// Async stop: joins on the blocking pool so the async runtime is never
    /// stalled while the capture thread winds down.
    pub(crate) async fn stop(self: &Arc<Self>) {
        let session = self.clone();
        if tokio::task::spawn_blocking(move || session.stop_blocking())
            .await
            .is_err()
        {
            tracing::error!("joining the audio capture workers failed");
        }
    }
}

/// Waits for the capture thread's startup verdict.
#[cfg(any(target_os = "linux", target_os = "windows", test))]
pub(crate) async fn await_ready(
    ready_rx: oneshot::Receiver<Result<(), String>>,
    timeout: Duration,
) -> Result<(), AudioError> {
    match tokio::time::timeout(timeout, ready_rx).await {
        Ok(Ok(Ok(()))) => Ok(()),
        Ok(Ok(Err(error))) => Err(AudioError::StreamError(error)),
        Ok(Err(_)) => Err(AudioError::StreamError(
            "audio startup thread exited unexpectedly".into(),
        )),
        Err(_) => Err(AudioError::StreamError("audio startup timed out".into())),
    }
}

/// Typical live capture rate: two mono PCM16 channels at 48 kHz.
const TYPICAL_BYTES_PER_SECOND: u64 = 2 * 48_000 * 2;
/// Queued-but-unsaved audio that raises a [`CaptureHealthKind::BacklogWarning`]:
/// about 10 s of two-channel 48 kHz audio. Capture continues.
pub(crate) const BACKLOG_WARNING_BYTES: u64 = 10 * TYPICAL_BYTES_PER_SECOND;
/// Queued-but-unsaved audio at which capture stops
/// ([`CaptureHealthKind::BacklogOverflow`]): about 5 minutes of two-channel
/// 48 kHz audio (~58 MB). Past this the disk is not merely slow, and growing
/// memory further only risks losing everything to an out-of-memory kill.
pub(crate) const BACKLOG_CEILING_BYTES: u64 = 300 * TYPICAL_BYTES_PER_SECOND;
/// After a warning, the backlog must drain below this before a
/// [`CaptureHealthKind::BacklogCleared`] is reported (hysteresis, so a disk
/// hovering at the threshold does not flap).
pub(crate) const BACKLOG_CLEARED_BYTES: u64 = BACKLOG_WARNING_BYTES / 4;

const BACKLOG_WARNING_MESSAGE: &str = "Your disk is falling behind; recording continues.";
const BACKLOG_CLEARED_MESSAGE: &str = "Saving has caught up with the recording.";
const BACKLOG_OVERFLOW_MESSAGE: &str = "Recording stopped because your disk could not keep up. \
     Everything captured so far is being saved and can be recovered.";

#[derive(Debug, Clone, Copy)]
struct BacklogLimits {
    warning_bytes: u64,
    cleared_bytes: u64,
    ceiling_bytes: u64,
}

impl Default for BacklogLimits {
    fn default() -> Self {
        Self {
            warning_bytes: BACKLOG_WARNING_BYTES,
            cleared_bytes: BACKLOG_CLEARED_BYTES,
            ceiling_bytes: BACKLOG_CEILING_BYTES,
        }
    }
}

/// Counts frames handed to the delivery thread but not yet returned from the
/// app's callback (i.e. not yet written to disk).
struct FrameBacklog {
    queued_bytes: AtomicU64,
    queued_frames: AtomicU64,
    warned: AtomicBool,
    overflowed: AtomicBool,
    limits: BacklogLimits,
    health: HealthHub,
    /// The capture's running flag: cleared at the ceiling so the backend
    /// winds down on its own, exactly as a user stop would.
    running: Arc<AtomicBool>,
}

impl FrameBacklog {
    /// Producer side. Lock-free except for the one-off health emit at a
    /// threshold crossing, so it is safe on an OS audio callback.
    fn on_queued(&self, queued_bytes: u64, frame: &CapturedFrame) {
        if queued_bytes >= self.limits.ceiling_bytes {
            if !self.overflowed.swap(true, Ordering::SeqCst) {
                // Stop accepting new audio at the source; frames already
                // queued (and the few produced while the workers wind down)
                // are still delivered, never discarded.
                self.running.store(false, Ordering::SeqCst);
                self.health.emit(
                    frame.channel,
                    CaptureHealthKind::BacklogOverflow,
                    BACKLOG_OVERFLOW_MESSAGE,
                );
            }
        } else if queued_bytes >= self.limits.warning_bytes
            && !self.warned.swap(true, Ordering::SeqCst)
        {
            self.health.emit(
                frame.channel,
                CaptureHealthKind::BacklogWarning,
                BACKLOG_WARNING_MESSAGE,
            );
        }
    }

    /// Consumer side: the frame left memory (written, or rejected by the app).
    fn on_delivered(&self, bytes: u64, frame_channel: notetaker_core::providers::AudioChannel) {
        let remaining = self
            .queued_bytes
            .fetch_sub(bytes, Ordering::SeqCst)
            .saturating_sub(bytes);
        self.queued_frames.fetch_sub(1, Ordering::SeqCst);
        if remaining <= self.limits.cleared_bytes
            && !self.overflowed.load(Ordering::SeqCst)
            && self.warned.swap(false, Ordering::SeqCst)
        {
            self.health.emit(
                frame_channel,
                CaptureHealthKind::BacklogCleared,
                BACKLOG_CLEARED_MESSAGE,
            );
        }
    }
}

/// The only way backends hand frames to the app: an unbounded, never-blocking
/// sender that counts what is queued and reports a growing backlog through the
/// capture-health path instead of silently consuming memory.
#[derive(Clone)]
pub(crate) struct FrameSender {
    tx: Sender<CapturedFrame>,
    backlog: Arc<FrameBacklog>,
}

impl FrameSender {
    /// Queues `frame` without blocking. Fails only when the delivery thread is
    /// gone (capture is shutting down), exactly like `mpsc::Sender::send`.
    pub(crate) fn send(&self, frame: CapturedFrame) -> Result<(), SendError<CapturedFrame>> {
        let bytes = frame.pcm16.len() as u64;
        let queued = self
            .backlog
            .queued_bytes
            .fetch_add(bytes, Ordering::SeqCst)
            .saturating_add(bytes);
        self.backlog.queued_frames.fetch_add(1, Ordering::SeqCst);
        self.backlog.on_queued(queued, &frame);
        self.tx.send(frame).inspect_err(|_| {
            self.backlog.queued_bytes.fetch_sub(bytes, Ordering::SeqCst);
            self.backlog.queued_frames.fetch_sub(1, Ordering::SeqCst);
        })
    }
}

/// The delivery thread's end of a [`frame_channel`].
pub(crate) struct FrameReceiver {
    rx: Receiver<CapturedFrame>,
    backlog: Arc<FrameBacklog>,
}

#[cfg(test)]
impl FrameReceiver {
    /// Test helper: pops one frame and accounts it as delivered.
    pub(crate) fn try_recv(&self) -> Result<CapturedFrame, mpsc::TryRecvError> {
        let frame = self.rx.try_recv()?;
        self.backlog
            .on_delivered(frame.pcm16.len() as u64, frame.channel);
        Ok(frame)
    }

    pub(crate) fn queued_bytes(&self) -> u64 {
        self.backlog.queued_bytes.load(Ordering::SeqCst)
    }

    pub(crate) fn queued_frames(&self) -> u64 {
        self.backlog.queued_frames.load(Ordering::SeqCst)
    }
}

/// Creates the counted frame channel shared by every backend. `running` is the
/// capture's running flag, cleared if the backlog reaches its ceiling.
pub(crate) fn frame_channel(
    health: HealthHub,
    running: Arc<AtomicBool>,
) -> (FrameSender, FrameReceiver) {
    frame_channel_with_limits(health, running, BacklogLimits::default())
}

fn frame_channel_with_limits(
    health: HealthHub,
    running: Arc<AtomicBool>,
    limits: BacklogLimits,
) -> (FrameSender, FrameReceiver) {
    let (tx, rx) = mpsc::channel();
    let backlog = Arc::new(FrameBacklog {
        queued_bytes: AtomicU64::new(0),
        queued_frames: AtomicU64::new(0),
        warned: AtomicBool::new(false),
        overflowed: AtomicBool::new(false),
        limits,
        health,
        running,
    });
    (
        FrameSender {
            tx,
            backlog: backlog.clone(),
        },
        FrameReceiver { rx, backlog },
    )
}

/// Spawns the thread that hands captured frames to the app callback.
///
/// The callback runs with the caller's tokio runtime entered, because the app's
/// callback uses `tokio::spawn`. The thread ends when every sender is dropped,
/// i.e. after the capture workers have exited, so joining it on stop also
/// guarantees frames already captured are delivered before `stop_capture`
/// returns. A frame counts against the backlog until the callback (which
/// writes it to disk) returns.
pub(crate) fn spawn_frame_delivery(rx: FrameReceiver, on_frame: FrameCallback) -> JoinHandle<()> {
    let runtime = tokio::runtime::Handle::try_current().ok();
    std::thread::spawn(move || {
        let _guard = runtime.as_ref().map(|handle| handle.enter());
        while let Ok(frame) = rx.rx.recv() {
            let bytes = frame.pcm16.len() as u64;
            let channel = frame.channel;
            on_frame(frame);
            rx.backlog.on_delivered(bytes, channel);
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::health::CaptureHealthEvent;
    use notetaker_core::providers::AudioChannel;

    #[test]
    fn stop_joins_workers_before_returning() {
        let session = CaptureSession::new();
        let running = session.arm();
        let finished = Arc::new(AtomicBool::new(false));
        let worker_finished = finished.clone();
        let worker = std::thread::spawn(move || {
            while running.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(5));
            }
            std::thread::sleep(Duration::from_millis(50));
            worker_finished.store(true, Ordering::SeqCst);
        });
        session.attach(vec![worker]);
        assert!(session.is_running());
        session.stop_blocking();
        assert!(!session.is_running());
        assert!(
            finished.load(Ordering::SeqCst),
            "stop must wait for the worker to finish so a restart cannot overlap"
        );
    }

    #[test]
    fn stop_without_workers_is_a_no_op() {
        let session = CaptureSession::new();
        session.stop_blocking();
        assert!(!session.is_running());
    }

    #[tokio::test]
    async fn async_stop_joins_workers() {
        let session = Arc::new(CaptureSession::new());
        let running = session.arm();
        let finished = Arc::new(AtomicBool::new(false));
        let worker_finished = finished.clone();
        session.attach(vec![std::thread::spawn(move || {
            while running.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(5));
            }
            worker_finished.store(true, Ordering::SeqCst);
        })]);
        session.stop().await;
        assert!(finished.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn delivery_runs_inside_the_runtime_and_drains_before_exit() {
        let (tx, rx) = frame_channel(HealthHub::new(), Arc::new(AtomicBool::new(true)));
        let delivered = Arc::new(Mutex::new(Vec::new()));
        let sink = delivered.clone();
        let handle = spawn_frame_delivery(
            rx,
            Box::new(move |frame| {
                // The real app callback uses tokio::spawn; it must not panic.
                let spawned = tokio::spawn(async {});
                drop(spawned);
                sink.lock().unwrap().push(frame.pcm16.len());
            }),
        );
        for len in [2_usize, 4, 6] {
            tx.send(CapturedFrame {
                channel: AudioChannel::Mic,
                pcm16: vec![0; len],
                sample_rate_hz: 16_000,
            })
            .unwrap();
        }
        drop(tx);
        tokio::task::spawn_blocking(move || handle.join().unwrap())
            .await
            .unwrap();
        assert_eq!(*delivered.lock().unwrap(), vec![2, 4, 6]);
    }

    #[tokio::test]
    async fn startup_verdicts_map_to_errors() {
        let (tx, rx) = oneshot::channel();
        tx.send(Ok(())).unwrap();
        assert!(await_ready(rx, Duration::from_millis(100)).await.is_ok());

        let (tx, rx) = oneshot::channel();
        tx.send(Err("no mic".to_string())).unwrap();
        assert!(matches!(
            await_ready(rx, Duration::from_millis(100)).await,
            Err(AudioError::StreamError(message)) if message == "no mic"
        ));

        let (tx, rx) = oneshot::channel::<Result<(), String>>();
        drop(tx);
        assert!(await_ready(rx, Duration::from_millis(100)).await.is_err());

        let (_tx, rx) = oneshot::channel::<Result<(), String>>();
        assert!(await_ready(rx, Duration::from_millis(20)).await.is_err());
    }

    fn frame(len: usize) -> CapturedFrame {
        CapturedFrame {
            channel: AudioChannel::Speaker,
            pcm16: vec![0; len],
            sample_rate_hz: 48_000,
        }
    }

    fn drain_kinds(
        rx: &mut tokio::sync::broadcast::Receiver<CaptureHealthEvent>,
    ) -> Vec<CaptureHealthKind> {
        std::iter::from_fn(|| rx.try_recv().ok())
            .map(|event| event.kind)
            .collect()
    }

    const TEST_LIMITS: BacklogLimits = BacklogLimits {
        warning_bytes: 100,
        cleared_bytes: 25,
        ceiling_bytes: 1_000,
    };

    #[test]
    fn default_thresholds_match_the_documented_audio_durations() {
        assert_eq!(BACKLOG_WARNING_BYTES, 1_920_000);
        assert_eq!(BACKLOG_CEILING_BYTES, 57_600_000);
        let limits = BacklogLimits::default();
        assert!(limits.cleared_bytes < limits.warning_bytes);
        assert!(limits.warning_bytes < limits.ceiling_bytes);
    }

    #[test]
    fn backlog_counts_queued_bytes_and_frames_until_delivered() {
        let health = HealthHub::new();
        let (tx, rx) =
            frame_channel_with_limits(health, Arc::new(AtomicBool::new(true)), TEST_LIMITS);
        tx.send(frame(10)).unwrap();
        tx.send(frame(20)).unwrap();
        assert_eq!(rx.queued_bytes(), 30);
        assert_eq!(rx.queued_frames(), 2);
        rx.try_recv().unwrap();
        assert_eq!(rx.queued_bytes(), 20);
        assert_eq!(rx.queued_frames(), 1);
    }

    #[test]
    fn a_growing_backlog_warns_once_then_clears_with_hysteresis() {
        let health = HealthHub::new();
        let mut events = health.subscribe();
        let running = Arc::new(AtomicBool::new(true));
        let (tx, rx) = frame_channel_with_limits(health, running.clone(), TEST_LIMITS);
        for _ in 0..6 {
            tx.send(frame(20)).unwrap();
        }
        assert_eq!(
            drain_kinds(&mut events),
            vec![CaptureHealthKind::BacklogWarning]
        );
        assert!(
            running.load(Ordering::SeqCst),
            "a warning never stops capture"
        );
        // 120 -> 40 bytes: below the warning but not yet below the clear mark.
        for _ in 0..4 {
            rx.try_recv().unwrap();
        }
        assert!(drain_kinds(&mut events).is_empty());
        rx.try_recv().unwrap();
        assert_eq!(
            drain_kinds(&mut events),
            vec![CaptureHealthKind::BacklogCleared]
        );
        // A second stall warns again.
        for _ in 0..5 {
            tx.send(frame(20)).unwrap();
        }
        assert_eq!(
            drain_kinds(&mut events),
            vec![CaptureHealthKind::BacklogWarning]
        );
    }

    #[test]
    fn the_ceiling_stops_capture_but_never_discards_queued_audio() {
        let health = HealthHub::new();
        let mut events = health.subscribe();
        let running = Arc::new(AtomicBool::new(true));
        let (tx, rx) = frame_channel_with_limits(health, running.clone(), TEST_LIMITS);
        for _ in 0..12 {
            tx.send(frame(100)).unwrap();
        }
        assert!(
            !running.load(Ordering::SeqCst),
            "the ceiling must stop capture"
        );
        let kinds = drain_kinds(&mut events);
        assert_eq!(
            kinds,
            vec![
                CaptureHealthKind::BacklogWarning,
                CaptureHealthKind::BacklogOverflow
            ]
        );
        assert!(kinds[1].is_fatal());
        // Every frame, including those sent after the ceiling while the
        // workers wind down, is still delivered.
        drop(tx);
        let mut delivered = 0;
        while rx.try_recv().is_ok() {
            delivered += 1;
        }
        assert_eq!(delivered, 12);
        assert_eq!(rx.queued_bytes(), 0);
        // Draining after an overflow does not report a misleading recovery.
        assert!(drain_kinds(&mut events).is_empty());
    }

    #[test]
    fn a_send_after_the_receiver_is_gone_is_not_counted() {
        let (tx, rx) = frame_channel(HealthHub::new(), Arc::new(AtomicBool::new(true)));
        let backlog = rx.backlog.clone();
        drop(rx);
        assert!(tx.send(frame(10)).is_err());
        assert_eq!(backlog.queued_bytes.load(Ordering::SeqCst), 0);
        assert_eq!(backlog.queued_frames.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn delivery_releases_the_backlog_only_after_the_callback_returns() {
        let (tx, rx) = frame_channel(HealthHub::new(), Arc::new(AtomicBool::new(true)));
        let backlog = rx.backlog.clone();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let observed = backlog.clone();
        let handle = spawn_frame_delivery(
            rx,
            Box::new(move |frame| {
                // While the "disk write" runs, the frame is still queued.
                sink.lock()
                    .unwrap()
                    .push(observed.queued_bytes.load(Ordering::SeqCst) >= frame.pcm16.len() as u64);
            }),
        );
        tx.send(frame(8)).unwrap();
        tx.send(frame(8)).unwrap();
        drop(tx);
        tokio::task::spawn_blocking(move || handle.join().unwrap())
            .await
            .unwrap();
        assert_eq!(*seen.lock().unwrap(), vec![true, true]);
        assert_eq!(backlog.queued_bytes.load(Ordering::SeqCst), 0);
    }
}
