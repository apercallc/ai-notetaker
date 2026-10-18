//! Wall-clock silence synthesis.
//!
//! WASAPI output loopback delivers no packets while nothing is playing, unlike
//! the microphone stream which produces samples continuously. If the speaker
//! channel simply skips those gaps, its sample timeline becomes shorter than
//! the mic's and everything after the first quiet stretch drifts out of sync.
//! [`SilenceFiller`] compares the frames emitted so far against wall-clock
//! time and produces the missing zero-filled PCM16.
//!
//! The same accounting keeps the speaker channel aligned across a restart:
//! one filler lives for the whole recording (not one per loopback/`parec`
//! attempt), so the time between a source dying and its replacement starting
//! is filled with silence instead of being skipped.

use std::time::{Duration, Instant};

/// Never insert silence for gaps shorter than this: ordinary packet jitter
/// (10 ms cadence) must not be "corrected".
const MIN_GAP: Duration = Duration::from_millis(30);
/// Upper bound for a single synthesized chunk so memory stays bounded after a
/// long stall; the remainder is produced by following calls.
const MAX_CHUNK: Duration = Duration::from_secs(1);
/// A deficit longer than this is not a restart gap or a quiet stretch (both
/// are filled continuously and restart backoff caps at seconds): it means the
/// whole process stalled or the machine slept, when the microphone captured
/// nothing either. Filling it would push the speaker channel *ahead* of the
/// mic and write minutes of zeros, so the timeline is re-based instead.
const MAX_GAP_FILL: Duration = Duration::from_secs(60);

#[cfg_attr(not(any(target_os = "windows", target_os = "linux")), allow(dead_code))]
pub(crate) struct SilenceFiller {
    sample_rate_hz: u32,
    started_at: Instant,
    emitted_frames: u64,
}

#[cfg_attr(not(any(target_os = "windows", target_os = "linux")), allow(dead_code))]
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

    fn frames_in(&self, duration: Duration) -> u64 {
        (duration.as_secs_f64() * f64::from(self.sample_rate_hz)) as u64
    }

    /// Returns zero-filled mono PCM16 covering the wall-clock time for which
    /// no audio has been emitted, if that gap is large enough to matter. A
    /// long gap comes back in [`MAX_CHUNK`] pieces over successive calls.
    pub(crate) fn silence_due(&mut self, now: Instant) -> Option<Vec<u8>> {
        let elapsed = now.saturating_duration_since(self.started_at);
        let expected = self.frames_in(elapsed);
        let deficit = expected.saturating_sub(self.emitted_frames);
        if deficit < self.frames_in(MIN_GAP) {
            return None;
        }
        if deficit > self.frames_in(MAX_GAP_FILL) {
            tracing::warn!(
                gap_secs = deficit / u64::from(self.sample_rate_hz.max(1)),
                "speaker timeline gap too long to be a restart; re-basing instead of filling"
            );
            self.emitted_frames = expected;
            return None;
        }
        let max_chunk = self.frames_in(MAX_CHUNK);
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

    #[test]
    fn one_filler_keeps_alignment_across_a_restart_gap() {
        // Source A delivers 3 s in real time, dies, the restart takes 2.5 s
        // (backoff), then source B delivers in real time again. Polled every
        // 100 ms like the Linux supervisor and the Windows retry wait.
        let start = Instant::now();
        let mut filler = SilenceFiller::new(RATE, start);
        let mut total = 0_u64;
        let mut tick = |filler: &mut SilenceFiller, ms: u64, real: u64| {
            filler.note_real_frames(real);
            total += real;
            while let Some(silence) = filler.silence_due(start + Duration::from_millis(ms)) {
                total += frames(&silence);
            }
            total
        };
        let per_tick = u64::from(RATE) / 10;
        for ms in (100..=3_000).step_by(100) {
            tick(&mut filler, ms, per_tick);
        }
        for ms in (3_100..=5_500).step_by(100) {
            tick(&mut filler, ms, 0);
        }
        let mut last = 0;
        for ms in (5_600..=8_000).step_by(100) {
            last = tick(&mut filler, ms, per_tick);
        }
        let expected = 8 * u64::from(RATE);
        let tolerance = u64::from(RATE) * 35 / 1000;
        assert!(
            last.abs_diff(expected) <= tolerance,
            "speaker timeline {last} should track the mic's {expected} within {tolerance}"
        );
    }

    #[test]
    fn a_gap_longer_than_any_restart_is_rebased_not_filled() {
        let start = Instant::now();
        let mut filler = SilenceFiller::new(RATE, start);
        filler.note_real_frames(u64::from(RATE));
        // The machine slept for 10 minutes.
        assert!(filler
            .silence_due(start + Duration::from_secs(601))
            .is_none());
        // Afterwards ordinary gaps are measured from the re-based point.
        let silence = filler
            .silence_due(start + Duration::from_millis(601_500))
            .expect("a normal gap after re-basing is filled");
        assert_eq!(frames(&silence), u64::from(RATE) / 2);
    }

    #[test]
    fn gaps_up_to_the_fill_limit_are_filled_completely() {
        let start = Instant::now();
        let mut filler = SilenceFiller::new(RATE, start);
        let now = start + MAX_GAP_FILL;
        let mut total = 0;
        while let Some(chunk) = filler.silence_due(now) {
            total += frames(&chunk);
        }
        assert_eq!(total, 60 * u64::from(RATE));
    }
}
