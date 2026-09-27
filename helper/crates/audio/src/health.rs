//! Capture-health reporting.
//!
//! A backend that loses its source mid-meeting (parec exits, a WASAPI endpoint
//! is invalidated by a default-device change, ScreenCaptureKit stops, a cpal
//! stream errors) must not just log: the app needs to tell the user that one
//! side of the recording went quiet. Backends publish [`CaptureHealthEvent`]s
//! on a [`HealthHub`]; the app subscribes through
//! [`crate::AudioCapture::subscribe_health`].

use notetaker_core::providers::AudioChannel;
use std::time::Duration;
use tokio::sync::broadcast;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureHealthKind {
    /// The underlying stream reported an error (cpal error callback, WASAPI
    /// read failure, ScreenCaptureKit stop-with-error).
    StreamError,
    /// The capture source ended on its own (parec exited, endpoint gone).
    SourceEnded,
    /// The system default device changed and capture is following it.
    DeviceChanged,
    /// Capture for this channel was re-established after a failure/change.
    Restarted,
    /// A restart attempt failed; the backend keeps retrying with backoff.
    RestartFailed,
}

impl CaptureHealthKind {
    /// True when this event means audio for the channel is (or may be)
    /// missing until a later `Restarted` event arrives.
    pub fn is_degraded(self) -> bool {
        !matches!(self, Self::Restarted | Self::DeviceChanged)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureHealthEvent {
    pub channel: AudioChannel,
    pub kind: CaptureHealthKind,
    pub message: String,
}

/// Cloneable publisher for [`CaptureHealthEvent`]s. Emitting never blocks and
/// never fails when nobody is subscribed.
#[derive(Clone)]
pub struct HealthHub {
    tx: broadcast::Sender<CaptureHealthEvent>,
}

impl HealthHub {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(64);
        Self { tx }
    }

    pub fn emit(&self, channel: AudioChannel, kind: CaptureHealthKind, message: impl Into<String>) {
        let event = CaptureHealthEvent {
            channel,
            kind,
            message: message.into(),
        };
        if kind.is_degraded() {
            tracing::warn!(?event.channel, ?event.kind, message = %event.message, "capture health");
        } else {
            tracing::info!(?event.channel, ?event.kind, message = %event.message, "capture health");
        }
        let _ = self.tx.send(event);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<CaptureHealthEvent> {
        self.tx.subscribe()
    }
}

impl Default for HealthHub {
    fn default() -> Self {
        Self::new()
    }
}

/// Exponential retry delay (1 s, 2 s, 4 s, then capped at 5 s) used when a
/// source keeps failing to come back.
#[derive(Debug, Default)]
pub(crate) struct Backoff {
    attempt: u32,
}

impl Backoff {
    pub(crate) fn next_delay(&mut self) -> Duration {
        let seconds = (1_u64 << self.attempt.min(3)).min(5);
        self.attempt = self.attempt.saturating_add(1);
        Duration::from_secs(seconds)
    }

    pub(crate) fn reset(&mut self) {
        self.attempt = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subscribers_receive_events_in_order() {
        let hub = HealthHub::new();
        let mut rx = hub.subscribe();
        hub.emit(
            AudioChannel::Speaker,
            CaptureHealthKind::SourceEnded,
            "parec exited",
        );
        hub.emit(
            AudioChannel::Speaker,
            CaptureHealthKind::Restarted,
            "parec restarted",
        );
        let first = rx.try_recv().expect("first event");
        assert_eq!(first.kind, CaptureHealthKind::SourceEnded);
        assert!(first.kind.is_degraded());
        let second = rx.try_recv().expect("second event");
        assert_eq!(second.kind, CaptureHealthKind::Restarted);
        assert!(!second.kind.is_degraded());
    }

    #[test]
    fn emitting_without_subscribers_is_harmless() {
        HealthHub::new().emit(
            AudioChannel::Mic,
            CaptureHealthKind::StreamError,
            "nobody listens",
        );
    }

    #[test]
    fn backoff_grows_then_caps_and_resets() {
        let mut backoff = Backoff::default();
        let delays: Vec<u64> = (0..6).map(|_| backoff.next_delay().as_secs()).collect();
        assert_eq!(delays, vec![1, 2, 4, 5, 5, 5]);
        backoff.reset();
        assert_eq!(backoff.next_delay().as_secs(), 1);
    }
}
