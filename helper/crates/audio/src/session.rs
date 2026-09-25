//! Lifecycle plumbing shared by the three platform backends: the "running"
//! flag, the worker threads that must be joined on stop (so a fast
//! stop-then-start can never leave an old capture alive), the startup
//! handshake, and delivery of frames to the app's callback.

use crate::{AudioError, CapturedFrame};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;
use tokio::sync::oneshot;

pub(crate) type FrameCallback = Box<dyn Fn(CapturedFrame) + Send + Sync>;
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

/// Spawns the thread that hands captured frames to the app callback.
///
/// The callback runs with the caller's tokio runtime entered, because the app's
/// callback uses `tokio::spawn`. The thread ends when every sender is dropped,
/// i.e. after the capture workers have exited, so joining it on stop also
/// guarantees frames already captured are delivered before `stop_capture`
/// returns.
pub(crate) fn spawn_frame_delivery(
    rx: Receiver<CapturedFrame>,
    on_frame: FrameCallback,
) -> JoinHandle<()> {
    let runtime = tokio::runtime::Handle::try_current().ok();
    std::thread::spawn(move || {
        let _guard = runtime.as_ref().map(|handle| handle.enter());
        while let Ok(frame) = rx.recv() {
            on_frame(frame);
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use notetaker_core::providers::AudioChannel;
    use std::sync::mpsc;

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
        let (tx, rx) = mpsc::channel();
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
}
