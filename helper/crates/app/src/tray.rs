//! Native system-tray menu for the persistent helper.
//!
//! The helper has no main window. Tauri owns the process main thread, while
//! this module keeps the menu small and platform-native: status first, recent
//! notes next, an explicit opt-in launch-at-login action, and quit last.
//!
//! The icon is the recording consent cue: a red dot while capturing, a
//! neutral ring when idle, and an amber attention icon while recordings from
//! an interrupted session wait to be finished or discarded. macOS uses
//! template images for the non-recording states so they match the menu bar;
//! the recording dot deliberately stays a colored — not template — image so
//! it remains red everywhere.
//!
//! The tray is also optional. On a desktop where tray creation fails (no
//! system tray, a locked-down session), the helper keeps running headless
//! rather than abandoning capture: `initialize` never fails, it logs and
//! returns a controller whose updates simply have nowhere to go.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Runtime};

const TRAY_ID: &str = "ai-notetaker-tray";

// The tray states are pre-rendered by scripts/generate-tray-icons.py and
// embedded here at compile time, so a broken icon can never take the tray
// down at runtime and the binary has one less thing to locate on disk.
#[cfg(target_os = "macos")]
const IDLE_ICON: &[u8] = include_bytes!("../icons/tray/tray-idle-template.png");
#[cfg(target_os = "macos")]
const ATTENTION_ICON: &[u8] = include_bytes!("../icons/tray/tray-attention-template.png");
#[cfg(not(target_os = "macos"))]
const IDLE_ICON: &[u8] = include_bytes!("../icons/tray/tray-idle.png");
#[cfg(not(target_os = "macos"))]
const ATTENTION_ICON: &[u8] = include_bytes!("../icons/tray/tray-attention.png");
const RECORDING_ICON: &[u8] = include_bytes!("../icons/tray/tray-recording.png");

/// The tray states, in display priority order: an active recording always
/// wins over a pending recovery notice.
#[derive(Clone, Copy, PartialEq, Eq)]
enum TrayState {
    Idle,
    Recording,
    Attention,
}

struct TrayIcons {
    idle: Image<'static>,
    attention: Image<'static>,
    recording: Image<'static>,
}

/// Decodes an embedded PNG into the RGBA `tauri::image::Image` the tray
/// needs. Raw RGBA is used (rather than the window-icon pipeline) because the
/// tray API takes pixel data, and decoding here keeps the icon assets from
/// being tied to whatever icon format the bundler picked for the app icon.
fn decode_icon(bytes: &'static [u8]) -> Result<Image<'static>, Box<dyn std::error::Error>> {
    let decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    let mut reader = decoder.read_info()?;
    let mut rgba = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut rgba)?;
    Ok(Image::new_owned(rgba, info.width, info.height))
}

pub struct TrayController<R: Runtime = tauri::Wry> {
    /// `None` on a headless system: updates are accepted and dropped.
    status: Option<MenuItem<R>>,
    tray: Option<TrayIcon<R>>,
    icons: Option<TrayIcons>,
    recording: AtomicBool,
    attention: AtomicBool,
}

impl<R: Runtime> TrayController<R> {
    fn headless() -> Self {
        Self {
            status: None,
            tray: None,
            icons: None,
            recording: AtomicBool::new(false),
            attention: AtomicBool::new(false),
        }
    }

    pub fn set_recording(&self, recording: bool) {
        self.recording.store(recording, Ordering::Release);
        self.refresh();
    }

    /// Marks whether recordings from an interrupted session are waiting for
    /// the user to finish or discard them.
    pub fn set_attention(&self, attention: bool) {
        self.attention.store(attention, Ordering::Release);
        self.refresh();
    }

    fn refresh(&self) {
        let state = match (
            self.recording.load(Ordering::Acquire),
            self.attention.load(Ordering::Acquire),
        ) {
            (true, _) => TrayState::Recording,
            (false, true) => TrayState::Attention,
            (false, false) => TrayState::Idle,
        };
        if let Some(status) = &self.status {
            let _ = status.set_text(match state {
                TrayState::Idle => "Status: Idle",
                TrayState::Recording => "Status: Recording",
                TrayState::Attention => "Status: Recovered Recording",
            });
        }
        let Some(tray) = &self.tray else {
            return;
        };
        let _ = tray.set_tooltip(Some(match state {
            TrayState::Idle => "AI Notetaker — Idle",
            TrayState::Recording => "AI Notetaker — Recording",
            TrayState::Attention => "AI Notetaker — Recovered a recording",
        }));
        let Some(icons) = &self.icons else {
            return;
        };
        let (icon, is_template) = match state {
            TrayState::Idle => (&icons.idle, cfg!(target_os = "macos")),
            // The red dot is the consent cue; tinting it to match the menu
            // bar would erase exactly the distinction it exists to make.
            TrayState::Recording => (&icons.recording, false),
            TrayState::Attention => (&icons.attention, cfg!(target_os = "macos")),
        };
        let _ = tray.set_icon_as_template(is_template);
        let _ = tray.set_icon(Some(icon.clone()));
    }
}

/// Builds the tray, or logs and returns a headless controller. Startup must
/// never abort because the desktop has no tray.
pub fn initialize<R: Runtime>(app: &AppHandle<R>, data_dir: PathBuf) -> Arc<TrayController<R>> {
    match try_initialize(app, data_dir) {
        Ok(controller) => controller,
        Err(error) => {
            tracing::warn!("running without a tray: {error}");
            Arc::new(TrayController::headless())
        }
    }
}

