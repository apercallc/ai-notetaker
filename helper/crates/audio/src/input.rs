//! Shared cpal microphone (and virtual-device) input, used by every backend.
//!
//! The device's real sample format and channel count are honored: cpal is
//! asked for the sample type the device actually reports (F32, I16, U16, ...)
//! and every callback is downmixed to mono PCM16 through [`crate::convert`].

use crate::convert::{samples_to_mono_pcm16, SampleToF32};
use crate::health::{Backoff, CaptureHealthKind, HealthHub};
use crate::{AudioDeviceInfo, AudioError, CapturedFrame};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use notetaker_core::providers::AudioChannel;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Called (from cpal's audio thread) when the stream reports an error.
pub(crate) type StreamErrorSink = Arc<dyn Fn(String) + Send + Sync>;

/// Builds the frame a cpal callback delivers, or `None` when it carries no
/// complete frame.
pub(crate) fn frame_from_samples<T: SampleToF32>(
    data: &[T],
    channels: usize,
    channel: AudioChannel,
    sample_rate_hz: u32,
) -> Option<CapturedFrame> {
    let pcm16 = samples_to_mono_pcm16(data, channels);
    (!pcm16.is_empty()).then_some(CapturedFrame {
        channel,
        pcm16,
        sample_rate_hz,
    })
}

fn build_typed_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channel: AudioChannel,
    tx: Sender<CapturedFrame>,
    on_error: StreamErrorSink,
) -> Result<cpal::Stream, cpal::BuildStreamError>
where
    T: cpal::SizedSample + SampleToF32 + Send + 'static,
{
    let channels = usize::from(config.channels);
    let sample_rate_hz = config.sample_rate.0;
    device.build_input_stream(
        config,
        move |data: &[T], _| {
            if let Some(frame) = frame_from_samples(data, channels, channel, sample_rate_hz) {
                let _ = tx.send(frame);
            }
        },
        move |error| on_error(error.to_string()),
        None,
    )
}

/// Opens `device` with its default input config, converting whatever sample
/// format/channel layout it reports into mono PCM16 frames on `tx`.
pub(crate) fn build_input_stream(
    device: &cpal::Device,
    channel: AudioChannel,
    tx: Sender<CapturedFrame>,
    on_error: StreamErrorSink,
) -> Result<cpal::Stream, AudioError> {
    let supported = device
        .default_input_config()
        .map_err(|e| AudioError::StreamError(format!("no default input config: {e}")))?;
    let format = supported.sample_format();
    let config = supported.config();

    let stream = match format {
        cpal::SampleFormat::F32 => {
            build_typed_stream::<f32>(device, &config, channel, tx, on_error)
        }
        cpal::SampleFormat::I16 => {
            build_typed_stream::<i16>(device, &config, channel, tx, on_error)
        }
        cpal::SampleFormat::U16 => {
            build_typed_stream::<u16>(device, &config, channel, tx, on_error)
        }
        cpal::SampleFormat::I32 => {
            build_typed_stream::<i32>(device, &config, channel, tx, on_error)
        }
        cpal::SampleFormat::I8 => build_typed_stream::<i8>(device, &config, channel, tx, on_error),
        cpal::SampleFormat::U8 => build_typed_stream::<u8>(device, &config, channel, tx, on_error),
        other => {
            return Err(AudioError::StreamError(format!(
                "unsupported input sample format {other:?}"
            )))
        }
    }
    .map_err(|e| AudioError::StreamError(e.to_string()))?;

    stream
        .play()
        .map_err(|e| AudioError::StreamError(e.to_string()))?;
    Ok(stream)
}

/// Finds an input device by id (its cpal name). An unknown id falls back to
/// the system default with a warning instead of failing the whole recording.
pub(crate) fn find_input_device(requested: Option<&str>) -> Option<cpal::Device> {
    let host = cpal::default_host();
    if let Some(id) = requested {
        if let Some(device) = host
            .input_devices()
            .ok()
            .and_then(|mut devices| devices.find(|d| d.name().ok().as_deref() == Some(id)))
        {
            return Some(device);
        }
        tracing::warn!(
            device = id,
            "requested microphone not found; using the default input"
        );
    }
    host.default_input_device()
}

pub(crate) fn default_input_name() -> Option<String> {
    cpal::default_host()
        .default_input_device()
        .and_then(|device| device.name().ok())
}

pub(crate) fn list_input_devices() -> Vec<AudioDeviceInfo> {
    let host = cpal::default_host();
    let default = host
        .default_input_device()
        .and_then(|device| device.name().ok());
    host.input_devices()
        .map(|devices| {
            devices
                .filter_map(|device| device.name().ok())
                .map(|name| AudioDeviceInfo {
                    is_default: default.as_deref() == Some(name.as_str()),
                    id: name.clone(),
                    name,
                })
                .collect()
        })
        .unwrap_or_default()
}

const DEFAULT_DEVICE_POLL: Duration = Duration::from_secs(2);

