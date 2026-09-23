# AI Notetaker helper packaging

The helper is a tray-only Tauri v2 application. `notetaker-helper` owns the
persistent capture/pipeline process; `notetaker-nm-host` remains a separate,
Tauri-free Native Messaging relay that Chrome starts per connection. The
placeholder icon set under `helper/crates/app/icons/` was generated from
`placeholder.svg`; replace it with real branding art before release.

For the user path, start with [`docs/getting-started.md`](getting-started.md).
This document is the packaging and uninstall reference. A raw `cargo build`
does not register the Native Messaging manifest, so a source build is not
complete until the package is installed or the manifest is registered
manually.

## Build artifacts

From `helper/crates/app/`:

```sh
npx --yes @tauri-apps/cli@latest build --bundles deb,appimage
```

The Tauri configuration also declares macOS `dmg` and Windows `msi`/`nsis`
bundles. A Debian package can also be produced from the checked-in
`package.metadata.deb` after installing `cargo-deb`:

```sh
cargo install cargo-deb
cargo deb --manifest-path helper/crates/app/Cargo.toml
```

## End-user distribution channels

When a release is published, use the native artifact for the operating system
or the package-manager channel below. All channels install the same helper and
Native Messaging relay; they do not install the Chrome extension.

```sh
# macOS
brew install --cask ai-notetaker

# Windows PowerShell
winget install AI-Notetaker
# Chocolatey is also supported: choco install ai-notetaker
```

Linux users should install the signed `.deb` from the release page. The
AppImage is a fallback for distributions that cannot use the Debian package,
but it cannot safely register a Native Messaging relay inside a transient
mount, so the `.deb` or an explicit stable-path registration is preferred.

Package-manager packages are pinned to a release URL and SHA-256; they must
never fetch a floating “latest” binary during installation. Update a
package-managed helper with its package manager. Direct-download installs use
the Tauri updater once release signing and the owner-controlled updater key
are configured.

Linux CI installs the Tauri v2 WebKitGTK, GTK, Ayatana AppIndicator, and
librsvg development packages in addition to the ALSA headers.

Windows release builds stage only the base VB-CABLE archive after verifying the
release owner's `VB_CABLE_SHA256` repository variable. The helper launches the
official setup visibly with the normal administrator prompt; it does not fetch
or silently install a floating driver. The user may need to reboot before the
device is enumerated. Attribution to [VB-Audio](https://vb-audio.com/Cable/)
and the donation option must remain visible. A+B/C+D packages are never
included.

## Native Messaging installer registration

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
- macOS DMG has no post-install hook. The app bundles
  `Contents/Resources/scripts/install-native-messaging.sh` and its guarded
  uninstall counterpart. Run the installer helper after copying the app to
  `/Applications` (or pass the actual `.app` path) so it can write the
  per-user Chrome, Edge, Brave, and Firefox manifests, for example:
  `sh "/Applications/AI Notetaker.app/Contents/Resources/scripts/install-native-messaging.sh"`.
- See `docs/superpowers/specs/2026-09-22-cross-browser-ports-design.md` for
  why Firefox needs a structurally different manifest (`allowed_extensions`
  with a permanent gecko ID, not `allowed_origins` with a
  `chrome-extension://` URL) instead of just another directory.

AppImages are portable artifacts and cannot safely point Chrome at a relay
inside a transient AppImage mount; use the Debian package for automatic Linux
registration, or perform an explicit manual install with a stable extracted
relay path.

## Updater signing

The updater plugin and endpoint shape are wired, but the public key and
endpoint in `tauri.conf.json` are placeholders. Artifact generation is
disabled until the owner supplies a real signing key; enable
`bundle.createUpdaterArtifacts` only in the release configuration after
generating and protecting the key pair:

```sh
npx --yes @tauri-apps/cli@latest signer generate -w ~/.tauri/ai-notetaker.key
```

Only the owner may replace `REPLACE_WITH_OWNER_GENERATED_TAURI_UPDATER_PUBLIC_KEY`,
choose the real HTTPS endpoint, and publish artifacts with
`TAURI_SIGNING_PRIVATE_KEY`. Never commit the private key or claim updater
release proof from a local compile.

## Uninstall

Before uninstalling, stop a recording and quit the helper. Remove the Chrome
Native Messaging manifest and the helper's local data if you want a clean
reset. Local data includes raw mic/speaker PCM, transcripts, summaries,
pairing state, and retry queues; copy it first if it must be kept.

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

## Release-only prerequisites

macOS Developer ID signing/notarization, Windows Authenticode signing,
macOS installer-helper execution, updater key generation, and uninstall runs
on each native OS remain release-owner validation. The Linux build and config
are locally compilable here; that is not proof of macOS/Windows signing or
hardware audio behavior.
