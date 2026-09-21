//! Minimal WAV container writer. Whisper-family APIs (Groq) need a
//! decodable audio file, not bare PCM samples — this wraps raw PCM16 mono
//! samples in the smallest valid WAV header rather than pulling in a
//! full audio-container crate for one struct's worth of bytes.

/// Wraps mono PCM16 little-endian samples in a canonical 44-byte WAV header.
pub fn pcm16_to_wav(pcm16: &[u8], sample_rate_hz: u32) -> Vec<u8> {
    let num_channels: u16 = 1;
    let bits_per_sample: u16 = 16;
    let byte_rate = sample_rate_hz * num_channels as u32 * (bits_per_sample as u32 / 8);
    let block_align = num_channels * (bits_per_sample / 8);
    let data_len = pcm16.len() as u32;
    let riff_chunk_size = 36 + data_len;

    let mut out = Vec::with_capacity(44 + pcm16.len());
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&riff_chunk_size.to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM format
    out.extend_from_slice(&num_channels.to_le_bytes());
    out.extend_from_slice(&sample_rate_hz.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&block_align.to_le_bytes());
    out.extend_from_slice(&bits_per_sample.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    out.extend_from_slice(pcm16);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn produces_valid_44_byte_header_plus_data() {
        let pcm = vec![1, 2, 3, 4, 5, 6];
        let wav = pcm16_to_wav(&pcm, 16000);
        assert_eq!(wav.len(), 44 + pcm.len());
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(&wav[44..], &pcm[..]);
    }

    #[test]
    fn encodes_sample_rate_and_mono_channel_count() {
        let wav = pcm16_to_wav(&[0, 0], 44100);
        let channels = u16::from_le_bytes([wav[22], wav[23]]);
        let sample_rate = u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]);
        assert_eq!(channels, 1);
        assert_eq!(sample_rate, 44100);
    }

    #[test]
    fn riff_chunk_size_is_data_len_plus_36() {
        let pcm = vec![0u8; 100];
        let wav = pcm16_to_wav(&pcm, 16000);
        let riff_size = u32::from_le_bytes([wav[4], wav[5], wav[6], wav[7]]);
        assert_eq!(riff_size, 136);
    }
}
