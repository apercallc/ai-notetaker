//! Local IPC between the two binaries this crate ships:
//!
//! - `notetaker-nm-host`: the tiny binary actually registered as the
//!   Chrome Native Messaging host. Chrome spawns a fresh instance of this
//!   per `connectNative()` call and kills it when the port disconnects —
//!   it is not meant to be a long-lived background process.
//! - `notetaker-helper`: the persistent tray app that owns the pipeline,
//!   audio capture, and crash-recovery state, and needs to keep running
//!   independent of whether the extension is currently connected.
//!
//! **This split is a necessary addition the protocol doc
//! (`docs/native-messaging-protocol.md`) doesn't cover** — it only
//! specifies the extension<->helper wire format, not how a
//! per-connection-spawned process reconciles with a persistent background
//! app. Flagged in the helper implementation report for the coordinator to
//! fold back into that doc.
//!
//! Both the Native Messaging wire format (stdin/stdout, per
//! `notetaker_core::native_messaging`) and this internal bridge use
//! identical 4-byte little-endian-length-prefixed JSON framing on purpose: it means
//! `notetaker-nm-host` doesn't need to understand message schemas at all —
//! it just relays raw frames between stdio and the socket. Only
//! `notetaker-helper`, which actually runs the pipeline, needs to
//! deserialize.
//!
//! The bridge is a local (Unix domain socket / Windows named pipe) IPC
//! channel — deliberately not a TCP/loopback socket, to stay clearly
//! outside any class of "open port a webpage could reach" concern, even
//! though only our own two processes are ever expected to speak this
//! protocol.
//!
//! This one file is compiled into both `notetaker-helper` (server side)
//! and `notetaker-nm-host` (client/relay side) as a shared `mod ipc;` —
//! each binary only exercises half of it, hence the `allow(dead_code)`
//! below rather than splitting into two files for what's a handful of
//! genuinely-shared helpers (`socket_name`).

#![allow(dead_code)]

use interprocess::local_socket::tokio::{prelude::*, Stream as LocalStream};
use interprocess::local_socket::{
    GenericFilePath, GenericNamespaced, ListenerOptions, ToFsName, ToNsName,
};
use notetaker_core::native_messaging::{ExtensionToHelper, HelperToExtension};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

const SOCKET_NAME: &str = "ai-notetaker.sock";

pub fn socket_name() -> std::io::Result<interprocess::local_socket::Name<'static>> {
    if GenericNamespaced::is_supported() {
        SOCKET_NAME.to_ns_name::<GenericNamespaced>()
    } else {
        let path = std::env::temp_dir().join(SOCKET_NAME);
        path.to_fs_name::<GenericFilePath>()
    }
}

pub async fn connect() -> std::io::Result<LocalStream> {
    LocalStream::connect(socket_name()?).await
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
    let mut payload = vec![0u8; len];
    r.read_exact(&mut payload).await?;
    w.write_all(&len_buf).await?;
    w.write_all(&payload).await?;
    w.flush().await?;
    Ok(true)
}

pub type OutSender = tokio::sync::mpsc::UnboundedSender<HelperToExtension>;

/// Runs on `notetaker-helper`: accepts connections from `notetaker-nm-host`
/// shim instances (one per Chrome-initiated extension connection).
///
/// `handler` is called once per incoming message with an `OutSender` it can
/// use to push any number of replies back — immediately, or later from a
/// spawned task (this is what makes live `transcript_partial` streaming
/// possible: a `start_recording` call kicks off audio capture whose frames
/// arrive over time and get pushed through the same sender, not returned
/// synchronously from the call that started them).
pub async fn run_ipc_server<F, Fut>(handler: F) -> std::io::Result<()>
where
    F: Fn(ExtensionToHelper, OutSender) -> Fut + Clone + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send,
{
    let listener = ListenerOptions::new().name(socket_name()?).create_tokio()?;
    loop {
        let conn = listener.accept().await?;
        let handler = handler.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_connection(conn, handler).await {
                tracing::warn!("ipc connection error: {e}");
            }
        });
    }
}

async fn handle_connection<F, Fut>(conn: LocalStream, handler: F) -> std::io::Result<()>
where
    F: Fn(ExtensionToHelper, OutSender) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    let (mut read_half, mut write_half) = tokio::io::split(conn);
    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<HelperToExtension>();

    let writer_task = tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            let Ok(bytes) = serde_json::to_vec(&msg) else {
                continue;
            };
            if write_half
                .write_all(&(bytes.len() as u32).to_le_bytes())
                .await
                .is_err()
            {
                break;
            }
            if write_half.write_all(&bytes).await.is_err() {
                break;
            }
            let _ = write_half.flush().await;
        }
    });

    loop {
        let mut len_buf = [0u8; 4];
        match read_half.read_exact(&mut len_buf).await {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(e),
        }
        let len = u32::from_le_bytes(len_buf) as usize;
        let mut payload = vec![0u8; len];
        read_half.read_exact(&mut payload).await?;
        let msg: ExtensionToHelper = serde_json::from_slice(&payload)?;
        handler(msg, out_tx.clone()).await;
    }

    drop(out_tx);
    let _ = writer_task.await;
    Ok(())
}
