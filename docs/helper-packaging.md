# AI Notetaker helper packaging

The helper is a tray-only Tauri v2 application. `notetaker-helper` owns the
persistent capture/pipeline process; `notetaker-nm-host` remains a separate,
Tauri-free Native Messaging relay that Chrome starts per connection. The
placeholder icon set under `helper/crates/app/icons/` was generated from
`placeholder.svg`; replace it with real branding art before release.

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

Linux CI installs the Tauri v2 WebKitGTK, GTK, Ayatana AppIndicator, and
librsvg development packages in addition to the ALSA headers.

The packaged Native Messaging template still contains
`__NM_HOST_BINARY_PATH__`. Each installer must replace that token with the
absolute installed path to `notetaker-nm-host`, install the manifest in the
Chrome location for that OS, and register the Windows per-user registry key.
That final installer registration is intentionally not faked by a local build.

## Updater signing

The updater plugin and artifact configuration are wired, but the public key
and endpoint in `tauri.conf.json` are placeholders. The owner must generate
and protect the key pair:

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
or remove the AppImage. Then remove the manifest from
`~/.config/google-chrome/NativeMessagingHosts/com.ainotetaker.helper.json`
(and the Chromium-equivalent directory) and `~/.local/share/ai-notetaker`.

The helper creates standard PulseAudio/PipeWire modules rather than a custom
driver. To remove them cleanly, inspect `pactl list short modules` and unload
the entries whose arguments contain `notetaker_sink`, `notetaker_mic`, or the
associated `module-loopback`; the exact numeric module IDs are session-local.
Restarting the user audio session removes any remaining transient modules.

### macOS

Remove **AI Notetaker** from Applications, delete
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

Uninstall **AI Notetaker** from Installed apps, then remove
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

macOS Developer ID signing/notarization, Windows Authenticode signing, real
Native Messaging registration, updater key generation, and uninstall runs on
each native OS remain release-owner validation. The Linux build and config
are locally compilable here; that is not proof of macOS/Windows signing or
hardware audio behavior.
