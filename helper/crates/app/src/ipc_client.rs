//! Client half of the local IPC, used only by `notetaker-nm-host`. The
//! server half and the framing rationale live in `ipc.rs`.

use crate::ipc_endpoint;
use interprocess::local_socket::tokio::{prelude::*, Stream as LocalStream};
use notetaker_core::native_messaging::MAX_MESSAGE_BYTES;
use std::path::Path;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub async fn connect(dir: &Path) -> std::io::Result<LocalStream> {
    LocalStream::connect(ipc_endpoint::endpoint_name(dir)?).await
}

/// Reads one length-prefixed frame and writes it straight through
/// unmodified. Returns `Ok(false)` on a clean EOF (the other side hung
/// up), `Ok(true)` if a frame was relayed, `Err` on an actual I/O failure.
pub async fn relay_one_frame<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
    r: &mut R,
    w: &mut W,
) -> std::io::Result<bool> {
    let mut len_buf = [0u8; 4];
    match r.read_exact(&mut len_buf).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(false),
        Err(e) => return Err(e),
    }
    let len = u32::from_le_bytes(len_buf) as usize;
    if len > MAX_MESSAGE_BYTES as usize {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("IPC frame exceeds {MAX_MESSAGE_BYTES}-byte limit"),
        ));
    }
    let mut payload = vec![0u8; len];
    r.read_exact(&mut payload).await?;
    w.write_all(&len_buf).await?;
    w.write_all(&payload).await?;
    w.flush().await?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn relays_a_frame_verbatim_and_reports_clean_eof() {
        let mut input: Vec<u8> = Vec::new();
        input.extend_from_slice(&5u32.to_le_bytes());
        input.extend_from_slice(b"hello");
        let mut reader = &input[..];
        let mut output: Vec<u8> = Vec::new();

        assert!(relay_one_frame(&mut reader, &mut output).await.unwrap());
        assert_eq!(output, input);
        assert!(!relay_one_frame(&mut reader, &mut output).await.unwrap());
    }

    #[tokio::test]
    async fn refuses_an_oversized_frame_length() {
        let input = (MAX_MESSAGE_BYTES + 1).to_le_bytes();
        let mut reader = &input[..];
        let mut output: Vec<u8> = Vec::new();
        let error = relay_one_frame(&mut reader, &mut output).await.unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    }
}
