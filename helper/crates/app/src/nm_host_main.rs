//! `notetaker-nm-host` — the binary registered as the actual Chrome Native
//! Messaging host (see `native-messaging-host-manifest/`). Chrome spawns
//! this fresh per `chrome.runtime.connectNative()` call and kills it when
//! that port disconnects.
//!
//! Its only job is relaying raw framed bytes between stdio (talking to
//! Chrome, per `docs/native-messaging-protocol.md`) and the persistent
//! `notetaker-helper` process's local socket (see `ipc.rs`) — it never
//! deserializes a message itself.
//!
//! If the helper is not running (it was quit, crashed, or the user has not
//! logged in yet), the host starts it detached and waits a few seconds for
//! its socket. If that still fails it answers on stdout with a framed
//! `helper_not_running` error — the only thing Chrome can show the user —
//! instead of exiting silently with a message on a stderr nobody reads.

mod ipc_client;
mod ipc_endpoint;
mod paths;

use interprocess::local_socket::tokio::Stream as LocalStream;
use notetaker_core::native_messaging::{write_message, ErrorCode, HelperToExtension};
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// How long to wait for a freshly launched helper to open its socket.
const HELPER_START_TIMEOUT: Duration = Duration::from_secs(5);
const HELPER_POLL_INTERVAL: Duration = Duration::from_millis(100);

/// Passed to the helper so that losing the single-instance race (Chrome
/// commonly opens several ports at once, each spawning a host) exits quietly
/// instead of showing an "already running" notification to the user.
const BACKGROUND_FLAG: &str = "--background";

fn helper_not_running_message(reason: &str) -> HelperToExtension {
    HelperToExtension::Error {
        meeting_id: None,
        code: ErrorCode::HelperNotRunning,
        message: format!(
            "AI Notetaker is not running and could not be started ({reason}). \
             Open AI Notetaker from your applications menu, then try again."
        ),
    }
}

#[cfg(windows)]
const HELPER_BINARY: &str = "notetaker-helper.exe";
#[cfg(not(windows))]
const HELPER_BINARY: &str = "notetaker-helper";

/// The helper ships next to this binary (`/usr/bin`, the macOS bundle's
/// `Contents/MacOS`, the Windows install directory).
fn helper_binary_path() -> io::Result<PathBuf> {
    let sibling = std::env::current_exe()?.with_file_name(HELPER_BINARY);
    if sibling.is_file() {
        Ok(sibling)
    } else {
        Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!(
                "{} was not found next to the native host",
                sibling.display()
            ),
        ))
    }
}

/// Starts the helper as an independent process that outlives this host (which
/// Chrome kills as soon as the port closes).
fn spawn_helper_detached(binary: &Path) -> io::Result<()> {
    use std::process::{Command, Stdio};

    let mut command = Command::new(binary);
    command
        .arg(BACKGROUND_FLAG)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Its own process group: a signal sent to Chrome's group when the
        // browser exits must not take the helper down with it.
        command.process_group(0);
        command.spawn().map(|_| ())
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        // Chrome runs native hosts inside a job object. Breakaway lets the
        // helper survive the job being closed, but is refused when the job
        // does not permit it; retry without rather than fail to launch.
        let detached = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
        command.creation_flags(detached | CREATE_BREAKAWAY_FROM_JOB);
        match command.spawn() {
            Ok(_) => Ok(()),
            Err(_) => {
                command.creation_flags(detached);
                command.spawn().map(|_| ())
            }
        }
    }
}

