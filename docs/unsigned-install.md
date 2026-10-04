# Installing an unsigned development build

This page covers local source builds of the Tauri desktop app. New users run
setup, recording, and local notes in that app; no browser extension is needed.
See [`code-signing-policy.md`](code-signing-policy.md) for release first-open
steps and checksum limits.

## Linux

Build the helper from a checkout, then install the generated Debian package:

```sh
cd helper
cargo deb --manifest-path crates/app/Cargo.toml
sudo apt install ./target/debian/notetaker-app_0.1.0-1_amd64.deb
```

The package declares `pulseaudio-utils` for `pactl`/`parec`. It also retains
the Native Messaging relay for existing extension users; new desktop use does
not require browser registration or an extension. For development of the
legacy extension path, load `extension/dist` separately.

## macOS

Open the locally built `.app` from Finder. macOS may show an unidentified
developer warning for an unsigned build. Only bypass that warning for a build
whose source and checksum you have inspected: Control-click the app, choose
**Open**, and confirm the warning. Desktop recording works without Native
Messaging. Existing extension users who need to reconnect the browser bridge
can run the bundled installer after copying the app to `/Applications`:

```sh
sh "/Applications/AI Notetaker.app/Contents/Resources/scripts/install-native-messaging.sh"
```

Unsigned builds do not provide an Apple Developer ID or notarization claim.

## Windows

Run the locally built MSI/NSIS installer only if you trust the checkout and
have verified its checksum. Windows SmartScreen warnings are expected for an
unsigned build. Do not disable SmartScreen globally; use the installer’s
per-file **More info → Run anyway** path only for this test build.

Do not treat a checksum as proof of publisher identity. Only install source
builds you created or whose source you have independently reviewed.
