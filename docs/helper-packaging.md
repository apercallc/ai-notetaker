# AI Notetaker desktop app packaging

AI Notetaker is a Tauri v2 desktop app with a primary setup, recording, and
notes window plus a tray for status and quick actions. `notetaker-helper` owns
the persistent capture/pipeline process. `notetaker-nm-host` remains a separate,
Tauri-free Native Messaging relay only for existing extension users during
migration. New desktop use does not require Chrome or Native Messaging.
Rebuild the platform icon files with `python3 scripts/generate-brand-icons.py`.

For the user path, start with [`docs/getting-started.md`](getting-started.md).
This document is the packaging and uninstall reference. A raw `cargo build`
can run the desktop app directly. Register Native Messaging only when an
existing extension installation still needs the legacy browser bridge.

## Build artifacts

From `helper/crates/app/`:

```sh
npx --yes @tauri-apps/cli@2.11.5 build --bundles deb,appimage
```

The Tauri configuration also declares macOS `dmg` and Windows `msi`/`nsis`
bundles. A Debian package can also be produced from the checked-in
`package.metadata.deb` after installing `cargo-deb`:

```sh
cargo install cargo-deb
cargo deb --manifest-path helper/crates/app/Cargo.toml
```

## End-user downloads

Users download the matching installer from the [AI Notetaker install
page](https://ai-notetaker.apercallc.com/download) or the [latest GitHub
release](https://github.com/apercallc/ai-notetaker/releases/latest). The
The desktop-first target set is Apple silicon and Intel Mac, Windows 64-bit
(x86_64), and Debian/Ubuntu Linux 64-bit (x86_64). Mac builds use separate
arm64 and x86_64 guided DMGs. The guided Mac DMGs and Windows installer are
unsigned; Linux uses a `.deb`. The release manifest and `SHA256SUMS` describe
the exact files in a published desktop-first release.
Older helper-only releases still require the browser extension and are not the
new-user install path.

The Debian package depends on `pulseaudio-utils`, which supplies `pactl` for
audio setup/probing and `parec` for monitor capture. AppImage remains a CI
bundle, but is not currently a published primary download; the desktop app
does not require a stable Chrome Native Messaging path.

The desktop app checks for a newer stable GitHub release daily and asks before
opening the official release page. It never downloads or installs an update
automatically. Users can also choose **Check for Updates…** from the tray
menu. This keeps updates available without requiring a Tauri updater signing
key or endpoint.

The release workflow uploads native installers, the Chrome extension ZIP,
manifest, and `SHA256SUMS`; it does not publish Homebrew, WinGet, or Chocolatey
packages.

Linux CI installs the Tauri v2 WebKitGTK, GTK, Ayatana AppIndicator, and
librsvg development packages in addition to the ALSA headers.

Windows release builds stage only the base VB-CABLE archive after verifying the
release owner's `VB_CABLE_SHA256` repository variable. The helper launches the
official setup visibly with the normal administrator prompt; it does not fetch
or silently install a floating driver. The user may need to reboot before the
device is enumerated. Attribution to [VB-Audio](https://vb-audio.com/Cable/)
and the donation option must remain visible. A+B/C+D packages are never
included.

## Legacy Native Messaging installer registration

This compatibility bridge is only for existing browser extension installs.
New users configure, capture, and manage local notes in the desktop app and do
not need browser registration.

The checked-in template remains useful for manual installs, but release
packages now register the real installed relay instead of shipping the token
unchanged:

- Debian packages run `scripts/debian/postinst` and `postrm`. They write the
  system-wide manifest to `/etc/opt/chrome/native-messaging-hosts/`,
  `/etc/chromium/native-messaging-hosts/`,
  `/etc/opt/microsoft/msedge/native-messaging-hosts/`, and
  `/etc/brave/native-messaging-hosts/` (Chrome, generic Chromium, Edge, and
  Brave), plus `/usr/lib/mozilla/native-messaging-hosts/` for Firefox using
  its separate `allowed_extensions`-shaped manifest, and only remove a
  manifest that still contains this extension's identity and
  `/usr/bin/notetaker-nm-host`.
- Windows NSIS runs `windows/hooks.nsh` after install and before uninstall.
  The PowerShell hooks write the Chromium-family manifest beside the
  installed binaries and register it under the per-user Chrome, Edge, and
  Brave keys (`HKCU\Software\{Google\Chrome,Microsoft\Edge,BraveSoftware\Brave-Browser}\NativeMessagingHosts\com.ainotetaker.helper`),
  plus a separate Firefox-shaped manifest under
  `HKCU\Software\Mozilla\NativeMessagingHosts\com.ainotetaker.helper`. They
  refuse to remove a changed or unrelated manifest.
- macOS guided DMGs (`-installer.dmg`) include **Install AI Notetaker.command**.
  It verifies the ad-hoc signed bundle, asks the user to approve this
  non-notarized app, copies it to Applications, clears only its quarantine,
  registers the browser connection and opens the app. It refuses to replace a
  running app or an unrelated bundle. Recordings and settings are untouched.
  Build with `packaging/macos/build-dmg.sh` after the Tauri `app` bundle.
- Older macOS DMGs have no post-install hook. The app bundles
  `Contents/Resources/scripts/install-native-messaging.sh` and its guarded
  uninstall counterpart. Run the installer helper after copying the app to
  `/Applications` (or pass the actual `.app` path) so it can write the
  per-user Chrome, Edge, Brave, and Firefox manifests, for example:
  `sh "/Applications/AI Notetaker.app/Contents/Resources/scripts/install-native-messaging.sh"`.
- See `docs/superpowers/specs/2026-09-22-cross-browser-ports-design.md` for
  why Firefox needs a structurally different manifest (`allowed_extensions`
  with a permanent gecko ID, not `allowed_origins` with a
  `chrome-extension://` URL) instead of just another directory.

The Debian package is the primary Linux download because it installs the
required `pulseaudio-utils` tools and can register the legacy browser bridge.
The desktop app itself does not depend on that registration. AppImage remains
available as a CI bundle, but is not currently a published primary download.

## Update behavior

The helper fetches the latest stable release metadata from GitHub at most once
per 24 hours. If the release is newer than the installed version, a native
yes/no prompt offers to open the fixed official GitHub Releases page. Accepting
opens the page; declining is remembered for that version. No executable,
installer, or update metadata is downloaded by the helper, and nothing is
installed in the background. **Check for Updates…** in the tray menu performs
an immediate check.

## Uninstall

Before uninstalling, stop notes and quit AI Notetaker. Remove the desktop
app's local data if you want a clean reset. For users who still use the legacy
extension, also remove its Native Messaging manifest. Local data includes raw
mic/speaker PCM, transcripts, summaries, and retry queues; copy it first if it
must be kept.

### Linux

Remove the `.deb` package (the exact package name may be shown by `dpkg -l`)
or remove the AppImage. The Debian maintainer script removes the two
system-wide manifests it owns. For an AppImage/manual install, remove
`~/.config/google-chrome/NativeMessagingHosts/com.ainotetaker.helper.json`
(and the Chromium-equivalent directory) and `~/.local/share/ai-notetaker`.

The helper creates standard PulseAudio/PipeWire modules rather than a custom
driver. To remove them cleanly, inspect `pactl list short modules` and unload
the entries whose arguments contain `notetaker_sink`, `notetaker_mic`, or the
associated `module-loopback`; the exact numeric module IDs are session-local.
Restarting the user audio session removes any remaining transient modules.

### macOS

Run the bundled `Contents/Resources/scripts/uninstall-native-messaging.sh`
helper before removing **AI Notetaker** from Applications (pass the `.app`
path if it is not in `/Applications`). Then delete
`~/Library/Application Support/ai-notetaker`, and remove
`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.ainotetaker.helper.json`.
If launch-at-login was enabled, disable it from the tray menu before
uninstalling or remove the app's LaunchAgent entry through macOS settings.

AI Notetaker never bundles BlackHole. Remove BlackHole with Existential
Audio's official uninstaller or its documented manual procedure:
[BlackHole uninstallation](https://github.com/ExistentialAudio/BlackHole/wiki/Uninstallation).
Do not delete an audio driver until Audio MIDI Setup and all audio apps are
closed.

### Windows

Uninstall **AI Notetaker** from Installed apps. The NSIS pre-uninstall hook
removes the manifest and per-user registry value only when they still point to
this installation. If the hook could not run, remove
`%LOCALAPPDATA%\ai-notetaker`, the installed Native Messaging manifest, and
the per-user registry value at
`HKCU\Software\Google\Chrome\NativeMessagingHosts\com.ainotetaker.helper`.

If base VB-CABLE was installed, remove it through Windows Installed apps or
Device Manager using VB-Audio's own uninstall flow, then reboot if Windows
requests it. AI Notetaker may bundle only base VB-CABLE; the installer must
keep visible attribution to [vb-cable.com](https://vb-audio.com/Cable/) and
the donation option. It must never silently remove unrelated A+B/C+D
variants.

## Signing and release acceptance

The budget release plan intentionally publishes unsigned artifacts and
documents the per-app macOS and per-file Windows prompts in
[`code-signing-policy.md`](code-signing-policy.md). Signing can be reconsidered
later, but release artifacts must not be labeled signed unless the actual
native signatures have been checked.

The generated Linux build and cross-platform CI do not prove Mac/Windows
installer behavior or physical-device audio capture. Verify installer launch,
permissions, capture, and uninstall on each target OS. Verify Native Messaging
registration separately only for the legacy extension path.
