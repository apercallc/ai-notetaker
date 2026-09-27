//! Rolling file logs in the app-data directory.
//!
//! Release builds on Windows are a GUI-subsystem program with no console, and a
//! tray app on any OS has no terminal, so `stderr` is a black hole. Everything
//! the helper logs is written to `<data dir>/logs/helper-YYYY-MM-DD[-N].log`
//! (rolling daily, and again when a file passes `MAX_FILE_BYTES`), old files
//! are pruned, and the tray's "Open Logs" opens the folder.

use chrono::{Local, NaiveDate};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
const KEEP_FILES: usize = 14;
const FILE_PREFIX: &str = "helper-";
const FILE_SUFFIX: &str = ".log";

pub fn log_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("logs")
}

struct Current {
    date: NaiveDate,
    index: u32,
    file: File,
    written: u64,
}

pub struct RollingFile {
    dir: PathBuf,
    keep: usize,
    max_bytes: u64,
    current: Mutex<Option<Current>>,
}

impl RollingFile {
    pub fn new(dir: PathBuf) -> Self {
        Self::with_limits(dir, KEEP_FILES, MAX_FILE_BYTES)
    }

    fn with_limits(dir: PathBuf, keep: usize, max_bytes: u64) -> Self {
        Self {
            dir,
            keep,
            max_bytes,
            current: Mutex::new(None),
        }
    }

    fn file_name(date: NaiveDate, index: u32) -> String {
        if index == 0 {
            format!("{FILE_PREFIX}{date}{FILE_SUFFIX}")
        } else {
            format!("{FILE_PREFIX}{date}-{index}{FILE_SUFFIX}")
        }
    }

    fn open(&self, date: NaiveDate, index: u32) -> io::Result<Current> {
        fs::create_dir_all(&self.dir)?;
        let path = self.dir.join(Self::file_name(date, index));
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let written = file.metadata()?.len();
        self.prune();
        Ok(Current {
            date,
            index,
            file,
            written,
        })
    }

    /// Deletes the oldest log files beyond `keep`. Names sort chronologically
    /// (ISO date, then a numeric suffix) so a plain sort is enough.
    fn prune(&self) {
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return;
        };
        let mut logs: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| {
                        name.starts_with(FILE_PREFIX) && name.ends_with(FILE_SUFFIX)
                    })
            })
            .collect();
        logs.sort_by_key(|path| Self::sort_key(path));
        let excess = logs.len().saturating_sub(self.keep);
        for path in logs.into_iter().take(excess) {
            let _ = fs::remove_file(path);
        }
    }

    fn sort_key(path: &Path) -> (String, u32) {
        let stem = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("")
            .trim_start_matches(FILE_PREFIX)
            .trim_end_matches(FILE_SUFFIX)
            .to_string();
        // `2026-09-24-3` -> ("2026-09-24", 3); `2026-09-24` -> ("2026-09-24", 0)
        match stem.len() > 10 {
            true => (
                stem[..10].to_string(),
                stem[11..].parse::<u32>().unwrap_or(0),
            ),
            false => (stem, 0),
        }
    }

    fn write_on(&self, date: NaiveDate, bytes: &[u8]) -> io::Result<usize> {
        let mut guard = self.current.lock().unwrap_or_else(|p| p.into_inner());
        let needs_new_file = match guard.as_ref() {
            None => Some((date, 0)),
            Some(current) if current.date != date => Some((date, 0)),
            Some(current) if current.written >= self.max_bytes => {
                Some((current.date, current.index + 1))
            }
            Some(_) => None,
        };
        if let Some((date, index)) = needs_new_file {
            *guard = Some(self.open(date, index)?);
        }
        let current = guard.as_mut().expect("opened above");
        current.file.write_all(bytes)?;
        current.written += bytes.len() as u64;
        Ok(bytes.len())
    }
}

