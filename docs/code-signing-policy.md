# Native download and trust policy

AI Notetaker publishes native helper installers directly through GitHub
Releases. The current budget decision is to publish unsigned artifacts rather
than pay for Apple Developer Program signing/notarization or Windows
Authenticode certificates. Mac bundles now receive a complete ad-hoc code
signature (free) before packaging. This seals their contents but does not
authenticate Aperca or provide Apple notarization.

## What checksums mean

Every release publishes a `SHA256SUMS` file. A matching SHA-256 confirms that a
download has the same bytes as the file listed in that release. It does not
identify the publisher, prove that the program is safe, or replace OS code
signing. The manifest marks unsigned artifacts as `unsigned`.

## First-open warnings

- **macOS guided installer:** open a DMG whose name ends in
  `-installer.dmg`, double-click **Install AI Notetaker.command**. macOS blocks it
  the first time ("Not Opened", only Cancel and Move to Trash): choose Cancel,
  approve it in **System Settings → Privacy & Security → Open Anyway**, then
  run it again and choose **Install**. It verifies the bundle, copies the app to Applications, removes
  the download quarantine from that app only after explicit approval, registers
  the browser connection, and opens the menu bar app. No sudo, driver, or
  global Gatekeeper change is used. Device
  management policies may require administrator approval; this is not a
  guaranteed warning-free substitute for notarization.
- **Windows:** check that the installer came from the official GitHub release
  and compare its SHA-256. If SmartScreen appears, use **More info → Run
  anyway** only for that file. Never disable SmartScreen globally.
- **Linux:** open the downloaded `.deb` in Software Install or use the system
  installer prompt; compare its checksum with the same release's
  `SHA256SUMS` if desired.

Do not claim a release is signed or notarized because a local build succeeded.
If signing is adopted later, update the release manifest from verified native
signature checks and revise this policy before changing public copy.

## Verification record

For each release, retain the GitHub Actions run, release manifest,
`SHA256SUMS`, and manual installation results on the target operating systems.
Report build, checksum, signing, and live-device evidence separately.


## Older Mac downloads: “damaged and can’t be opened”

The v0.15.0 Mac release was packaged with a linker-only executable signature.
It passes the published DMG checksum but fails `codesign --verify --deep
--strict` because the completed app resources were never sealed. Redownloading
that same release does not correct the defect.

Prefer the guided installer included with current releases. For an older build
you trust from our official GitHub release, compare the downloaded DMG's
SHA-256 with its release's `SHA256SUMS` before repairing it. A checksum is not
publisher identity.
Quit AI Notetaker before repairing; keep your recordings and settings.

For a copy installed at `/Applications/AI Notetaker.app`, run these in Terminal
in order, stopping if any command fails:

```sh
codesign --force --sign - "/Applications/AI Notetaker.app/Contents/MacOS/notetaker-nm-host"
codesign --force --sign - "/Applications/AI Notetaker.app"
codesign --verify --deep --strict "/Applications/AI Notetaker.app"
xattr -dr com.apple.quarantine "/Applications/AI Notetaker.app"
sh "/Applications/AI Notetaker.app/Contents/Resources/scripts/install-native-messaging.sh"
open "/Applications/AI Notetaker.app"
```

This is an explicit exception for this verified app, not a general fix for
untrusted or modified downloads. Never disable Gatekeeper globally, remove
all extended attributes, or recursively change other applications. Ad-hoc
re-signing does not notarize the app.

Apple describes the standard first-open approval in
[Open apps safely on your Mac](https://support.apple.com/102445). The fully
trusted distribution path remains Developer ID signing and notarization.
