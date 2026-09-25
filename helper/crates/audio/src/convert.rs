//! Platform-neutral PCM conversion shared by every capture backend.
//!
//! The pipeline consumes mono little-endian PCM16. Native devices, however,
//! hand us whatever they like: interleaved f32/i16/u16 from cpal, interleaved
//! f32 from WASAPI/ScreenCaptureKit, raw s16le from `parec`. Keeping the
//! conversion in one place (and testable on any host) means none of the
//! backends has to assume "f32, mono".

use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// A sample type that can be converted to a normalized f32 in [-1.0, 1.0].
pub(crate) trait SampleToF32: Copy {
    fn to_f32(self) -> f32;

    /// Averages one interleaved frame down to a single PCM16 sample.
    fn frame_to_pcm16(frame: &[Self]) -> i16 {
        let sum: f32 = frame.iter().map(|sample| sample.to_f32()).sum();
        f32_to_pcm16(sum / frame.len().max(1) as f32)
    }
}

impl SampleToF32 for f32 {
    fn to_f32(self) -> f32 {
        self
    }
}

impl SampleToF32 for i16 {
    fn to_f32(self) -> f32 {
        f32::from(self) / 32_768.0
    }

    // Integer averaging keeps i16 sources bit-exact (no f32 round trip).
    fn frame_to_pcm16(frame: &[Self]) -> i16 {
        let sum: i32 = frame.iter().map(|sample| i32::from(*sample)).sum();
        (sum / frame.len().max(1) as i32) as i16
    }
}

impl SampleToF32 for u16 {
    fn to_f32(self) -> f32 {
        (f32::from(self) - 32_768.0) / 32_768.0
    }
}

impl SampleToF32 for i32 {
    fn to_f32(self) -> f32 {
        self as f32 / 2_147_483_648.0
    }
}

impl SampleToF32 for i8 {
    fn to_f32(self) -> f32 {
        f32::from(self) / 128.0
    }
}

impl SampleToF32 for u8 {
    fn to_f32(self) -> f32 {
        (f32::from(self) - 128.0) / 128.0
    }
}

pub(crate) fn f32_to_pcm16(sample: f32) -> i16 {
    (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)).round() as i16
}

/// Converts interleaved samples of any supported cpal sample format into mono
/// little-endian PCM16 bytes. A trailing partial frame is dropped.
pub(crate) fn samples_to_mono_pcm16<T: SampleToF32>(data: &[T], channels: usize) -> Vec<u8> {
    let channels = channels.max(1);
    let mut pcm16 = Vec::with_capacity(data.len() / channels * std::mem::size_of::<i16>());
    for frame in data.chunks_exact(channels) {
        pcm16.extend_from_slice(&T::frame_to_pcm16(frame).to_le_bytes());
    }
    pcm16
}

/// Converts the native Windows/macOS loopback format (interleaved IEEE-754
/// f32, little endian) into the mono little-endian PCM16 frames consumed by
/// the core pipeline.
#[allow(dead_code)]
pub(crate) fn interleaved_f32_to_mono_pcm16(data: &[u8], channels: usize) -> Vec<u8> {
    if channels == 0 {
        return Vec::new();
    }
    let bytes_per_frame = channels.saturating_mul(std::mem::size_of::<f32>());
    if bytes_per_frame == 0 {
        return Vec::new();
    }

    let frame_count = data.len() / bytes_per_frame;
    let mut pcm16 = Vec::with_capacity(frame_count * std::mem::size_of::<i16>());
    for frame in data[..frame_count * bytes_per_frame].chunks_exact(bytes_per_frame) {
        let mut sum = 0.0_f32;
        for sample in frame.as_chunks::<4>().0 {
            sum += f32::from_le_bytes([sample[0], sample[1], sample[2], sample[3]]);
        }
        pcm16.extend_from_slice(&f32_to_pcm16(sum / channels as f32).to_le_bytes());
    }
    pcm16
}

/// Incrementally converts a raw interleaved s16le byte stream (as produced by
/// `parec --raw`) into mono PCM16. Reads from a pipe can end mid-sample or
/// mid-frame; the partial tail is carried to the next chunk so samples never
/// shift by a byte (which would turn the stream into noise).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) struct S16leMonoConverter {
    channels: usize,
    carry: Vec<u8>,
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
impl S16leMonoConverter {
    pub(crate) fn new(channels: usize) -> Self {
        Self {
            channels: channels.max(1),
            carry: Vec::new(),
        }
    }

