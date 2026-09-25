//! Where the helper keeps its data. Shared by `notetaker-helper` and the
//! `notetaker-nm-host` relay, which must agree on the socket location.

use std::io;
use std::path::PathBuf;

/// The per-user app-data directory (`…/ai-notetaker`).
///
/// This deliberately does not fall back to the system temp directory when the
/// OS reports no data dir: temp is world-listable and cleaned on reboot, which
/// is the wrong place for meeting audio, the pairing token and the IPC socket.
/// Failing loudly lets the caller tell the user instead of silently recording
/// somewhere unsafe.
pub fn data_dir() -> io::Result<PathBuf> {
    dirs::data_dir()
        .map(|dir| dir.join("ai-notetaker"))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "the operating system did not report a per-user data directory \
                 (HOME / XDG_DATA_HOME / %APPDATA% is not set)",
            )
        })
}