/// Connects to the helper, launching it if nothing is listening. `launch` is
/// called at most once; `wait` bounds how long to keep polling afterwards.
async fn connect_or_start<L>(
    dir: &Path,
    launch: L,
    wait: Duration,
    poll: Duration,
) -> io::Result<LocalStream>
where
    L: FnOnce() -> io::Result<()>,
{
    let first_error = match ipc_client::connect(dir).await {
        Ok(conn) => return Ok(conn),
        Err(error) => error,
    };
    tracing::info!("helper not reachable ({first_error}); starting it");
    if let Err(error) = launch() {
        // Another host may have launched it a moment ago, so keep polling.
        tracing::warn!("could not launch the helper: {error}");
    }
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        tokio::time::sleep(poll).await;
        match ipc_client::connect(dir).await {
            Ok(conn) => return Ok(conn),
            Err(error) if tokio::time::Instant::now() >= deadline => {
                return Err(io::Error::new(
                    error.kind(),
                    format!("helper did not open its socket within {}s", wait.as_secs()),
                ));
            }
            Err(_) => continue,
        }
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .init();

    let connected = async {
        let dir = paths::data_dir()?;
        connect_or_start(
            &dir,
            || spawn_helper_detached(&helper_binary_path()?),
            HELPER_START_TIMEOUT,
            HELPER_POLL_INTERVAL,
        )
        .await
    }
    .await;

    let mut helper_conn = match connected {
        Ok(conn) => conn,
        Err(error) => {
            tracing::error!("could not reach notetaker-helper: {error}");
            let reply = helper_not_running_message(&error.to_string());
            if let Err(write_error) = write_message(&mut std::io::stdout().lock(), &reply) {
                tracing::error!("could not report the failure to the browser: {write_error}");
            }
            return;
        }
    };

    let mut stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    let (mut helper_read, mut helper_write) = tokio::io::split(&mut helper_conn);

    let stdin_to_helper = async {
        loop {
            match ipc_client::relay_one_frame(&mut stdin, &mut helper_write).await {
                Ok(true) => continue,
                Ok(false) => break, // Chrome closed stdin (extension disconnected)
                Err(e) => {
                    tracing::warn!("stdin->helper relay error: {e}");
                    break;
                }
            }
        }
    };

    let helper_to_stdout = async {
        loop {
            match ipc_client::relay_one_frame(&mut helper_read, &mut stdout).await {
                Ok(true) => continue,
                Ok(false) => break, // helper closed the connection
                Err(e) => {
                    tracing::warn!("helper->stdout relay error: {e}");
                    break;
                }
            }
        }
    };

    tokio::select! {
        _ = stdin_to_helper => {},
        _ = helper_to_stdout => {},
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notetaker_core::native_messaging::MAX_MESSAGE_BYTES;

    #[test]
    fn the_failure_reply_is_a_valid_framed_helper_not_running_error() {
        let mut framed = Vec::new();
        write_message(&mut framed, &helper_not_running_message("test")).unwrap();

        let len = u32::from_le_bytes(framed[..4].try_into().unwrap());
        assert_eq!(len as usize, framed.len() - 4);
        assert!(len < MAX_MESSAGE_BYTES);
        let json: serde_json::Value = serde_json::from_slice(&framed[4..]).unwrap();
        assert_eq!(json["type"], "error");
        assert_eq!(json["code"], "helper_not_running");
        assert!(json["message"].as_str().unwrap().contains("test"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn gives_up_with_an_error_when_the_helper_never_appears() {
        let dir = tempfile::tempdir().unwrap();
        let mut launched = 0;
        let result = connect_or_start(
            dir.path(),
            || {
                launched += 1;
                Ok(())
            },
            Duration::from_millis(250),
            Duration::from_millis(20),
        )
        .await;
        assert!(result.is_err());
        assert_eq!(launched, 1, "the launcher runs exactly once");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn launches_the_helper_and_connects_once_its_socket_appears() {
        use interprocess::local_socket::{tokio::prelude::*, ListenerOptions};
        let dir = tempfile::tempdir().unwrap();
        let socket_dir = dir.path().to_path_buf();
        let name_dir = socket_dir.clone();

        let result = connect_or_start(
            &socket_dir,
            move || {
                // The "helper" takes 300 ms to come up, as a real one does.
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    let listener = ListenerOptions::new()
                        .name(ipc_endpoint::endpoint_name(&name_dir).unwrap())
                        .create_tokio()
                        .unwrap();
                    let _ = listener.accept().await;
                });
                Ok(())
            },
            Duration::from_secs(5),
            Duration::from_millis(20),
        )
        .await;
        assert!(result.is_ok(), "should connect after the helper starts");
    }
}
