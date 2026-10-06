# Installing an unsigned desktop preview

Published desktop preview installers and local Tauri builds are unsigned.
This page explains the operating-system warnings and checksum limits; a
checksum detects file corruption but does not verify the publisher. Install
only if you trust the release source or built the app yourself. See
[`code-signing-policy.md`](code-signing-policy.md) for release first-open
steps.

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

Approve the app once, with no Terminal commands: open **System Settings →
Privacy & Security**, scroll to **Security**, choose **Open Anyway** next to
AI Notetaker, and enter your password (macOS 13/14: Control-click the file and
choose **Open**). The guided installer's approval also clears the download
quarantine on the installed app, so the app itself does not prompt again.

Open the downloaded preview or locally built `.app` from Finder. macOS may show
an unidentified developer warning. Only bypass that warning for an artifact
from the official release page or a build whose source and checksum you have
inspected: Control-click the app, choose
**Open**, and confirm the warning. Desktop recording works without Native
Messaging. Existing extension users who need to reconnect the browser bridge
can run the bundled installer after copying the app to `/Applications`:

```sh
sh "/Applications/AI Notetaker.app/Contents/Resources/scripts/install-native-messaging.sh"
```

These unsigned installers do not provide an Apple Developer ID or notarization
claim.

## Windows

Run the preview installer only if you trust the official release and have
verified its checksum. It installs for the current user and needs no
administrator password. SmartScreen warnings are expected for an unsigned
installer: choose **More info → Run anyway**. Do not disable SmartScreen globally; use the installer’s
per-file **More info → Run anyway** path only for this preview.

Do not treat a checksum as proof of publisher identity. Only install preview
artifacts from the official release page or source builds you created or whose
source you have independently reviewed.
