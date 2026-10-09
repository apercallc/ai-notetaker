# AI Notetaker

Private, botless meeting notes: no bot joins your call.

AI Notetaker is one desktop app for macOS, Windows, and Linux. It records your
microphone and the meeting audio (Google Meet, Teams, Zoom, Discord, Slack, or any
app) on your device, saves the audio first, then turns it into a transcript, summary,
and action items. Capture options and system permissions vary by platform; real
call acceptance is still in progress. No browser extension is required for the
desktop workflow.

Notes are made with **your own keys**: paste your own transcription and summary
API keys. Free, account-free, and audio goes straight from your device to the
providers you pick.

- **Free account** — optional. Sign in to manage your devices and your data.
- **Subscription** — cloud sync of your notes across devices (Pro) and team
  sync with a shared workspace (Team). Recording and your own keys are never
  paid. See [current pricing](https://ai-notetaker.apercallc.com/pricing)
  and the [`llms.txt`](https://ai-notetaker.apercallc.com/llms.txt) fact sheet.

Optional workspace sync copies finished notes to the web app and brings workspace
notes into the desktop library. Provider keys never leave your device.

> **Status:** Preview installers are published for macOS, Windows, and
> Debian/Ubuntu Linux. They are unsigned, so your operating system will warn you on
> first open ([how to open an unsigned app](docs/unsigned-install.md)). Real-call
> capture acceptance is still in progress on every platform; see the
> [release checklist](docs/launch/release-candidate-checklist.md).

## Quickstart

1. Download the installer for your system from the
   [latest release](https://github.com/apercallc/ai-notetaker/releases/latest).
2. Open **AI Notetaker**. It starts at login so recovery and the tray are always
   available; closing the window keeps it running in the tray (relaunching brings
   the window back).
3. In **Settings → Own API keys**, add your own keys. Sign in under **Account & sync** if you want an account.
4. Allow microphone and system-audio access when your system asks.
5. In **Record**, confirm everyone knows recording is starting, then start and stop.
   Notes appear under **Notes**.

## What you get

- A summary and action items when you stop.
- Meeting history and notes pages stored locally by default, with search.
- Notes styles (General, Standup, Sales call, 1:1, Interview, or your own),
  custom vocabulary, and summary instructions.
- Crash recovery and a retry queue, so a provider outage never loses audio.
- Optional Google Docs/Drive export and Markdown, text, or print/PDF export.
- Optional workspace-scoped web-app sync for finished note text. Raw audio and
  provider keys stay local.

## What you need

| You want to record | You need |
| --- | --- |
| **Any meeting, in a browser or a desktop app** | The AI Notetaker desktop app, your own transcription and summary API keys, and operating-system audio permission. Native loopback is supported on macOS 13+, Windows, and Linux; see the [audio setup guide](docs/helper-packaging.md) for fallbacks. |
| **A Chrome tab, optionally** | The optional AI Notetaker Chrome extension saves tab and microphone audio; export its archive and import it in the desktop app. |

Get permission from the people you record where local law requires it. AI
Notetaker does not bundle a custom audio driver; see the
[audio setup guide](docs/helper-packaging.md) for the fallbacks.

## Optional: browser meeting recorder extension

The desktop app does not need this. The Chrome extension records microphone and meeting-tab audio separately
in local browser storage. Export a full `.ntarchive` from extension Settings,
import it in the desktop app, then create notes from the saved audio. The
desktop app handles AI processing and desktop call sources. Meet, Teams, Zoom web meetings, Discord channels, and Slack workspaces
have floating recording controls. Chrome may require a toolbar click or shortcut
to enable tab audio. Other secure tabs use the popup or shortcut. Older extension
notes and settings remain accessible during migration. See the
[recorder guide](docs/getting-started.md#browser-meeting-recorder-extension).

To run from source today:

```sh
cd extension
npm install
npm run build
```

Then open `chrome://extensions`, turn on **Developer mode**, choose **Load
unpacked**, and select `extension/dist/`.

The extension ID is intentionally stable: `jidooookkdbbbhkkdmcajnnnhhphodok`.
Do not replace the committed `key` in `extension/manifest.json`; the helper
allowlists this ID.

## Desktop app development build

The Tauri application is intended as the single install for supported call
apps. Preview installers are published, but remain unsigned and platform
capture acceptance is incomplete. To launch a development build, follow the
[developer source-build steps](docs/getting-started.md#developer-quickstart-run-from-source).
Existing extension users can keep their legacy helper installation during
migration.

## How the pieces fit together

| Piece | What it does |
| --- | --- |
| Desktop app | Owns setup, provider keys, microphone/system-audio capture, local notes, retries, and recovery. |
| Web app (optional, Pro or Team) | Shows finished desktop note text synced to one authenticated workspace. Workspace notes are also copied to desktop; web edits refresh those copies on sync. Sync needs a subscription. |
| Chrome extension | Records secure Chrome meeting-tab audio locally and exports it to the desktop app for transcription and notes. Settings are separate. |

The desktop window controls Rust through Tauri IPC; it does not open a
TCP/localhost server. Provider API keys stay in the operating system credential
store and go only to selected AI providers. Native Messaging remains for
legacy extension compatibility during migration.

## Terms

The browser recorder extension uses **Start recording / Stop recording**. After import, the
desktop app offers **Create notes from saved audio**. Desktop settings include
notes style and provider API key setup.
"Managed" and "BYOK" are internal engineering terms. See the
[glossary](docs/getting-started.md#terms-used-in-the-product).

## Provider costs and privacy

You bring provider API keys and pay those providers directly. Costs depend on
provider pricing and meeting length; check current provider pricing before
relying on an estimate.

Raw microphone and speaker audio is saved locally before any provider call so
interrupted requests can be retried. The desktop app sends saved audio and text
to the providers you selected, using your keys. Optional web-app sync sends
finished note text only. See
[`docs/data-handling.md`](docs/data-handling.md) for storage and deletion
details.

## Optional: cloud sync (Pro or Team)

The desktop app keeps local meeting history. For cross-device history, sign in
under **Settings → Account & sync** and choose a Pro or Team plan; finished notes
then sync to your workspace.

This is not required for recording, and the service never receives your AI
provider keys or recordings.

## If something is not working

- **The extension cannot start recording:** open the meeting in a secure
  Chrome tab, then use the toolbar icon or check
  `chrome://extensions/shortcuts`. Import the saved recording in desktop to
  create notes.
- **Provider test fails:** verify that the key belongs to the selected
  provider tier and test it again in Settings. Do not put provider keys in
  the webapp.
- **A recording was interrupted:** open the desktop app and use its recovery
  prompt. The locally saved audio remains available for recovery.
- **An existing extension says "Helper not detected":** launch the legacy
  helper and reload the extension. New desktop users do not need Native
  Messaging registration.

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
The target architecture is
[`docs/superpowers/specs/2026-10-03-desktop-first-product-design.md`](docs/superpowers/specs/2026-10-03-desktop-first-product-design.md);
the [2026-09-24 dual-mode design](docs/superpowers/specs/2026-09-24-dual-mode-product-design.md)
and the [2026-09-21 architecture](docs/superpowers/specs/2026-09-21-notetaker-architecture-design.md)
is the historical baseline.

## License

MIT — see [`LICENSE`](LICENSE).
