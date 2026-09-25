//! Server side of the local IPC between the two binaries this crate ships:
//!
//! - `notetaker-nm-host`: the tiny binary actually registered as the
//!   Chrome Native Messaging host. Chrome spawns a fresh instance of this
//!   per `connectNative()` call and kills it when the port disconnects —
//!   it is not meant to be a long-lived background process. Its client half
//!   lives in `ipc_client.rs`.
//! - `notetaker-helper`: the persistent tray app that owns the pipeline,
//!   audio capture, and crash-recovery state, and needs to keep running
//!   independent of whether the extension is currently connected. This file
//!   is its server half.
//!
//! **This split is a necessary addition the protocol doc
//! (`docs/native-messaging-protocol.md`) doesn't cover** — it only
//! specifies the extension<->helper wire format, not how a
//! per-connection-spawned process reconciles with a persistent background
//! app.
//!
//! Both the Native Messaging wire format (stdin/stdout, per
//! `notetaker_core::native_messaging`) and this internal bridge use
//! identical 4-byte little-endian-length-prefixed JSON framing on purpose: it
//! means `notetaker-nm-host` doesn't need to understand message schemas at
//! all — it just relays raw frames between stdio and the socket. Only
//! `notetaker-helper`, which actually runs the pipeline, needs to
//! deserialize.
//!
//! The bridge is a local (Unix domain socket / Windows named pipe) IPC
//! channel — deliberately not a TCP/loopback socket, to stay clearly outside
//! any class of "open port a webpage could reach" concern. See
//! `ipc_endpoint.rs` for the naming and permission model.

use crate::ipc_endpoint;
use interprocess::local_socket::tokio::{prelude::*, Listener, Stream as LocalStream};
use interprocess::local_socket::ListenerOptions;
use notetaker_core::native_messaging::{
    ErrorCode, ExtensionToHelper, HelperToExtension, MAX_MESSAGE_BYTES,
};
use std::path::Path;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub type OutSender = tokio::sync::mpsc::UnboundedSender<HelperToExtension>;

/// The reply for a frame that is not valid JSON for any message this helper
/// knows. The parser's own error text is never echoed back: it can quote
/// field values, and a `settings` message carries API keys.
const UNRECOGNIZED_MESSAGE: &str =
    "The helper could not understand this message (unknown type or malformed fields). \
     Update the AI Notetaker extension and helper so they match.";

#[cfg(unix)]
fn ensure_socket_directory(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(dir)?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn ensure_socket_directory(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)
}

/// Windows: restrict the pipe to the owning user (and SYSTEM). Without an
/// explicit descriptor a named pipe inherits a default DACL that grants
/// read access to Everyone and Anonymous.
#[cfg(windows)]
fn restrict_to_current_user(options: ListenerOptions<'_>) -> std::io::Result<ListenerOptions<'_>> {
    use interprocess::os::windows::local_socket::ListenerOptionsExt;
    use interprocess::os::windows::security_descriptor::SecurityDescriptor;
    // D:P            protected DACL (no inherited entries)
    // (A;;GA;;;OW)   allow GENERIC_ALL to the object's owner (the creating user)
    // (A;;GA;;;SY)   allow GENERIC_ALL to LocalSystem
    let sddl = widestring::u16cstr!("D:P(A;;GA;;;OW)(A;;GA;;;SY)");
    let descriptor = SecurityDescriptor::deserialize(sddl)?;
    Ok(options.security_descriptor(descriptor))
}

#[cfg(not(windows))]
fn restrict_to_current_user(options: ListenerOptions<'_>) -> std::io::Result<ListenerOptions<'_>> {
    Ok(options)
}

/// Binds the listener, clearing a stale socket file left behind by an
/// unclean shutdown.
///
/// A crash or a SIGKILL leaves the socket file behind, and the next bind
/// fails with `AddrInUse` — which, without this, permanently bricks the
/// helper's IPC: every subsequent launch fails to bind, so the extension can
/// never reach it again and the only fix is the user manually deleting a
/// file inside the app-data directory.
///
/// "Stale" is decided by probing, never assumed: if something answers on the
/// socket a second helper really is running, and removing the file would
/// silently steal its address, so that case is left as the original error.
///
/// On Windows the first pipe instance is created with
/// `FILE_FLAG_FIRST_PIPE_INSTANCE`, so a second helper cannot bind the same
/// pipe name; that failure is reported the same way.
fn bind_listener(dir: &Path) -> std::io::Result<Listener> {
    let create = || {
        let options = ListenerOptions::new().name(ipc_endpoint::endpoint_name(dir)?);
        restrict_to_current_user(options)?.create_tokio()
    };
    match create() {
        Ok(listener) => Ok(listener),
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
            if !remove_stale_socket_file(dir) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::AddrInUse,
                    "another AI Notetaker helper is already listening on the IPC socket",
                ));
            }
            create()
        }
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied && cfg!(windows) => {
            Err(std::io::Error::new(
                std::io::ErrorKind::AddrInUse,
                "another AI Notetaker helper already owns the IPC pipe",
            ))
        }
        Err(error) => Err(error),
    }
}

