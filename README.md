# AI Notetaker

Private, botless meeting notes from the desktop you already use.

AI Notetaker records the microphone and meeting audio, turns the conversation
into a transcript, and produces a summary with action items. It is open
source and local-first. Use the free local BYOK mode with no account, or sign
in to the optional hosted AI mode so the service handles provider calls and
usage billing for you.

<p align="center">
  <img src="docs/screenshots/recording-ready.png" alt="AI Notetaker popup with audio ready and a Record button" width="360" />
</p>

## Start here

The normal user flow is:

1. Install the Chrome extension and open its action popup; it starts with
   Google Meet browser capture.
2. Continue with Google Meet, or choose a desktop call and install
   the helper when that path is selected.
3. Choose free local BYOK or optional Hosted AI, then acknowledge recording
   consent.
4. Start from the active Meet tab, or select the AI Notetaker audio devices
   for a desktop call.

When the signed release channels are published, the easiest install will be
the native helper for your OS plus the Chrome Web Store extension. Until then,
use the development-extension/source-build path below. The full,
copy-and-paste setup—including package manager install and upgrade commands—is in
[`docs/getting-started.md`](docs/getting-started.md).

The production distribution model is documented in the
[distribution and installation architecture](docs/superpowers/specs/2026-09-21-distribution-and-installation-architecture.md): native helper
installers/package-manager channels for capture, with Docker reserved for the
optional self-hosted history webapp.

> **Current project status:** the release workflow is configured to build and
> publish release assets and the optional webapp image from a version tag, but
> the repository currently has no public release. The first public signed
> release, Chrome Web Store listing, and package-manager submissions still
> require release-owner credentials and external review. Until those are
> complete, the install page correctly directs users to the source-build or
> development-extension path. See the [code-signing policy](docs/code-signing-policy.md)
> and [unsigned-install guide](docs/unsigned-install.md) for the development
> fallback and the separate signed-release requirements.

## What it feels like

The first-run wizard keeps setup in one place. It starts with Google Meet so a
new user is not sent to the desktop installer before choosing a capture mode.
Desktop-call users get the helper and audio checks only after selecting that
path; everyone chooses their AI mode and acknowledges recording consent.

![AI Notetaker first-run setup wizard](docs/screenshots/onboarding-step-1.png)

Once setup is complete, the extension popup is the everyday control surface.
For desktop calls, the **Record** button stays disabled until the helper and
both audio channels are ready; Meet uses the active tab and Chrome's capture
permission instead. You can choose a meeting mode, run a two-second audio
test for desktop capture, see recent meetings, and open the action-item inbox.

These screenshots show the built extension UI and its documented states. A
real provider call, OS audio driver, and live meeting still need to be tested
on the machine where you use the app.

## What you get

- A live transcript while you record.
- A meeting summary and action items after you stop.
- Meeting history and detail pages stored locally by default.
- Custom meeting modes, vocabulary, and summary instructions.
- Crash recovery and a retry queue for provider interruptions.
- An optional self-hosted webapp for authenticated, cross-device history.
- An implemented managed mode foundation for hosted processing, workspace
  history, sharing, recording downloads, usage limits, and paid AI service
  usage; real deployment/provider acceptance remains a separate release gate.

## How the pieces fit together

AI Notetaker has one required piece for Google Meet, an additional native
piece for desktop-call capture, and an optional history service:

| Piece | What it does |
| --- | --- |
| Chrome extension | Owns botless Google Meet tab capture, local-first browser processing, setup, live transcript, settings, meetings, and action items. |
| Desktop helper (desktop calls only) | A Rust/Tauri tray app for native microphone/system-audio capture, local storage, processing, retries, and recovery on Zoom, Teams, Slack, and other desktop calls. |
| History service (optional) | Self-hosted BYOK deployment or the managed hosted workspace, depending on the mode you choose. |

The extension talks to the helper through Chrome Native Messaging and a local
Unix socket or Windows named pipe. It does not open a TCP/localhost server.
Local BYOK provider keys stay in `chrome.storage.local`; managed provider keys
stay server-side. The extension/helper use Native Messaging and authenticated
workspace uploads for managed processing.

## Before you begin

You need:

- Chrome or another Chromium browser that supports the extension APIs.
- A desktop OS with a supported system-audio path: Windows WASAPI loopback
  and Linux PipeWire/PulseAudio monitor capture are native paths; macOS uses
  ScreenCaptureKit system-audio capture on macOS 13+.
  BlackHole is the documented macOS fallback when Screen Recording permission
  is unavailable.
  VB-CABLE remains the Windows fallback when WASAPI is unavailable.
- For local mode, two provider keys: one transcription key and one
  summarization key. Hosted mode uses the service's provider credentials.
- A meeting app that lets you choose its microphone and speaker separately.
- Permission from the people you record, where required by local law.

AI Notetaker does not bundle a custom audio driver. Follow the platform cards
in the wizard and the detailed [audio setup guide](docs/helper-packaging.md).

## Quick start

### 1. Install the extension

Install **AI Notetaker** from the Chrome Web Store when the listing is
available. A released ZIP is the fallback for managed or development installs;
Chrome does not allow a native desktop installer to silently install an
extension.

For the fallback ZIP or a source build:

```sh
cd extension
npm install
npm run build
```

