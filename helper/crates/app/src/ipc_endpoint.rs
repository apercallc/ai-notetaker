//! Naming of the local IPC endpoint that `notetaker-nm-host` (client) and
//! `notetaker-helper` (server) both need. Nothing here touches the network:
//! the endpoint is a filesystem socket inside the owner-only (0700) data
//! directory on Unix, and a per-user named pipe on Windows.
//!
//! Linux deliberately does not use the abstract socket namespace. Abstract
//! sockets have no filesystem permissions at all, so any local user could
//! connect to one; a socket file inside a 0700 directory is reachable only by
//! its owner, which is the property the Native Messaging design relies on.

use interprocess::local_socket::Name;
use std::io;
use std::path::{Path, PathBuf};

#[cfg(unix)]
use interprocess::local_socket::{GenericFilePath, ToFsName};
#[cfg(windows)]
use interprocess::local_socket::{GenericNamespaced, ToNsName};

pub const SOCKET_FILE: &str = "ai-notetaker.sock";

/// `sockaddr_un.sun_path` is 108 bytes on Linux and 104 on macOS; stay under
/// the smaller limit with room for the terminator.
#[cfg(unix)]
const MAX_UNIX_SOCKET_PATH_BYTES: usize = 100;

pub fn socket_file(dir: &Path) -> PathBuf {
    dir.join(SOCKET_FILE)
}

/// The endpoint for a given data directory.
#[cfg(unix)]
pub fn endpoint_name(dir: &Path) -> io::Result<Name<'static>> {
    let path = socket_file(dir);
    if path.as_os_str().len() > MAX_UNIX_SOCKET_PATH_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "socket path {} is too long for a Unix domain socket",
                path.display()
            ),
        ));
    }
    path.to_fs_name::<GenericFilePath>()
}

/// Windows named pipes live in one machine-wide namespace, so the pipe name
/// carries the user name: two users signed in on the same machine must not
/// collide on (or reach) each other's helper.
#[cfg(windows)]
pub fn endpoint_name(_dir: &Path) -> io::Result<Name<'static>> {
    pipe_name().to_ns_name::<GenericNamespaced>()
}

#[cfg(windows)]
fn pipe_name() -> String {
    let user: String = std::env::var("USERNAME")
        .unwrap_or_default()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        .collect();
    let user = if user.is_empty() {
        "user".to_string()
    } else {
        user
    };
    format!("ai-notetaker-{user}")
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn unix_endpoint_is_a_file_inside_the_given_directory_not_the_abstract_namespace() {
        let dir = Path::new("/tmp/example-data");
        assert_eq!(
            socket_file(dir),
            Path::new("/tmp/example-data/ai-notetaker.sock")
        );
        let name = endpoint_name(dir).unwrap();
        assert!(name.is_path());
        assert!(!name.is_namespaced());
    }

    #[test]
    fn an_over_long_socket_path_is_rejected_with_a_clear_error() {
        let long = PathBuf::from(format!("/tmp/{}", "a".repeat(120)));
        let error = endpoint_name(&long).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert!(error.to_string().contains("too long"));
    }
}