/// Returns true only if a genuinely-dead socket file was removed. Windows
/// named pipes have no file to go stale, so this is a no-op there.
#[cfg(unix)]
fn remove_stale_socket_file(dir: &Path) -> bool {
    let path = ipc_endpoint::socket_file(dir);
    if !path.exists() {
        return false;
    }
    if std::os::unix::net::UnixStream::connect(&path).is_ok() {
        // Something is listening: a second helper really is running, and
        // removing the file would silently steal its address.
        return false;
    }
    tracing::warn!(
        "removing stale IPC socket at {} left by an unclean shutdown",
        path.display()
    );
    std::fs::remove_file(&path).is_ok()
}

#[cfg(not(unix))]
fn remove_stale_socket_file(_dir: &Path) -> bool {
    false
}

/// Runs on `notetaker-helper`: accepts connections from `notetaker-nm-host`
/// shim instances (one per Chrome-initiated extension connection).
///
/// `handler` is called once per incoming message with an `OutSender` it can
/// use to push any number of replies back — immediately, or later from a
/// spawned task (this is what makes live `transcript_partial` streaming
/// possible: a `start_recording` call kicks off audio capture whose frames
/// arrive over time and get pushed through the same sender, not returned
/// synchronously from the call that started them). The handler is awaited
/// per connection in message order, so long-running work (the stop pipeline)
/// must be spawned by the handler rather than awaited, or it would stall the
/// audio chunks queued behind it.
pub async fn run_ipc_server<F, Fut>(dir: &Path, handler: F) -> std::io::Result<()>
where
    F: Fn(ExtensionToHelper, OutSender) -> Fut + Clone + Send + 'static,
    Fut: std::future::Future<Output = bool> + Send,
{
    ensure_socket_directory(dir)?;
    let listener = bind_listener(dir)?;
    serve(listener, handler).await
}

async fn serve<F, Fut>(listener: Listener, handler: F) -> std::io::Result<()>
where
    F: Fn(ExtensionToHelper, OutSender) -> Fut + Clone + Send + 'static,
    Fut: std::future::Future<Output = bool> + Send,
{
    loop {
        let conn = match listener.accept().await {
            Ok(conn) => conn,
            // One connection failing to be accepted (a descriptor limit, a
            // client that hung up mid-handshake) must not take the whole
            // server down with it — returning here would end the accept loop
            // permanently and leave the tray app running but unreachable.
            Err(error) => {
                tracing::warn!("ipc accept failed: {error}");
                continue;
            }
        };
        let handler = handler.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_connection(conn, handler).await {
                tracing::warn!("ipc connection error: {e}");
            }
        });
    }
}

/// Reads one frame. `Ok(None)` is a clean EOF; an over-size length is an
/// error because the stream cannot be resynchronised after it.
async fn read_frame<R: tokio::io::AsyncRead + Unpin>(
    reader: &mut R,
) -> std::io::Result<Option<Vec<u8>>> {
    let mut len_buf = [0u8; 4];
    match reader.read_exact(&mut len_buf).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
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
    reader.read_exact(&mut payload).await?;
    Ok(Some(payload))
}

fn protocol_error(message: &str) -> HelperToExtension {
    HelperToExtension::Error {
        meeting_id: None,
        code: ErrorCode::ProtocolMismatch,
        message: message.to_string(),
    }
}

