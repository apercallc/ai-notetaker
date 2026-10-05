use notetaker_audio::{AudioCapture, AudioDiagnostics, PermissionState};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const CACHE_TTL: Duration = Duration::from_secs(10);
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioDiagnosticsSnapshot {
    pub diagnostics: AudioDiagnostics,
    pub checking: bool,
    pub timed_out: bool,
}

#[derive(Clone, Default)]
pub struct AudioDiagnosticsCoordinator {
    state: Arc<Mutex<ProbeState>>,
}

#[derive(Default)]
struct ProbeState {
    in_flight: bool,
    timed_out: bool,
    generation: u64,
    cached: Option<(Instant, AudioDiagnostics)>,
}

impl AudioDiagnosticsCoordinator {
    pub fn invalidate(&self) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.generation = state.generation.wrapping_add(1);
        state.cached = None;
    }

    pub async fn get(&self, audio: Arc<dyn AudioCapture>) -> AudioDiagnosticsSnapshot {
        self.get_with_probe(PROBE_TIMEOUT, move || audio.diagnostics())
            .await
    }

    async fn get_with_probe<F>(&self, timeout: Duration, probe: F) -> AudioDiagnosticsSnapshot
    where
        F: FnOnce() -> AudioDiagnostics + Send + 'static,
    {
        let generation = {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            if let Some((completed_at, diagnostics)) = &state.cached {
                if completed_at.elapsed() < CACHE_TTL {
                    return Self::completed(diagnostics.clone());
                }
            }
            if state.in_flight {
                return Self::pending_diagnostics(true, state.timed_out);
            }
            state.in_flight = true;
            state.timed_out = false;
            state.generation
        };

        let shared_state = self.state.clone();
        let mut task = tokio::task::spawn_blocking(move || {
            let reset = ProbeReset(shared_state.clone());
            let diagnostics = probe();
            let mut state = shared_state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if state.generation == generation {
                state.cached = Some((Instant::now(), diagnostics.clone()));
            }
            drop(state);
            drop(reset);
            diagnostics
        });

        match tokio::time::timeout(timeout, &mut task).await {
            Ok(Ok(diagnostics)) => Self::completed(diagnostics),
            Ok(Err(_)) => {
                let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
                state.in_flight = false;
                state.timed_out = false;
                Self::cached_or_pending(&state)
            }
            Err(_) => {
                // Dropping this JoinHandle detaches the single blocking probe.
                // `in_flight` stays set until that native API call returns, so a
                // stuck CoreAudio/WASAPI call cannot create a thread per refresh.
                let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
                state.timed_out = true;
                Self::cached_or_pending(&state)
            }
        }
    }

    fn cached_or_pending(state: &ProbeState) -> AudioDiagnosticsSnapshot {
        match state
            .cached
            .as_ref()
            .filter(|(completed_at, _)| completed_at.elapsed() < CACHE_TTL)
        {
            Some((_, diagnostics)) => Self::completed(diagnostics.clone()),
            None => Self::pending_diagnostics(state.in_flight, state.timed_out),
        }
    }

    fn completed(diagnostics: AudioDiagnostics) -> AudioDiagnosticsSnapshot {
        AudioDiagnosticsSnapshot {
            diagnostics,
            checking: false,
            timed_out: false,
        }
    }

    fn pending_diagnostics(checking: bool, timed_out: bool) -> AudioDiagnosticsSnapshot {
        let guidance = if timed_out {
            "The audio device check is not responding. You can keep using saved notes; restart AI Notetaker to try the check again.".to_string()
        } else {
            "Audio device status is taking longer than usual. You can use saved notes while this check finishes; check audio again shortly.".to_string()
        };
        AudioDiagnosticsSnapshot {
            checking,
            timed_out,
            diagnostics: AudioDiagnostics {
                platform: std::env::consts::OS.to_string(),
                driver: "Checking".to_string(),
                driver_installed: false,
                microphone: None,
                speaker: None,
                ready: false,
                guidance,
                native_loopback: false,
                virtual_device_fallback: false,
                permission_required: false,
                microphone_permission: PermissionState::NotApplicable,
                screen_permission: PermissionState::NotApplicable,
            },
        }
    }
}

struct ProbeReset(Arc<Mutex<ProbeState>>);

