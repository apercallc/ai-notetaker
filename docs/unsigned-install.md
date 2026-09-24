# Installing an unsigned development build

Unsigned native artifacts are for maintainers and testers only. Prefer the
signed release installer or the package-manager channel once a public release
is available; signing lets the operating system verify where the binary came
from.

## Linux

Build the helper from a checkout, then install the generated Debian package:

```sh
cd helper
cargo deb --manifest-path crates/app/Cargo.toml
sudo apt install ./target/debian/notetaker-app_0.1.0-1_amd64.deb
```

The package installs the Native Messaging relay and declares
`pulseaudio-utils` for `pactl`/`parec`. The extension still must be loaded
separately from `extension/dist` for development.

## macOS

Open the locally built `.app` from Finder. macOS may show an unidentified
developer warning for an unsigned build. Only bypass that warning for a build
whose source and checksum you have inspected: Control-click the app, choose
**Open**, and confirm the warning. Run the bundled Native Messaging installer
after copying the app to `/Applications`:

```sh
sh "/Applications/AI Notetaker.app/Contents/Resources/scripts/install-native-messaging.sh"
```

Unsigned builds do not provide an Apple Developer ID or notarization claim.

## Windows

Run the locally built MSI/NSIS installer only if you trust the checkout and
have verified its checksum. Windows SmartScreen warnings are expected for an
unsigned build. Do not disable SmartScreen globally; use the installer’s
per-file **More info → Run anyway** path only for this test build.

Unsigned development artifacts must never be presented as the public release,
and they must not be used to set `RELEASE_SIGNING_CONFIRMED=true`.
