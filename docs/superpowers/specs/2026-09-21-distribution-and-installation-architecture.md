# AI Notetaker — Distribution and Installation Architecture

Date: 2026-09-21
Status: Implemented architecture; native release-owner proof remains open

## Decision summary

AI Notetaker should ship as two related but independent installation tracks:

1. **Desktop capture track:** a signed Tauri helper installer plus the Chrome
   extension. This is the only supported path for recording meetings because
   it can install/register the Native Messaging relay and interact with the
   host audio system.
2. **History server track:** an optional Docker Compose deployment for the
   self-hosted webapp and Postgres. It stores finished notes only; it does not
   capture audio, run the helper, install the extension, or receive provider
   keys.

The installer website and onboarding wizard detect the user's apparent OS to
choose the right instructions, but the native installer remains responsible
for validating architecture and prerequisites. Browser-side OS detection is a
presentation hint, not permission to download or execute an installer
silently.

## User-facing install paths

### Recommended path: browser extension plus native helper

The public install page should present this sequence:

1. Install **AI Notetaker** from the Chrome Web Store.
2. Install the **AI Notetaker desktop helper** for the detected OS.
3. Launch the helper once. Its installer registers
   `com.ainotetaker.helper` for the fixed extension ID and starts the tray
   process.
4. Return to the extension. Native Messaging confirms the helper and reports
   platform, driver, microphone, and speaker readiness.
5. Complete audio setup and the provider-key test in the extension.
6. Optionally connect a user-owned webapp, either on Railway or through the
   Docker path below.

The extension is a companion to the helper, not an alternative implementation
of it. Chrome Web Store installation is preferred because the extension cannot
be installed programmatically by a normal desktop installer. A development
ZIP/unpacked build remains available for contributors and privately managed
deployments.

If the extension cannot find the helper, its primary action should open the
OS-specific install page, not show a generic README or imply that the
extension can record by itself.

### Distribution channels

All channels must install the same versioned, signed helper artifacts and the
same two binaries (`notetaker-helper` and `notetaker-nm-host`). Package
managers are distribution channels, not separate implementations.

| Platform | Primary artifact | Package-manager channel | Driver behavior |
| --- | --- | --- | --- |
| macOS | signed/notarized DMG or PKG | Homebrew Cask (`brew install --cask ai-notetaker`) | Detect BlackHole; link to Existential Audio's official installer. Never bundle its compiled binary. |
| Windows | signed MSIX or NSIS/MSI | WinGet first, Chocolatey supported (`choco install ai-notetaker`) | Bundle only base VB-CABLE when licensing and release review permit; show attribution and donation link. |
| Linux | signed/checksummed `.deb`; AppImage as fallback | apt/repository package later; no fake universal package | Create the PulseAudio/PipeWire null sink through `pactl`; `.deb` declares desktop/runtime dependencies. |

Homebrew Cask and Chocolatey packages should be thin wrappers around the
release artifact, with a pinned version and SHA-256 checksum. They must not
download an unpinned binary at install time. Package-manager upgrade commands
own updates for package-managed installs; the Tauri updater owns updates for
direct-download installs. The two update mechanisms must not race.

### Where npm belongs

npm is useful for contributors and automation, and remains the supported
source-build tool for the extension. It should not be the main consumer
installer:

- `npm install` cannot be assumed on a new desktop.
- An npm package cannot make macOS/Windows driver installation and elevation
  predictable across security policies.
- It cannot install a Chrome Web Store extension.
- An npm-driven download-and-execute flow would create a less trustworthy
  supply-chain boundary than a signed native installer.

After the native release channel is stable, an optional
`@ai-notetaker/cli` can provide `npx @ai-notetaker/cli doctor` for developers
and managed environments. If an `install` command is added, it may download,
verify, and launch the already-signed native installer, but it must not embed
driver installers, bypass elevation, or claim to install the extension.

## Prerequisite model

Prerequisite detection is split between the installer, the helper, and the
extension so each layer can report only what it can actually verify.

### Installer checks

The native installer checks:

- supported OS version and CPU architecture;
- whether the target directory is writable or elevation is required;
- whether a previous AI Notetaker installation exists;
- whether the required WebView/runtime dependency is present or can be
  installed by the native installer;
- whether a conflicting or unrelated Native Messaging registration would be
  overwritten.

