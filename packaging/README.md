# Native desktop app installers

The release workflow publishes versioned AI Notetaker desktop app installers
directly to GitHub Releases. This folder contains assets required to build
those installers; it does not define external package-manager channels.
macOS releases provide separate Apple silicon (arm64) and Intel (x86_64)
guided DMGs. Windows and Debian/Ubuntu releases target x86_64.

- `windows/` contains the checksum-pinned base VB-CABLE fetch script and its
  attribution/setup notes. The installer launches the vendor setup visibly.
- The Debian package includes a Native Messaging relay only for existing
  extension users during migration and declares the PulseAudio/PipeWire
  command-line dependency. New desktop users do not need a browser extension.
- `macos/` seals the completed app with a free ad-hoc signature and packages
  the guided installer. Native Messaging registration remains for legacy
  extension compatibility. This is not Developer ID signing or notarization.

See [`../docs/helper-packaging.md`](../docs/helper-packaging.md) for build and
installer details, and [`../release/README.md`](../release/README.md) for the
direct-download release contract.