async fn handle_connection<F, Fut>(conn: LocalStream, handler: F) -> std::io::Result<()>
where
    F: Fn(ExtensionToHelper, OutSender) -> Fut,
    Fut: std::future::Future<Output = bool>,
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

    let mut authenticated = false;
    let mut outcome = Ok(());
    loop {
        let payload = match read_frame(&mut read_half).await {
            Ok(Some(payload)) => payload,
            Ok(None) => break,
            Err(error) => {
                let _ = out_tx.send(protocol_error(
                    "A message exceeded the size limit; the connection was closed.",
                ));
                outcome = Err(error);
                break;
            }
        };
        // A frame this helper cannot parse (an unknown `type` from a newer
        // extension, a malformed field) is answered with an error and the
        // connection stays up, rather than dropping every in-flight
        // recording's channel over one bad message.
        let msg: ExtensionToHelper = match serde_json::from_slice(&payload) {
            Ok(msg) => msg,
            Err(error) => {
                tracing::warn!(
                    line = error.line(),
                    column = error.column(),
                    kind = ?error.classify(),
                    "ignoring an unparseable IPC message"
                );
                let _ = out_tx.send(protocol_error(UNRECOGNIZED_MESSAGE));
                continue;
            }
        };
        if !authenticated {
            if !matches!(&msg, ExtensionToHelper::Hello { .. }) {
                let _ = out_tx.send(HelperToExtension::Error {
                    meeting_id: None,
                    code: ErrorCode::HelperNotPaired,
                    message: "the first message on a connection must be hello".into(),
                });
                outcome = Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "first IPC message must be hello",
                ));
                break;
            }
            authenticated = handler(msg, out_tx.clone()).await;
            if !authenticated {
                break;
            }
        } else {
            handler(msg, out_tx.clone()).await;
        }
    }

    drop(out_tx);
    let _ = writer_task.await;
    outcome
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    async fn send_raw(stream: &mut LocalStream, payload: &[u8]) {
        stream
            .write_all(&(payload.len() as u32).to_le_bytes())
            .await
            .unwrap();
        stream.write_all(payload).await.unwrap();
        stream.flush().await.unwrap();
    }

    async fn recv(stream: &mut LocalStream) -> Option<serde_json::Value> {
        let frame = tokio::time::timeout(Duration::from_secs(5), read_frame(stream))
            .await
            .expect("timed out waiting for a frame")
            .unwrap()?;
        Some(serde_json::from_slice(&frame).unwrap())
    }

    /// Serves `dir` with a handler that authenticates `hello`, records every
    /// other message type it receives, and echoes a `recording_stopped`.
    async fn spawn_server(dir: &Path) -> Arc<Mutex<Vec<String>>> {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let seen_for_handler = seen.clone();
        let listener = bind_listener(dir).unwrap();
        tokio::spawn(serve(listener, move |msg, out| {
            let seen = seen_for_handler.clone();
            async move {
                match msg {
                    ExtensionToHelper::Hello { .. } => {
                        seen.lock().unwrap().push("hello".into());
                        true
                    }
                    ExtensionToHelper::StopRecording { meeting_id, .. } => {
                        seen.lock().unwrap().push("stop".into());
                        let _ = out.send(HelperToExtension::RecordingStopped { meeting_id });
                        true
                    }
                    _ => true,
                }
            }
        }));
        seen
    }

    async fn connect(dir: &Path) -> LocalStream {
        LocalStream::connect(ipc_endpoint::endpoint_name(dir).unwrap())
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn unknown_and_malformed_messages_get_a_protocol_error_and_keep_the_connection() {
        let dir = tempfile::tempdir().unwrap();
        ensure_socket_directory(dir.path()).unwrap();
        let seen = spawn_server(dir.path()).await;
        let mut client = connect(dir.path()).await;

        send_raw(&mut client, br#"{"type":"hello","pairingToken":null}"#).await;
        // Unknown type, then non-JSON: each is answered, neither closes the
        // connection, and neither echoes the payload back.
        send_raw(
            &mut client,
            br#"{"type":"from_the_future","secret":"sk-live-123"}"#,
        )
        .await;
        let reply = recv(&mut client).await.unwrap();
        assert_eq!(reply["type"], "error");
        assert_eq!(reply["code"], "protocol_mismatch");
        assert!(!reply.to_string().contains("sk-live-123"));
        send_raw(&mut client, b"this is not json").await;
        assert_eq!(
            recv(&mut client).await.unwrap()["code"],
            "protocol_mismatch"
        );

        // Still usable afterwards.
        send_raw(
            &mut client,
            br#"{"type":"stop_recording","meetingId":"11111111-1111-4111-8111-111111111111"}"#,
        )
        .await;
        assert_eq!(
            recv(&mut client).await.unwrap()["type"],
            "recording_stopped"
        );
        assert_eq!(*seen.lock().unwrap(), vec!["hello", "stop"]);
    }

    #[tokio::test]
    async fn the_first_message_must_be_hello_and_the_refusal_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        ensure_socket_directory(dir.path()).unwrap();
        let seen = spawn_server(dir.path()).await;
        let mut client = connect(dir.path()).await;

        send_raw(
            &mut client,
            br#"{"type":"stop_recording","meetingId":"11111111-1111-4111-8111-111111111111"}"#,
        )
        .await;
        let reply = recv(&mut client).await.unwrap();
        assert_eq!(reply["code"], "helper_not_paired");
        assert!(recv(&mut client).await.is_none(), "connection should close");
        assert!(seen.lock().unwrap().is_empty());
    }

    #[test]
    fn socket_directory_is_owner_only_and_the_endpoint_is_a_file_there() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        ensure_socket_directory(&data).unwrap();
        assert_eq!(
            std::fs::metadata(&data).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let name = ipc_endpoint::endpoint_name(&data).unwrap();
        assert!(name.is_path());
    }

    #[tokio::test]
    async fn a_stale_socket_file_is_replaced_but_a_live_one_is_never_stolen() {
        let dir = tempfile::tempdir().unwrap();
        ensure_socket_directory(dir.path()).unwrap();
        let path = ipc_endpoint::socket_file(dir.path());

        // Simulate a SIGKILLed helper: the file exists, nobody listens.
        drop(std::os::unix::net::UnixListener::bind(&path).unwrap());
        assert!(path.exists());
        let live = bind_listener(dir.path()).expect("stale socket must be cleared");

        // Now a real listener is live: a second bind must fail, not steal.
        let error = bind_listener(dir.path()).expect_err("must not steal");
        assert_eq!(error.kind(), std::io::ErrorKind::AddrInUse);
        drop(live);
    }
}
