# Native installer assets

The release workflow publishes versioned helper installers directly to GitHub
Releases. This folder contains assets required to build those installers; it
does not define external package-manager channels.

- `windows/` contains the checksum-pinned base VB-CABLE fetch script and its
  attribution/setup notes. The installer launches the vendor setup visibly.
- The Debian package registers a stable Chrome Native Messaging relay and
  declares the PulseAudio/PipeWire command-line dependency.
- The macOS DMG includes guarded Native Messaging install/uninstall scripts.

See [`../docs/helper-packaging.md`](../docs/helper-packaging.md) for build and
installer details, and [`../release/README.md`](../release/README.md) for the
direct-download release contract.