impl Drop for ProbeReset {
    fn drop(&mut self) {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        state.in_flight = false;
        state.timed_out = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn ready_diagnostics() -> AudioDiagnostics {
        AudioDiagnostics {
            platform: "test".into(),
            driver: "Test loopback".into(),
            driver_installed: true,
            microphone: Some("Test microphone".into()),
            speaker: Some("Test speakers".into()),
            ready: true,
            guidance: "Ready".into(),
            native_loopback: true,
            virtual_device_fallback: false,
            permission_required: false,
            microphone_permission: PermissionState::NotApplicable,
            screen_permission: PermissionState::NotApplicable,
        }
    }

    #[tokio::test]
    async fn diagnostics_are_cached_to_coalesce_refreshes() {
        let coordinator = AudioDiagnosticsCoordinator::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let first_calls = calls.clone();
        let first = coordinator
            .get_with_probe(Duration::from_secs(1), move || {
                first_calls.fetch_add(1, Ordering::SeqCst);
                ready_diagnostics()
            })
            .await;
        let cached = coordinator
            .get_with_probe(Duration::from_secs(1), move || {
                panic!("a fresh cached diagnostic must not start another probe")
            })
            .await;

        assert_eq!(first.diagnostics, ready_diagnostics());
        assert!(!first.checking);
        assert_eq!(cached, first);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn invalidation_refreshes_diagnostics_after_audio_setup_changes() {
        let coordinator = AudioDiagnosticsCoordinator::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let first_calls = calls.clone();
        let _ = coordinator
            .get_with_probe(Duration::from_secs(1), move || {
                first_calls.fetch_add(1, Ordering::SeqCst);
                ready_diagnostics()
            })
            .await;

        coordinator.invalidate();
        let next_calls = calls.clone();
        let refreshed = coordinator
            .get_with_probe(Duration::from_secs(1), move || {
                next_calls.fetch_add(1, Ordering::SeqCst);
                ready_diagnostics()
            })
            .await;

        assert_eq!(refreshed.diagnostics, ready_diagnostics());
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn invalidation_does_not_cache_an_in_flight_stale_probe() {
        let coordinator = AudioDiagnosticsCoordinator::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let worker_calls = calls.clone();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let first_probe = tokio::spawn({
            let coordinator = coordinator.clone();
            async move {
                coordinator
                    .get_with_probe(Duration::from_secs(1), move || {
                        worker_calls.fetch_add(1, Ordering::SeqCst);
                        let _ = started_tx.send(());
                        let _ = release_rx.recv();
                        ready_diagnostics()
                    })
                    .await
            }
        });

        started_rx.await.unwrap();
        coordinator.invalidate();
        release_tx.send(()).unwrap();
        let completed = first_probe.await.unwrap();
        assert!(completed.diagnostics.ready);

        let next_calls = calls.clone();
        let refreshed = coordinator
            .get_with_probe(Duration::from_secs(1), move || {
                next_calls.fetch_add(1, Ordering::SeqCst);
                ready_diagnostics()
            })
            .await;

        assert!(refreshed.diagnostics.ready);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn timed_out_native_probe_does_not_spawn_another_worker() {
        let coordinator = AudioDiagnosticsCoordinator::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let worker_calls = calls.clone();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let first_probe = tokio::spawn({
            let coordinator = coordinator.clone();
            async move {
                coordinator
                    .get_with_probe(Duration::from_millis(20), move || {
                        worker_calls.fetch_add(1, Ordering::SeqCst);
                        let _ = started_tx.send(());
                        let _ = release_rx.recv();
                        ready_diagnostics()
                    })
                    .await
            }
        });

        started_rx.await.unwrap();
        let pending = first_probe.await.unwrap();
        assert!(!pending.diagnostics.ready);
        assert_eq!(pending.diagnostics.driver, "Checking");
        assert!(pending.checking);
        assert!(pending.timed_out);
        assert!(pending
            .diagnostics
            .guidance
            .contains("restart AI Notetaker"));

        let next_calls = calls.clone();
        let still_pending = coordinator
            .get_with_probe(Duration::from_millis(20), move || {
                next_calls.fetch_add(1, Ordering::SeqCst);
                ready_diagnostics()
            })
            .await;
        assert_eq!(still_pending.diagnostics, pending.diagnostics);
        assert!(still_pending.checking);
        assert!(still_pending.timed_out);
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        release_tx.send(()).unwrap();
        let completed = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let result = coordinator
                    .get_with_probe(Duration::from_millis(20), || {
                        panic!("the completed native probe result must be cached")
                    })
                    .await;
                if result.diagnostics.ready {
                    break result;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("native probe worker should finish after it is released");
        assert!(completed.diagnostics.ready);
        assert!(!completed.checking);
    }
}
