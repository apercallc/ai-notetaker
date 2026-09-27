//! Wall-clock silence synthesis.
//!
//! WASAPI output loopback delivers no packets while nothing is playing, unlike
//! the microphone stream which produces samples continuously. If the speaker
//! channel simply skips those gaps, its sample timeline becomes shorter than
//! the mic's and everything after the first quiet stretch drifts out of sync.
//! [`SilenceFiller`] compares the frames emitted so far against wall-clock
//! time and produces the missing zero-filled PCM16.

use std::time::{Duration, Instant};

/// Never insert silence for gaps shorter than this: ordinary packet jitter
/// (10 ms cadence) must not be "corrected".
const MIN_GAP: Duration = Duration::from_millis(30);
/// Upper bound for a single synthesized chunk so memory stays bounded after a
/// long stall; the remainder is produced by following calls.
const MAX_CHUNK: Duration = Duration::from_secs(1);

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) struct SilenceFiller {
    sample_rate_hz: u32,
    started_at: Instant,
    emitted_frames: u64,
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
impl SilenceFiller {
    pub(crate) fn new(sample_rate_hz: u32, started_at: Instant) -> Self {
        Self {
            sample_rate_hz,
            started_at,
            emitted_frames: 0,
        }
    }

    /// Records mono frames that were delivered from the real device.
    pub(crate) fn note_real_frames(&mut self, frames: u64) {
        self.emitted_frames = self.emitted_frames.saturating_add(frames);
    }

    /// Returns zero-filled mono PCM16 covering the wall-clock time for which
    /// no audio has been emitted, if that gap is large enough to matter.
    pub(crate) fn silence_due(&mut self, now: Instant) -> Option<Vec<u8>> {
        let elapsed = now.saturating_duration_since(self.started_at);
        let expected = (elapsed.as_secs_f64() * f64::from(self.sample_rate_hz)) as u64;
        let deficit = expected.saturating_sub(self.emitted_frames);
        let min_gap = (MIN_GAP.as_secs_f64() * f64::from(self.sample_rate_hz)) as u64;
        if deficit < min_gap {
            return None;
        }
        let max_chunk = (MAX_CHUNK.as_secs_f64() * f64::from(self.sample_rate_hz)) as u64;
        let frames = deficit.min(max_chunk);
        self.emitted_frames += frames;
        Some(vec![0_u8; frames as usize * std::mem::size_of::<i16>()])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 48_000;

    fn frames(pcm: &[u8]) -> u64 {
        (pcm.len() / 2) as u64
    }

    #[test]
    fn nothing_is_synthesized_while_real_audio_keeps_up() {
        let start = Instant::now();
        let mut filler = SilenceFiller::new(RATE, start);
        // 10 ms packets arriving on time.
        for step in 1..=20_u32 {
            filler.note_real_frames(480);
            assert!(filler
                .silence_due(start + Duration::from_millis(u64::from(step) * 10))
                .is_none());
        }
    }

    #[test]
    fn a_quiet_gap_is_filled_to_wall_clock_length() {
        let start = Instant::now();
        let mut filler = SilenceFiller::new(RATE, start);
        // No packets at all for 500 ms.
        let silence = filler
            .silence_due(start + Duration::from_millis(500))
            .expect("gap should be filled");
        assert_eq!(frames(&silence), 24_000);
        assert!(silence.iter().all(|byte| *byte == 0));
        // The gap is now accounted for.
        assert!(filler
            .silence_due(start + Duration::from_millis(510))
            .is_none());
    }

    #[test]
    fn timeline_stays_aligned_across_real_audio_then_gap_then_real_audio() {
        let start = Instant::now();
        let mut filler = SilenceFiller::new(RATE, start);
        let mut total = 0_u64;
        // 100 ms of real audio.
        filler.note_real_frames(4_800);
        total += 4_800;
        // 2 s of nothing, polled every 5 ms like the WASAPI loop.
        for tick in 1..=(2_000 / 5) {
            let now = start + Duration::from_millis(100 + tick * 5);
            if let Some(silence) = filler.silence_due(now) {
                total += frames(&silence);
            }
        }
        // Audio resumes at t = 2.1 s.
        filler.note_real_frames(480);
        total += 480;
        let expected = (2.1 * f64::from(RATE)) as u64 + 480;
        let tolerance = u64::from(RATE) * 35 / 1000;
        assert!(
            total.abs_diff(expected) <= tolerance,
            "timeline {total} should be within {tolerance} frames of {expected}"
        );
    }

    #[test]
    fn very_long_stalls_are_chunked() {
        let start = Instant::now();
        let mut filler = SilenceFiller::new(RATE, start);
        let now = start + Duration::from_secs(5);
        let mut total = 0;
        while let Some(chunk) = filler.silence_due(now) {
            assert!(frames(&chunk) <= u64::from(RATE));
            total += frames(&chunk);
        }
        assert_eq!(total, 5 * u64::from(RATE));
    }
}
