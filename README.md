# AI Notetaker

Private, botless meeting notes: no bot joins your call.

Use the Chrome extension to capture a browser meeting tab, or the cross-platform
desktop app to capture browser and desktop meetings and create local notes. The
extension saves tab and microphone audio in Chrome; export its archive and
import it in desktop for transcription. Add your own transcription and summary
API keys in desktop Settings. Optional one-way workspace sync sends finished
desktop notes to the web app. Audio and provider keys stay on this device.

> **Status:** the desktop window and local recording flow are in development.
> Installers and cross-platform acceptance are not ready yet. The Chrome
> extension captures browser meeting audio while new recordings are processed
> in desktop. See the
> [desktop-first migration plan](docs/superpowers/plans/2026-10-03-desktop-first-product-migration.md).

## Quickstart

For browser-tab capture, start the extension from the Chrome meeting tab, then
export and import the archive in the desktop app to create notes. For direct
browser or desktop system-audio capture, use the desktop app. Installers are
not published yet; see the [desktop-first migration plan](docs/superpowers/plans/2026-10-03-desktop-first-product-migration.md)
for status and the [recorder guide](docs/getting-started.md#browser-meeting-recorder-extension).

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
| **A meeting playing in a Chrome tab** | The AI Notetaker extension to save tab and microphone audio, then the desktop app and provider keys to import and create notes. |
| **A browser call in any browser or a desktop call** | The AI Notetaker desktop app, transcription and summary API keys, and operating-system audio permission. Native loopback is supported on macOS 13+, Windows, and Linux; see the [audio setup guide](docs/helper-packaging.md) for fallbacks. |

Get permission from the people you record where local law requires it. AI
Notetaker does not bundle a custom audio driver; see the
[audio setup guide](docs/helper-packaging.md) for the fallbacks.

## Browser meeting recorder extension

The Chrome extension records microphone and meeting-tab audio separately
in local browser storage. Export a full `.ntarchive` from extension Settings,
import it in the desktop app, then create notes from the saved audio. The
desktop app handles AI processing and desktop call sources. Google Meet also
has an in-call control; Teams, Zoom, and other secure web tabs use the popup
or shortcut. Older extension
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
apps. Installers are not ready; source builds are for development only. To
launch the development app, follow the
[desktop preview steps](docs/getting-started.md#quickstart-desktop-app-preview).
Existing extension users can keep their legacy helper installation during
migration.

## How the pieces fit together

| Piece | What it does |
| --- | --- |
| Desktop app | Owns setup, provider keys, microphone/system-audio capture, local notes, retries, and recovery. |
| Web app (optional) | Shows finished desktop note text synced to one authenticated workspace. Sync is currently desktop to web app only. |
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

## Optional: history on your own server

The desktop app keeps local meeting history. For authenticated cross-device
history, create a workspace-scoped desktop sync token in web-app Settings →
Integrations, then save the web-app URL and token in desktop Settings.

This is not required for recording, and the webapp never needs your AI
provider keys. See [`webapp/README.md`](webapp/README.md) for local and
Railway deployment instructions.

## If something is not working

- **The extension cannot start recording:** open the meeting in a secure
  Chrome tab, then use the toolbar icon or check
  `chrome://extensions/shortcuts`. Import the saved recording in desktop to
  create notes.
- **Provider test fails:** verify that the key belongs to the selected
  provider tier and test it again in Settings. Do not put provider keys in
  the webapp.
- **A recording was interrupted:** open the desktop app and use its recovery
  prompt. Raw audio remains local.
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
[`docs/superpowers/specs/2026-09-24-dual-mode-product-design.md`](docs/superpowers/specs/2026-09-24-dual-mode-product-design.md);
the [2026-09-21 architecture](docs/superpowers/specs/2026-09-21-notetaker-architecture-design.md)
is the historical baseline.

## License

MIT — see [`LICENSE`](LICENSE).