    pub(crate) fn push(&mut self, chunk: &[u8]) -> Vec<u8> {
        self.carry.extend_from_slice(chunk);
        let frame_bytes = self.channels * std::mem::size_of::<i16>();
        let usable = self.carry.len() / frame_bytes * frame_bytes;
        if usable == 0 {
            return Vec::new();
        }
        let mut pcm16 = Vec::with_capacity(usable / self.channels);
        if self.channels == 1 {
            pcm16.extend_from_slice(&self.carry[..usable]);
        } else {
            for frame in self.carry[..usable].chunks_exact(frame_bytes) {
                let samples: Vec<i16> = frame
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
                    .collect();
                pcm16.extend_from_slice(&i16::frame_to_pcm16(&samples).to_le_bytes());
            }
        }
        self.carry.drain(..usable);
        pcm16
    }
}

/// Why a raw-PCM pump loop ended.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PumpExit {
    /// The writer closed the pipe (for `parec`: the process exited).
    EndOfStream,
    /// A read error occurred while the capture was still supposed to run.
    ReadError(String),
    /// Capture was stopped deliberately.
    Stopped,
}

/// Reads raw interleaved s16le from `reader` until it ends, converting each
/// chunk to mono PCM16 and handing it to `emit`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn pump_s16le_mono(
    mut reader: impl Read,
    channels: usize,
    running: &Arc<AtomicBool>,
    mut emit: impl FnMut(Vec<u8>),
) -> PumpExit {
    let mut converter = S16leMonoConverter::new(channels);
    let mut buffer = [0_u8; 19_200];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => {
                return if running.load(Ordering::SeqCst) {
                    PumpExit::EndOfStream
                } else {
                    PumpExit::Stopped
                };
            }
            Ok(bytes_read) => {
                let pcm16 = converter.push(&buffer[..bytes_read]);
                if !pcm16.is_empty() {
                    emit(pcm16);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => {
                return if running.load(Ordering::SeqCst) {
                    PumpExit::ReadError(error.to_string())
                } else {
                    PumpExit::Stopped
                };
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pcm_values(bytes: &[u8]) -> Vec<i16> {
        bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
            .collect()
    }

    #[test]
    fn f32_stereo_is_averaged_to_mono() {
        let samples = [0.5_f32, -0.5, 1.0, 1.0];
        let values = pcm_values(&samples_to_mono_pcm16(&samples, 2));
        assert_eq!(values, vec![0, i16::MAX]);
    }

    #[test]
    fn i16_mono_passes_through_bit_exact() {
        let samples = [-32_768_i16, -1, 0, 1, 1000, 32_767];
        let values = pcm_values(&samples_to_mono_pcm16(&samples, 1));
        assert_eq!(values, samples.to_vec());
    }

    #[test]
    fn i16_stereo_is_averaged_without_overflow() {
        let samples = [32_767_i16, 32_767, -32_768, -32_768, 100, 300];
        let values = pcm_values(&samples_to_mono_pcm16(&samples, 2));
        assert_eq!(values, vec![32_767, -32_768, 200]);
    }

    #[test]
    fn u16_is_recentered_around_zero() {
        let samples = [32_768_u16, 0, 65_535];
        let values = pcm_values(&samples_to_mono_pcm16(&samples, 1));
        assert_eq!(values[0], 0);
        assert_eq!(values[1], -i16::MAX);
        assert!(values[2] >= i16::MAX - 2);
    }

    #[test]
    fn i32_u8_and_i8_formats_are_scaled() {
        assert_eq!(
            pcm_values(&samples_to_mono_pcm16(&[i32::MAX / 2], 1)),
            vec![16_384]
        );
        assert_eq!(pcm_values(&samples_to_mono_pcm16(&[128_u8], 1)), vec![0]);
        assert_eq!(
            pcm_values(&samples_to_mono_pcm16(&[64_i8], 1)),
            vec![16_384]
        );
    }

    #[test]
    fn multichannel_frames_average_all_channels_and_drop_partial_tail() {
        // 3 channels, 2 full frames plus one dangling sample.
        let samples = [0.3_f32, 0.3, 0.3, -0.6, 0.0, 0.0, 0.9];
        let values = pcm_values(&samples_to_mono_pcm16(&samples, 3));
        assert_eq!(values.len(), 2);
        assert_eq!(values[0], f32_to_pcm16(0.3));
        assert_eq!(values[1], f32_to_pcm16(-0.2));
    }

    #[test]
    fn zero_channels_is_treated_as_mono_instead_of_panicking() {
        assert_eq!(samples_to_mono_pcm16(&[0.0_f32, 0.0], 0).len(), 4);
    }

    #[test]
    fn out_of_range_and_nan_floats_are_clamped() {
        let values = pcm_values(&samples_to_mono_pcm16(&[2.0_f32, -2.0, f32::NAN], 1));
        assert_eq!(values, vec![i16::MAX, -i16::MAX, 0]);
    }

    #[test]
    fn s16le_stereo_is_downmixed_to_mono_at_full_length() {
        // Regression: parec used to deliver stereo bytes stored as mono,
        // producing half-speed audio. N stereo frames must give N mono samples.
        let stereo: Vec<u8> = [100_i16, 300, -200, -400]
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect();
        let mut converter = S16leMonoConverter::new(2);
        let mono = converter.push(&stereo);
        assert_eq!(pcm_values(&mono), vec![200, -300]);
    }

    #[test]
    fn s16le_converter_carries_partial_samples_across_reads() {
        let bytes: Vec<u8> = [1_i16, 2, 3, 4]
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect();
        let mut converter = S16leMonoConverter::new(2);
        let mut out = Vec::new();
        // 3 bytes, then 3 bytes, then 2 bytes: splits inside samples and frames.
        out.extend(converter.push(&bytes[..3]));
        out.extend(converter.push(&bytes[3..6]));
        out.extend(converter.push(&bytes[6..]));
        assert_eq!(pcm_values(&out), vec![1, 3]);
    }

    #[test]
    fn s16le_mono_passthrough_keeps_sample_alignment() {
        let bytes: Vec<u8> = [10_i16, -20, 30]
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect();
        let mut converter = S16leMonoConverter::new(1);
        let mut out = converter.push(&bytes[..1]);
        out.extend(converter.push(&bytes[1..]));
        assert_eq!(pcm_values(&out), vec![10, -20, 30]);
    }

    /// Reader that returns fixed-size odd chunks, like a pipe would.
    struct ChunkedReader {
        data: Vec<u8>,
        pos: usize,
        chunk: usize,
    }

    impl Read for ChunkedReader {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let end = (self.pos + self.chunk)
                .min(self.data.len())
                .min(self.pos + buf.len());
            let n = end - self.pos;
            buf[..n].copy_from_slice(&self.data[self.pos..end]);
            self.pos = end;
            Ok(n)
        }
    }

    #[test]
    fn pump_reports_end_of_stream_and_emits_aligned_mono_frames() {
        let stereo: Vec<u8> = (0..100_i16)
            .flat_map(|sample| [sample, sample].into_iter())
            .flat_map(|sample| sample.to_le_bytes())
            .collect();
        let running = Arc::new(AtomicBool::new(true));
        let mut collected = Vec::new();
        let exit = pump_s16le_mono(
            ChunkedReader {
                data: stereo,
                pos: 0,
                chunk: 7,
            },
            2,
            &running,
            |chunk| collected.extend(chunk),
        );
        assert_eq!(exit, PumpExit::EndOfStream);
        assert_eq!(pcm_values(&collected), (0..100_i16).collect::<Vec<_>>());
    }

    #[test]
    fn pump_reports_stopped_when_capture_was_stopped_deliberately() {
        let running = Arc::new(AtomicBool::new(false));
        let exit = pump_s16le_mono(std::io::empty(), 1, &running, |_| {});
        assert_eq!(exit, PumpExit::Stopped);
    }

    #[test]
    fn interleaved_bytes_helper_matches_typed_helper() {
        let samples = [0.5_f32, -0.5, 1.0, 1.0];
        let bytes: Vec<u8> = samples
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect();
        assert_eq!(
            interleaved_f32_to_mono_pcm16(&bytes, 2),
            samples_to_mono_pcm16(&samples, 2)
        );
        assert!(interleaved_f32_to_mono_pcm16(&[0; 7], 2).is_empty());
        assert!(interleaved_f32_to_mono_pcm16(&[0; 8], 0).is_empty());
    }
}
