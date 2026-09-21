# Native Messaging Host Manifest

`com.ainotetaker.helper.json.template` is the Chrome Native Messaging host
manifest for this project (see `docs/native-messaging-protocol.md`). It's a
`.template` file, not the real manifest: `__NM_HOST_BINARY_PATH__` must be
replaced with the absolute path to the installed `notetaker-nm-host` binary
before it's placed where Chrome actually looks for it. The Tauri/cargo-deb
packages include this template as an installer input; final per-OS
substitution, placement, and Windows registry registration remain installer
work and must not be claimed from a local build.

## Where Chrome looks for it, per OS

- **macOS**: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.ainotetaker.helper.json`
- **Linux**: `~/.config/google-chrome/NativeMessagingHosts/com.ainotetaker.helper.json`
  (or the Chromium-equivalent path for other Chromium-based browsers)
- **Windows**: not a fixed directory — a registry key
  `HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\com.ainotetaker.helper`
  whose default value is the *path to* a manifest JSON file (which can live
  anywhere the installer chooses, e.g. alongside the installed binaries).

## `allowed_origins`

Locked to `chrome-extension://jidooookkdbbbhkkdmcajnnnhhphodok/` — the
extension ID derived from the committed `manifest.json` `key` field (see
the architecture spec §3.2 and `extension/CLAUDE.md`). This must never be
regenerated independently of that key; the two have to match exactly or
Chrome refuses to launch the host at all.