/// Owns one cpal input stream on the capture-supervisor thread (a
/// `cpal::Stream` is not `Send`) and keeps it alive: stream errors and
/// default-device changes trigger a reopen, with health events and backoff.
/// Used for the microphone and for virtual-cable speaker fallbacks.
pub(crate) struct InputSupervisor {
    channel: AudioChannel,
    /// A pinned device is never re-routed to follow the system default.
    requested: Option<String>,
    tx: Sender<CapturedFrame>,
    health: HealthHub,
    errored: Arc<AtomicBool>,
    stream: Option<cpal::Stream>,
    current_name: Option<String>,
    next_default_check: Instant,
    retry_at: Option<Instant>,
    backoff: Backoff,
}

impl InputSupervisor {
    /// Opens the device. The first open must succeed (recording without a
    /// mic is a start failure); later failures are retried in [`Self::tick`].
    pub(crate) fn start(
        channel: AudioChannel,
        requested: Option<String>,
        tx: Sender<CapturedFrame>,
        health: HealthHub,
    ) -> Result<Self, AudioError> {
        let mut supervisor = Self {
            channel,
            requested,
            tx,
            health,
            errored: Arc::new(AtomicBool::new(false)),
            stream: None,
            current_name: None,
            next_default_check: Instant::now() + DEFAULT_DEVICE_POLL,
            retry_at: None,
            backoff: Backoff::default(),
        };
        supervisor.open()?;
        Ok(supervisor)
    }

    fn open(&mut self) -> Result<(), AudioError> {
        let device = find_input_device(self.requested.as_deref()).ok_or_else(|| {
            AudioError::DeviceNotFound("the system microphone was not found".into())
        })?;
        let errored = self.errored.clone();
        let health = self.health.clone();
        let channel = self.channel;
        let on_error: StreamErrorSink = Arc::new(move |message| {
            health.emit(channel, CaptureHealthKind::StreamError, message);
            errored.store(true, Ordering::SeqCst);
        });
        let stream = build_input_stream(&device, self.channel, self.tx.clone(), on_error)?;
        self.current_name = device.name().ok();
        self.stream = Some(stream);
        Ok(())
    }

    /// Call periodically (about every 100 ms) from the supervisor thread.
    pub(crate) fn tick(&mut self) {
        let now = Instant::now();
        if self.errored.swap(false, Ordering::SeqCst) {
            self.stream = None;
            self.retry_at = Some(now);
        }
        // Follow the system default only when the caller did not pin a device.
        if self.requested.is_none() && self.stream.is_some() && now >= self.next_default_check {
            self.next_default_check = now + DEFAULT_DEVICE_POLL;
            if let Some(default) = default_input_name() {
                if self.current_name.as_deref() != Some(default.as_str()) {
                    self.health.emit(
                        self.channel,
                        CaptureHealthKind::DeviceChanged,
                        format!("default input device changed to {default}"),
                    );
                    self.stream = None;
                    self.retry_at = Some(now);
                }
            }
        }
        if let Some(due) = self.retry_at {
            if now >= due {
                match self.open() {
                    Ok(()) => {
                        self.retry_at = None;
                        self.backoff.reset();
                        self.health.emit(
                            self.channel,
                            CaptureHealthKind::Restarted,
                            "input capture re-established",
                        );
                    }
                    Err(error) => {
                        self.health.emit(
                            self.channel,
                            CaptureHealthKind::RestartFailed,
                            error.to_string(),
                        );
                        self.retry_at = Some(now + self.backoff.next_delay());
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn callback_frames_are_mono_pcm16_for_every_supported_format() {
        let f32_frame =
            frame_from_samples(&[0.5_f32, 0.5, -0.5, -0.5], 2, AudioChannel::Mic, 44_100).unwrap();
        assert_eq!(f32_frame.sample_rate_hz, 44_100);
        assert_eq!(f32_frame.pcm16.len(), 4);

        let i16_frame =
            frame_from_samples(&[100_i16, 200, 300, 400], 2, AudioChannel::Mic, 48_000).unwrap();
        assert_eq!(
            i16_frame.pcm16,
            [150_i16, 350]
                .iter()
                .flat_map(|s| s.to_le_bytes())
                .collect::<Vec<u8>>()
        );

        let u16_frame =
            frame_from_samples(&[32_768_u16, 32_768], 1, AudioChannel::Speaker, 48_000).unwrap();
        assert_eq!(u16_frame.channel, AudioChannel::Speaker);
        assert_eq!(u16_frame.pcm16, vec![0, 0, 0, 0]);
    }

    #[test]
    fn empty_or_partial_callbacks_produce_no_frame() {
        assert!(frame_from_samples::<f32>(&[], 2, AudioChannel::Mic, 48_000).is_none());
        assert!(frame_from_samples(&[0.1_f32], 2, AudioChannel::Mic, 48_000).is_none());
    }
}
