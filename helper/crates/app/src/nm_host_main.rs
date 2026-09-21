//! `notetaker-nm-host` — the binary registered as the actual Chrome Native
//! Messaging host (see `native-messaging-host-manifest/`). Chrome spawns
//! this fresh per `chrome.runtime.connectNative()` call and kills it when
//! that port disconnects.
//!
//! Its only job is relaying raw framed bytes between stdio (talking to
//! Chrome, per `docs/native-messaging-protocol.md`) and the persistent
//! `notetaker-helper` process's local socket (see `ipc.rs`) — it never
//! deserializes a message itself.

mod ipc;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt().with_writer(std::io::stderr).init();

    let mut helper_conn = match ipc::connect().await {
        Ok(conn) => conn,
        Err(e) => {
            tracing::error!("could not reach notetaker-helper: {e}. Is it running?");
            std::process::exit(1);
        }
    };

    let mut stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    let (mut helper_read, mut helper_write) = tokio::io::split(&mut helper_conn);

    let stdin_to_helper = async {
        loop {
            match ipc::relay_one_frame(&mut stdin, &mut helper_write).await {
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
            match ipc::relay_one_frame(&mut helper_read, &mut stdout).await {
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

    Ok(())
}