Installers must fail with a repair path if they cannot safely register the
relay. They must never replace an unrelated manifest or registry entry.

### Helper checks

On first launch the helper reports a structured readiness snapshot:

- `platform` and helper version;
- detected virtual-audio backend and install state;
- physical microphone and meeting-audio input;
- whether the host audio control is usable;
- actionable next step and whether it requires relogin/reboot;
- Native Messaging/protocol compatibility.

This is an extension of the existing `audio_preflight` contract, not a new
local HTTP service. The helper may create Linux PulseAudio/PipeWire modules,
but it must not download or invent a custom driver.

### Driver policy by OS

- **macOS:** provide an official BlackHole link and guided steps. Detect it
  again after installation and tell the user when logout/relogin is needed.
  Do not bundle the official compiled installer.
- **Windows:** stage only base VB-CABLE through the signed native installer
  when the release has a verified, pinned payload. The helper launches the
  vendor installer visibly for its normal administrator flow; it never fetches
  a driver at runtime or relies on an undocumented silent flag. Keep
  vb-audio.com attribution and the donation option visible. Reboot/re-
  enumeration remains a truthful possible next step.
- **Linux:** check for `pactl` and a PulseAudio/PipeWire-compatible session.
  The helper creates/removes its named null-sink modules. A `.deb` may declare
  package dependencies, but the app must not silently run `sudo apt` or
  assume one distribution's package manager.

The extension should model these as distinct states: `helper missing`,
`driver missing`, `audio routing incomplete`, `ready`, and `check failed`.
“Helper installed” must never be treated as “recording ready.”

## Docker option

Docker is supported for the **optional history webapp only**.

The repository should add a `webapp/Dockerfile` and a root-level or webapp
`docker-compose.yml` containing:

- one Next.js webapp container;
- one Postgres container with a named persistent volume;
- a health check for the webapp;
- an entrypoint that runs the already-defined Prisma deployment migration
  before starting the web server;
- an `.env.example` documenting `AUTH_TOKEN`, database settings, and the
  bind address.

The default Compose bind should be local/private where practical. Users who
expose it remotely are responsible for HTTPS, network controls, backups, and
token rotation. The extension sends finished meeting notes to this URL after
local save. The container never needs Deepgram, Groq, Claude, Gemini, or
DeepSeek credentials.

The desktop helper must not be offered as a normal Docker image. Containers
do not have a reliable cross-platform path to the host microphone, speaker
devices, tray/session, Chrome Native Messaging registry, or desktop consent
prompts. A future Linux-only advanced mode could require explicit host audio
device passthrough, but that would be a separate product with separate
security and support commitments.

## Release and compatibility contract

Each release should publish a machine-readable release manifest containing:

- helper and extension versions;
- minimum compatible protocol version;
- OS/architecture artifact URLs;
- SHA-256 checksums and signing/notarization status;
- package-manager version metadata;
- Chrome Web Store version and fallback extension ZIP.

The extension should compare the helper's protocol/version response and show a
specific “update helper” action when incompatible. It should not ask users to
manually edit Native Messaging manifests for normal installs.

The direct-download installer and package-manager wrappers must be produced
from one release workflow. Release evidence must separately verify:

- artifact checksum and signature;
- Native Messaging registration and uninstall on each OS;
- extension ID stability;
- driver detection and audio preflight;
- package-manager install/upgrade/uninstall;
- Docker webapp boot, migration, persistence, and authenticated API access.

## Implementation order

1. Add the release manifest schema and OS/architecture artifact layout.
2. Replace the onboarding's generic Releases link with an install-page URL
   carrying the detected platform and a manual override.
3. Finish direct native installers and release-owner signing/notarization.
4. Add Homebrew Cask and WinGet/Chocolatey wrappers that consume pinned
   release artifacts.
5. Add the Dockerfile, Compose file, healthcheck, and documented token flow
   for the webapp.
6. Add a helper/extension compatibility check and a user-facing installer
   doctor path.
7. Run native OS, package-manager, Chrome, and Docker acceptance passes before
   calling the install experience production-ready.

## Explicit non-goals

- No open localhost HTTP/WebSocket helper service.
- No silent installation of the Chrome extension.
- No npm package that replaces the native helper.
- No Dockerized capture helper in the supported cross-platform path.
- No automatic `sudo`/administrator shell scripts that install arbitrary
  system packages without a visible user action and rollback path.
