//! Single-instance guard for the helper.
//!
//! Two helpers would fight over the IPC socket, the audio device and the same
//! `meta.json` files. The guard is an exclusive advisory lock on
//! `<data dir>/helper.lock`, held for the life of the process. The OS drops
//! it when the process exits — cleanly or not — so a crash can never leave a
//! stale lock behind (which a PID file would).

use std::fs::{File, OpenOptions, TryLockError};
use std::io;
use std::path::{Path, PathBuf};

/// Keeps the lock held; drop it (or exit) to release.
pub struct InstanceLock {
    _file: File,
}

pub enum Acquired {
    Yes(InstanceLock),
    /// Another helper already holds the lock.
    AlreadyRunning,
}

pub fn lock_path(data_dir: &Path) -> PathBuf {
    data_dir.join("helper.lock")
}

pub fn acquire(data_dir: &Path) -> io::Result<Acquired> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(lock_path(data_dir))?;
    match file.try_lock() {
        Ok(()) => Ok(Acquired::Yes(InstanceLock { _file: file })),
        Err(TryLockError::WouldBlock) => Ok(Acquired::AlreadyRunning),
        Err(TryLockError::Error(error)) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_second_instance_is_refused_until_the_first_exits() {
        let dir = tempfile::tempdir().unwrap();

        let first = match acquire(dir.path()).unwrap() {
            Acquired::Yes(lock) => lock,
            Acquired::AlreadyRunning => panic!("the first acquire must succeed"),
        };
        assert!(matches!(
            acquire(dir.path()).unwrap(),
            Acquired::AlreadyRunning
        ));

        drop(first);
        assert!(matches!(acquire(dir.path()).unwrap(), Acquired::Yes(_)));
    }
}
