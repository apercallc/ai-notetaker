# Native Messaging Host Manifest

`com.ainotetaker.helper.json.template` is the Chrome Native Messaging host
manifest for this project (see `docs/native-messaging-protocol.md`). It's a
`.template` file, not the real manifest: `__NM_HOST_BINARY_PATH__` must be
replaced with the absolute path to the installed `notetaker-nm-host` binary
before it's placed where Chrome actually looks for it. The Tauri and
cargo-deb packages include this template as an installer input. The Debian
and Windows installers generate a concrete manifest from the installed relay
path; macOS bundles guarded install/uninstall helper scripts because a DMG has
no post-install hook. See `docs/helper-packaging.md` for the package flows.

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
Chrome refuses to launch the host at all. Edge and Brave use this exact
same manifest shape and extension ID — they're Chromium-based and read
`allowed_origins` the same way; only their manifest *location* differs
(see `docs/superpowers/specs/2026-09-22-cross-browser-ports-design.md`).

## Firefox: `com.ainotetaker.helper.firefox.json.template`

Firefox's Native Messaging manifest shape is structurally different, not
just a different install location:

- The key is `allowed_extensions` (an array of extension IDs), not
  `allowed_origins` (an array of `chrome-extension://` URLs).
- Firefox has no `manifest.json` `key`-derived ID like Chrome. It needs an
  explicit, permanent `browser_specific_settings.gecko.id` — this project
  uses `notetaker@apercallc.dev` (see `extension/manifest.json`). Like the
  Chrome `key`, this must never be regenerated casually once real users
  depend on it.

### Where Firefox looks for it, per OS

- **macOS**: `~/Library/Application Support/Mozilla/NativeMessagingHosts/com.ainotetaker.helper.json`
- **Linux** (system-wide, matching this package's Debian install pattern):
  `/usr/lib/mozilla/native-messaging-hosts/com.ainotetaker.helper.json`
- **Windows**: registry key
  `HKEY_CURRENT_USER\Software\Mozilla\NativeMessagingHosts\com.ainotetaker.helper`
  whose default value is the path to a manifest JSON file.
