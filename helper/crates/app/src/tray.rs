//! Native system-tray menu for the persistent helper.
//!
//! The helper has no main window. Tauri owns the process main thread, while
//! this module keeps the menu small and platform-native: status first, recent
//! notes next, an explicit opt-in launch-at-login action, and quit last.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Runtime};

const TRAY_ID: &str = "ai-notetaker-tray";

pub struct TrayController<R: Runtime = tauri::Wry> {
    status: MenuItem<R>,
    tray: TrayIcon<R>,
}

impl<R: Runtime> TrayController<R> {
    pub fn set_recording(&self, recording: bool) {
        let label = if recording {
            "Status: Recording"
        } else {
            "Status: Idle"
        };
        let tooltip = if recording {
            "AI Notetaker — Recording"
        } else {
            "AI Notetaker — Idle"
        };
        let _ = self.status.set_text(label);
        let _ = self.tray.set_tooltip(Some(tooltip));
    }
}

pub fn initialize<R: Runtime>(
    app: &AppHandle<R>,
    data_dir: PathBuf,
) -> Result<Arc<TrayController<R>>, Box<dyn std::error::Error>> {
    let status = MenuItem::with_id(app, "status", "Status: Idle", false, None::<&str>)?;
    let open_latest =
        MenuItem::with_id(app, "open-latest", "Open Latest Note", true, None::<&str>)?;
    let open_folder =
        MenuItem::with_id(app, "open-folder", "Open Notes Folder", true, None::<&str>)?;
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
        &[&status, &open_latest, &open_folder, &launch_at_login, &quit],
    )?;

    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("AI Notetaker — Idle")
        .icon(
            app.default_window_icon()
                .cloned()
                .ok_or("default tray icon is missing")?,
        )
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "open-latest" => open_latest_note(&data_dir),
            "open-folder" => {
                let _ = open_with_default_app(&data_dir.join("meetings"));
            }
            "launch-at-login" => toggle_autostart(app, &launch_at_login),
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    Ok(Arc::new(TrayController { status, tray }))
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
        Command::new("cmd")
            .args(["/C", "start", "", &path.to_string_lossy()])
            .spawn()?;
    }
    Ok(())
}
