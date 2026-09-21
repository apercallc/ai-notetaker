//! Tray icon / menu UI.
//!
//! **Not fully wired in this pass — flagged rather than faked.** A real
//! Tauri tray icon needs `tauri::Builder::default().run(tauri::generate_context!())`
//! to be the blocking call on the process's actual main thread (a hard
//! platform requirement on macOS specifically, since Cocoa GUI code must
//! run on thread 0), which in turn needs `tauri.conf.json`, app icons, and
//! `build.rs` wired up via `tauri-build` — none of which exist yet.
//!
//! The correct integration shape, to implement next: invert control so
//! `main()` is a plain (non-`#[tokio::main]`) function whose body is the
//! Tauri builder's `.run(...)` call, and start the IPC server
//! (`ipc::run_ipc_server`, currently driven directly from `main()`) inside
//! Tauri's `.setup()` hook via `tauri::async_runtime::spawn(...)` instead —
//! Tauri's async runtime supports exactly this pattern. Per-OS menu
//! contents/icons should follow the native idioms called out in
//! `.claude/skills/notetaker-design-review/SKILL.md` (macOS menu bar
//! conventions + SF Symbols, Windows 11 Fluent tray conventions, each
//! desktop environment's native tray idiom on Linux).
//!
//! Until that refactor lands, the helper runs headless (no tray icon, but
//! the IPC server and pipeline are fully functional) — acceptable for
//! development and testing, not for a real release.

pub fn spawn_tray_icon() {
    tracing::info!("tray icon not yet wired — see tray.rs doc comment for the integration plan");
}