impl Write for &RollingFile {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.write_on(Local::now().date_naive(), bytes)
    }

    fn flush(&mut self) -> io::Result<()> {
        let mut guard = self.current.lock().unwrap_or_else(|p| p.into_inner());
        match guard.as_mut() {
            Some(current) => current.file.flush(),
            None => Ok(()),
        }
    }
}

/// Writes every log line to the rolling file and, when a console exists
/// (`cargo run`, a debug build), to stderr as well.
#[derive(Clone)]
pub struct LogWriter {
    file: Arc<RollingFile>,
}

pub struct LogWriterHandle<'a> {
    file: &'a RollingFile,
}

impl Write for LogWriterHandle<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        // stderr may be closed (GUI subsystem) — never let that fail logging.
        let _ = io::stderr().write_all(bytes);
        // A full disk must not turn every log line into an error either.
        let _ = (&*self.file).write(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        let _ = (&*self.file).flush();
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogWriter {
    type Writer = LogWriterHandle<'a>;

    fn make_writer(&'a self) -> Self::Writer {
        LogWriterHandle { file: &self.file }
    }
}

/// Installs the global tracing subscriber and a panic hook that logs the
/// panic (a tray app has no terminal to print it to).
pub fn init(data_dir: &Path) {
    let writer = LogWriter {
        file: Arc::new(RollingFile::new(log_dir(data_dir))),
    };
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_ansi(false)
        .with_writer(writer)
        .try_init();
    std::panic::set_hook(Box::new(|info| {
        tracing::error!("helper panicked: {info}");
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    fn day(day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 9, day).unwrap()
    }

    #[test]
    fn writes_go_to_a_dated_file_that_rolls_over_at_midnight() {
        let dir = tempfile::tempdir().unwrap();
        let logs = RollingFile::with_limits(dir.path().join("logs"), 14, MAX_FILE_BYTES);

        logs.write_on(day(24), b"one\n").unwrap();
        logs.write_on(day(24), b"two\n").unwrap();
        logs.write_on(day(25), b"three\n").unwrap();

        let logs_dir = dir.path().join("logs");
        assert_eq!(
            names(&logs_dir),
            vec!["helper-2026-09-24.log", "helper-2026-09-25.log"]
        );
        assert_eq!(
            fs::read_to_string(logs_dir.join("helper-2026-09-24.log")).unwrap(),
            "one\ntwo\n"
        );
    }

    #[test]
    fn a_full_file_rolls_to_the_next_index_and_old_files_are_pruned() {
        let dir = tempfile::tempdir().unwrap();
        let logs_dir = dir.path().join("logs");
        let logs = RollingFile::with_limits(logs_dir.clone(), 3, 8);

        for day_number in 20..=22 {
            logs.write_on(day(day_number), b"0123456789").unwrap();
        }
        // Same day, over the size cap: rolls to -1, then -2.
        logs.write_on(day(22), b"more").unwrap();
        logs.write_on(day(22), b"0123456789").unwrap();
        logs.write_on(day(22), b"tail").unwrap();

        assert_eq!(
            names(&logs_dir),
            vec![
                "helper-2026-09-22-1.log",
                "helper-2026-09-22-2.log",
                "helper-2026-09-22.log",
            ],
            "only the newest three files survive, ordered by date then index"
        );
        assert_eq!(
            fs::read_to_string(logs_dir.join("helper-2026-09-22-2.log")).unwrap(),
            "tail"
        );
    }

    #[test]
    fn non_log_files_in_the_folder_are_never_pruned() {
        let dir = tempfile::tempdir().unwrap();
        let logs_dir = dir.path().join("logs");
        fs::create_dir_all(&logs_dir).unwrap();
        fs::write(logs_dir.join("notes.txt"), "keep me").unwrap();
        let logs = RollingFile::with_limits(logs_dir.clone(), 1, MAX_FILE_BYTES);
        logs.write_on(day(1), b"a").unwrap();
        logs.write_on(day(2), b"b").unwrap();
        assert!(names(&logs_dir).contains(&"notes.txt".to_string()));
        assert_eq!(names(&logs_dir).len(), 2);
    }
}