fn try_initialize<R: Runtime>(
    app: &AppHandle<R>,
    data_dir: PathBuf,
) -> Result<Arc<TrayController<R>>, Box<dyn std::error::Error>> {
    let icons = TrayIcons {
        idle: decode_icon(IDLE_ICON)?,
        attention: decode_icon(ATTENTION_ICON)?,
        recording: decode_icon(RECORDING_ICON)?,
    };

    let status = MenuItem::with_id(app, "status", "Status: Idle", false, None::<&str>)?;
    let open_latest =
        MenuItem::with_id(app, "open-latest", "Open Latest Note", true, None::<&str>)?;
    let open_folder =
        MenuItem::with_id(app, "open-folder", "Open Notes Folder", true, None::<&str>)?;
    let open_logs = MenuItem::with_id(app, "open-logs", "Open Logs", true, None::<&str>)?;
    let pair_browser =
        MenuItem::with_id(app, "pair-browser", "Pair New Browser…", true, None::<&str>)?;
    let launch_at_login = MenuItem::with_id(
        app,
        "launch-at-login",
        "Launch at Login (Off)",
        true,
        None::<&str>,
    )?;
    let launch_label = {
        use tauri_plugin_autostart::ManagerExt;
        if app.autolaunch().is_enabled().unwrap_or(false) {
            "Launch at Login (On)"
        } else {
            "Launch at Login (Off)"
        }
    };
    launch_at_login.set_text(launch_label)?;
    let quit = MenuItem::with_id(app, "quit", "Quit AI Notetaker", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &status,
            &open_latest,
            &open_folder,
            &open_logs,
            &pair_browser,
            &launch_at_login,
            &quit,
        ],
    )?;

    let logs_dir = crate::logging::log_dir(&data_dir);
    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("AI Notetaker — Idle")
        .icon(icons.idle.clone())
        .icon_as_template(cfg!(target_os = "macos"))
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "open-latest" => open_latest_note(&data_dir),
            "open-folder" => {
                let _ = open_with_default_app(&data_dir.join("meetings"));
            }
            "open-logs" => {
                let _ = open_with_default_app(&logs_dir);
            }
            "pair-browser" => {
                // User-gesture re-pairing. The IPC layer cannot tell a fresh
                // Chrome profile that lost its token copy from a rogue
                // same-user process minting one, so reissue is only allowed
                // after this explicit menu action deletes the token file
                // (see `should_issue_pairing_token`). Deleting the file here
                // means the next hello takes the first-ever-pairing branch
                // and auto-mints a fresh token; the extension's reconnect
                // loop picks it up on its own.
                let path = crate::pairing_token_path(&data_dir);
                match std::fs::remove_file(&path) {
                    Ok(()) => tracing::info!(?path, "pairing token cleared for re-pairing"),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        // No token existed — the next hello auto-pairs anyway.
                    }
                    Err(error) => {
                        tracing::warn!(?path, %error, "could not clear pairing token");
                        crate::notify::Notifier::default().notify_deduped(
                            "pairing-reset-failed",
                            "AI Notetaker",
                            "Could not reset browser pairing. Check the logs.",
                        );
                    }
                }
            }
            "launch-at-login" => toggle_autostart(app, &launch_at_login),
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    Ok(Arc::new(TrayController {
        status: Some(status),
        tray: Some(tray),
        icons: Some(icons),
        recording: AtomicBool::new(false),
        attention: AtomicBool::new(false),
    }))
}

fn toggle_autostart<R: Runtime>(app: &AppHandle<R>, item: &MenuItem<R>) {
    use tauri_plugin_autostart::ManagerExt;

    let manager = app.autolaunch();
    let enabled = manager.is_enabled().unwrap_or(false);
    let result = if enabled {
        manager.disable()
    } else {
        manager.enable()
    };
    if result.is_ok() {
        let label = if enabled {
            "Launch at Login (Off)"
        } else {
            "Launch at Login (On)"
        };
        let _ = item.set_text(label);
    }
}

fn open_latest_note(data_dir: &Path) {
    let meetings_dir = data_dir.join("meetings");
    let latest = fs::read_dir(&meetings_dir)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .max_by_key(|entry| entry.metadata().and_then(|m| m.modified()).ok());

    let Some(entry) = latest else {
        let _ = open_with_default_app(&meetings_dir);
        return;
    };
    let dir = entry.path();
    let note = ["summary.json", "transcript.json", "meta.json"]
        .iter()
        .map(|name| dir.join(name))
        .find(|path| path.is_file())
        .unwrap_or(dir);
    let _ = open_with_default_app(&note);
}

fn open_with_default_app(path: &Path) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(path).spawn()?;
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open").arg(path).spawn()?;
    }
    #[cfg(target_os = "windows")]
    {
        // `cmd /C start` does not follow MSVC argument-quoting rules, so
        // std's automatic per-arg escaping (used by `args`) is wrong here:
        // a path containing spaces or cmd metacharacters (& ^ %) breaks the
        // start line. raw_arg hands cmd the exact line we built, with the
        // path explicitly quoted; the leading "" is start's title slot.
        use std::os::windows::process::CommandExt;
        Command::new("cmd")
            .raw_arg(format!(
                "/C start \"\" \"{}\"",
                path.to_string_lossy().replace('"', "")
            ))
            .spawn()?;
    }
    Ok(())
}
