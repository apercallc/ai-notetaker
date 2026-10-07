//! Daily release checks (off until the user enables them in the tray) for the unsigned direct-download channel.
//!
//! This module never downloads or installs an update. It compares the latest
//! stable GitHub release with this build, asks once per version, and opens the
//! fixed official Releases page only when the user accepts.

use chrono::{DateTime, Duration, Utc};
use semver::Version;
use serde::Deserialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

const LATEST_RELEASE_API: &str =
    "https://api.github.com/repos/apercallc/ai-notetaker/releases/latest";
const CHECK_STATE_FILE: &str = "update-check.json";
const CHECK_INTERVAL: Duration = Duration::hours(24);

static CHECK_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Debug, Default, Deserialize, serde::Serialize)]
struct CheckState {
    last_successful_check: Option<DateTime<Utc>>,
    prompted_versions: HashSet<String>,
}

#[derive(Debug, Deserialize)]
struct ReleaseResponse {
    tag_name: String,
    draft: bool,
    prerelease: bool,
}

/// Marker file: the daily background check runs only after the user turned it
/// on from the tray. Manual "Check for Updates…" always works.
const BACKGROUND_CHECK_MARKER: &str = "update-check-enabled";

pub fn background_checks_enabled(data_dir: &Path) -> bool {
    data_dir.join(BACKGROUND_CHECK_MARKER).exists()
}

/// Turns the daily background check on or off. Returns whether the setting now matches `enabled`.
pub fn set_background_checks(data_dir: &Path, enabled: bool) -> bool {
    let marker = data_dir.join(BACKGROUND_CHECK_MARKER);
    let result = if enabled {
        std::fs::write(&marker, b"enabled")
    } else {
        match std::fs::remove_file(&marker) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        }
    };
    result.is_ok()
}

pub async fn check_if_due<R: Runtime>(app: &AppHandle<R>, data_dir: &Path) {
    if !background_checks_enabled(data_dir) {
        return;
    }
    check(app, data_dir, false).await;
}

pub async fn check_now<R: Runtime>(app: &AppHandle<R>, data_dir: &Path) {
    check(app, data_dir, true).await;
}

async fn check<R: Runtime>(app: &AppHandle<R>, data_dir: &Path, force: bool) {
    let _guard = CHECK_LOCK.lock().await;
    let state_path = data_dir.join(CHECK_STATE_FILE);
    let mut state = read_state(&state_path);
    let now = Utc::now();
    if !force
        && state
            .last_successful_check
            .is_some_and(|checked| now.signed_duration_since(checked) < CHECK_INTERVAL)
    {
        return;
    }

    let client = match notetaker_core::providers::http_client_builder()
        .user_agent(concat!("AI-Notetaker/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(12))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            tracing::debug!(%error, "could not configure GitHub release check");
            if force {
                show_manual_notice(
                    app,
                    "Could not check for updates",
                    "Try again in a moment.".into(),
                );
            }
            return;
        }
    };
    let release = match client
        .get(LATEST_RELEASE_API)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
    {
        Ok(response) => match response.json::<ReleaseResponse>().await {
            Ok(release) => release,
            Err(error) => {
                tracing::debug!(%error, "could not read GitHub release metadata");
                if force {
                    show_manual_notice(
                        app,
                        "Could not check for updates",
                        "GitHub returned release information the helper could not read. Try again later.".into(),
                    );
                }
                return;
            }
        },
        Err(error) => {
            tracing::debug!(%error, "GitHub release check failed");
            if force {
                show_manual_notice(
                    app,
                    "Could not check for updates",
                    "Check your internet connection and try again.".into(),
                );
            }
            return;
        }
    };

    state.last_successful_check = Some(now);
    let current = Version::parse(env!("CARGO_PKG_VERSION"));
    let latest = Version::parse(release.tag_name.trim_start_matches('v'));
    let (Ok(current), Ok(latest)) = (current, latest) else {
        tracing::warn!(tag = %release.tag_name, "release version is not valid semantic versioning");
        write_state(&state_path, &state);
        if force {
            show_manual_notice(
                app,
                "Could not check for updates",
                "The latest release has an invalid version number. Try again later.".into(),
            );
        }
        return;
    };
    if release.draft || release.prerelease || latest <= current {
        write_state(&state_path, &state);
        if force {
            show_manual_notice(
                app,
                "AI Notetaker is up to date",
                "You have the latest stable version.".into(),
            );
        }
        return;
    }

    let version = latest.to_string();
    let already_prompted = state.prompted_versions.contains(&version);
    write_state(&state_path, &state);
    if already_prompted && !force {
        return;
    }

    state.prompted_versions.insert(version.clone());
    write_state(&state_path, &state);
    app.dialog()
        .message(format!(
            "AI Notetaker {version} is available. Open the official GitHub release page to review the notes and download the update? The helper will not download or install anything automatically."
        ))
        .title("AI Notetaker update available")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Open release page".into(),
            "Not now".into(),
        ))
        .show(move |accepted| {
            if accepted {
                crate::tray::open_release_page();
            }
        });
}

fn show_manual_notice<R: Runtime>(app: &AppHandle<R>, title: &str, message: String) {
    app.dialog().message(message).title(title).show(|_| {});
}

fn read_state(path: &Path) -> CheckState {
    match std::fs::read(path) {
        Ok(contents) => serde_json::from_slice(&contents).unwrap_or_default(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => CheckState::default(),
        Err(error) => {
            tracing::debug!(?path, %error, "could not read update-check state");
            CheckState::default()
        }
    }
}

fn write_state(path: &Path, state: &CheckState) {
    let temp_path = temporary_path(path);
    let result = (|| -> std::io::Result<()> {
        let contents = serde_json::to_vec(state).map_err(std::io::Error::other)?;
        #[cfg(unix)]
        {
            use std::io::Write;
            use std::os::unix::fs::OpenOptionsExt;
            std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(&temp_path)?
                .write_all(&contents)?;
        }
        #[cfg(not(unix))]
        std::fs::write(&temp_path, contents)?;
        // std's rename replaces an existing file on every platform, so a crash can never
        // leave the state missing between a remove and a rename.
        std::fs::rename(&temp_path, path)
    })();
    if let Err(error) = result {
        tracing::debug!(?path, %error, "could not persist update-check state");
        let _ = std::fs::remove_file(temp_path);
    }
}

fn temporary_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".tmp");
    PathBuf::from(name)
}
