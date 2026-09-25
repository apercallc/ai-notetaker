//! OS notifications for recording start/stop/errors, with no extra plugin:
//! each platform's own notifier is invoked as a short-lived child process.
//!
//! Notifications are best-effort by design. A missing `notify-send` (a
//! headless Linux box) or a Focus mode that swallows the toast must never
//! affect recording, so failures are logged and otherwise ignored. That is
//! also why the tray does not depend on them: the tray tooltip/state carry
//! the same information.

use std::collections::HashMap;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const APP_NAME: &str = "AI Notetaker";
/// The same message for the same key is shown at most this often.
const DEDUPE_WINDOW: Duration = Duration::from_secs(60);

/// A process invocation, kept as data so it can be unit-tested on any OS.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotificationCommand {
    pub program: String,
    pub args: Vec<String>,
    /// Text passed through the environment instead of the command line, for
    /// interpreters (PowerShell) where quoting user text would be an
    /// injection risk.
    pub envs: Vec<(String, String)>,
}

pub fn linux_command(title: &str, body: &str) -> NotificationCommand {
    NotificationCommand {
        program: "notify-send".into(),
        args: vec![
            "--app-name".into(),
            APP_NAME.into(),
            "--".into(),
            title.into(),
            body.into(),
        ],
        envs: vec![],
    }
}

fn applescript_string(text: &str) -> String {
    let escaped: String = text
        .chars()
        .map(|c| match c {
            '\\' => "\\\\".to_string(),
            '"' => "\\\"".to_string(),
            '\n' | '\r' => " ".to_string(),
            c => c.to_string(),
        })
        .collect();
    format!("\"{escaped}\"")
}

pub fn macos_command(title: &str, body: &str) -> NotificationCommand {
    NotificationCommand {
        program: "osascript".into(),
        args: vec![
            "-e".into(),
            format!(
                "display notification {} with title {}",
                applescript_string(body),
                applescript_string(title)
            ),
        ],
        envs: vec![],
    }
}

pub fn windows_command(title: &str, body: &str) -> NotificationCommand {
    // The notifier id is Windows PowerShell's own AppUserModelID: a toast from
    // an unregistered id is silently dropped, and the installer does not
    // create a Start-menu shortcut that would register ours.
    const SCRIPT: &str = "\
$ErrorActionPreference = 'Stop';\
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;\
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);\
$text = $xml.GetElementsByTagName('text');\
$text.Item(0).AppendChild($xml.CreateTextNode($env:NOTETAKER_TOAST_TITLE)) | Out-Null;\
$text.Item(1).AppendChild($xml.CreateTextNode($env:NOTETAKER_TOAST_BODY)) | Out-Null;\
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml);\
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($toast)";
    NotificationCommand {
        program: "powershell.exe".into(),
        args: vec![
            "-NoProfile".into(),
            "-NonInteractive".into(),
            "-WindowStyle".into(),
            "Hidden".into(),
            "-Command".into(),
            SCRIPT.into(),
        ],
        envs: vec![
            ("NOTETAKER_TOAST_TITLE".into(), title.into()),
            ("NOTETAKER_TOAST_BODY".into(), body.into()),
        ],
    }
}

fn command_for_this_os(title: &str, body: &str) -> NotificationCommand {
    if cfg!(target_os = "macos") {
        macos_command(title, body)
    } else if cfg!(target_os = "windows") {
        windows_command(title, body)
    } else {
        linux_command(title, body)
    }
}

#[derive(Default)]
pub struct Notifier {
    last_shown: Mutex<HashMap<String, Instant>>,
}

impl Notifier {
    /// Shows a notification now.
    pub fn notify(&self, title: &str, body: &str) {
        spawn(command_for_this_os(title, body));
    }

    /// Shows a notification unless the same `key` was shown within the last
    /// minute — errors repeat (a flapping provider, a disk that stays full)
    /// and a stream of identical toasts is worse than none.
    pub fn notify_deduped(&self, key: &str, title: &str, body: &str) {
        if self.should_show(key, Instant::now()) {
            self.notify(title, body);
        }
    }

    fn should_show(&self, key: &str, now: Instant) -> bool {
        let mut last = self.last_shown.lock().unwrap_or_else(|p| p.into_inner());
        if last
            .get(key)
            .is_some_and(|shown| now.duration_since(*shown) < DEDUPE_WINDOW)
        {
            return false;
        }
        last.insert(key.to_string(), now);
        true
    }
}

fn spawn(spec: NotificationCommand) {
    let mut command = Command::new(&spec.program);
    command
        .args(&spec.args)
        .envs(spec.envs.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    match command.spawn() {
        Ok(mut child) => {
            // Reap it off-thread so a notifier that lingers cannot zombie.
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        }
        Err(error) => tracing::debug!(program = %spec.program, %error, "notification not shown"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linux_passes_text_as_arguments_after_a_double_dash() {
        let command = linux_command("-Recording", "started; rm -rf ~");
        assert_eq!(command.program, "notify-send");
        let dash = command.args.iter().position(|arg| arg == "--").unwrap();
        assert_eq!(command.args[dash + 1], "-Recording");
        assert_eq!(command.args[dash + 2], "started; rm -rf ~");
    }

    #[test]
    fn applescript_text_cannot_break_out_of_its_string() {
        let command = macos_command("a\"b", "c\\\" & do shell script \"x\nnext");
        let script = &command.args[1];
        assert_eq!(command.program, "osascript");
        assert_eq!(
            script,
            "display notification \"c\\\\\\\" & do shell script \\\"x next\" with title \"a\\\"b\""
        );
    }

    #[test]
    fn windows_text_travels_in_the_environment_never_in_the_script() {
        let command = windows_command("Title", "it's $(calc)");
        assert!(!command.args.iter().any(|arg| arg.contains("calc")));
        assert!(command.envs.contains(&(
            "NOTETAKER_TOAST_BODY".to_string(),
            "it's $(calc)".to_string()
        )));
    }

    #[test]
    fn identical_notifications_are_rate_limited_but_others_are_not() {
        let notifier = Notifier::default();
        let start = Instant::now();
        assert!(notifier.should_show("disk-full", start));
        assert!(!notifier.should_show("disk-full", start + Duration::from_secs(5)));
        assert!(notifier.should_show("other", start + Duration::from_secs(5)));
        assert!(notifier.should_show("disk-full", start + DEDUPE_WINDOW));
    }
}
