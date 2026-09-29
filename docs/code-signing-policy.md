# Native download and trust policy

AI Notetaker publishes native helper installers directly through GitHub
Releases. The current budget decision is to publish unsigned artifacts rather
than pay for Apple Developer Program signing/notarization or Windows
Authenticode certificates.

## What checksums mean

Every release publishes a `SHA256SUMS` file. A matching SHA-256 confirms that a
download has the same bytes as the file listed in that release. It does not
identify the publisher, prove that the program is safe, or replace OS code
signing. The manifest marks unsigned artifacts as `unsigned`.

## First-open warnings

- **macOS:** open the app from Finder with Control-click → **Open**, then
  confirm. This approves that app only. Never tell users to remove quarantine
  attributes or disable Gatekeeper globally.
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