Then open `chrome://extensions`, turn on **Developer mode**, choose **Load
unpacked**, and select `extension/dist/`.

The extension's first-run flow starts with Google Meet browser capture. Meet
recordings persist and process in the extension; the desktop helper is
requested only after choosing Zoom, Teams, Slack, or another desktop-call
source.

### 2. Install the helper when using desktop-call capture

Use the package manager for your OS when a published release is available:

```sh
# macOS
brew install --cask ai-notetaker

# Windows PowerShell
winget install AI.Notetaker
# or: choco install ai-notetaker

# Linux: download the .deb from the latest release, then run:
sudo apt install ./AI-Notetaker_<version>_amd64.deb
```

Launch **AI Notetaker** once so its tray process is running. Package-managed
installs update with `brew upgrade --cask ai-notetaker`, `winget upgrade
AI.Notetaker`, or `choco upgrade ai-notetaker`.

If no public release is available yet, follow the contributor-only
[source-build path](docs/getting-started.md#build-from-source). Running
`cargo build` alone does not make Chrome find the helper.

The extension ID is intentionally stable:
`jidooookkdbbbhkkdmcajnnnhhphodok`. Do not replace the committed `key` in
`extension/manifest.json`; the helper allowlists this ID.

### 3. Complete setup once

Click the AI Notetaker icon and choose **Start with Google Meet**. The wizard walks you
through:

1. Choosing Google Meet browser capture or a desktop-call source.
2. Installing/checking the helper and selecting separate audio devices only for
   desktop-call capture.
3. Adding and testing one transcription key plus one summarization key.
4. Acknowledging the recording-consent disclosure.

After the wizard, return to the popup, click **Check audio**, run the
two-second test, and wait for **Audio ready**.

### 4. Record a meeting

1. In Zoom, Microsoft Teams, or Slack Huddles, choose the AI Notetaker devices
   shown by the wizard. In Google Meet, you can instead choose **Google Meet —
   capture this tab** in the popup, or the Notetaker pill that appears on the
   call page, and keep Meet's normal devices.
2. Open the extension popup and choose a meeting mode.
3. Confirm the browser capture status is ready for Meet, or the audio status
   is ready for helper mode when recording a desktop call.
4. Click **Record**.
5. Keep the helper running while you meet only for desktop-call capture.
6. Click **Stop recording** when the meeting ends.

The transcript updates while you record. After processing finishes, open the
meeting from **Recent meetings** to read the summary, transcript, and action
items.

## Provider costs and privacy

In local BYOK mode, you bring the keys and pay the providers directly. In
Hosted AI mode, the service owns provider credentials, applies usage limits,
and bills the workspace through its configured payment provider. Provider and
hosted-plan pricing can change, so check the current plan before relying on an
estimate.

Raw microphone and speaker audio are persisted locally before provider calls
so interrupted requests can be retried. In local BYOK mode, the project does
not receive your audio, transcripts, provider keys, or telemetry. In Hosted AI
mode, audio and resulting notes leave the device only through the selected
managed service after local persistence; review its retention and deletion
policy. See [`docs/data-handling.md`](docs/data-handling.md) for storage and
deletion details.

## Optional: history on your own server

The extension always keeps local meeting history. For authenticated,
cross-device history, either deploy the optional self-hosted webapp and paste
its URL plus access token into Settings, or sign in to Hosted AI and use its
workspace history and billing controls.

This is not required for recording, and the webapp never needs your AI
provider keys. See [`webapp/README.md`](webapp/README.md) for local and
Railway deployment instructions.

## If something is not working

- **Helper not detected:** launch the tray helper and reload the extension.
  If you built from source, install the helper package or register its Native
  Messaging manifest; the two binaries are `notetaker-helper` and
  `notetaker-nm-host`.
- **Audio needs attention:** choose the AI Notetaker microphone and speaker
  in the meeting app, keep your normal speakers connected, then run the
  audio check again. Restart the meeting app after installing a new driver.
- **Provider test fails:** verify that the key belongs to the selected
  provider tier and test it again in Settings. Do not put provider keys in
  the webapp.
- **A recording was interrupted:** use the popup's **Resume** or **Discard**
  banner. The helper keeps the raw audio locally for recovery.

The detailed troubleshooting flow is in [`docs/getting-started.md`](docs/getting-started.md#troubleshooting).

## For contributors

The living roadmap is [`TODO.md`](TODO.md). Contribution setup, architecture
boundaries, required checks, and pull-request expectations are in
[`CONTRIBUTING.md`](CONTRIBUTING.md); release evidence and external gates are
kept explicit there and in the roadmap.

```sh
cd helper && cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
cd ../extension && npm run typecheck && npm test && npm run build
cd ../webapp && npx prisma generate && npm run test:with-postgres && npm run build
```

Package-specific notes live in [`extension/README.md`](extension/README.md),
[`helper/README.md`](helper/README.md), and [`webapp/README.md`](webapp/README.md).
Coverage commands and the distinction between deterministic tests and real
OS/browser/provider validation are in [`docs/testing.md`](docs/testing.md).
Architecture decisions are recorded in [`docs/superpowers/specs/2026-09-21-notetaker-architecture-design.md`](docs/superpowers/specs/2026-09-21-notetaker-architecture-design.md).

## License

MIT — see [`LICENSE`](LICENSE).
