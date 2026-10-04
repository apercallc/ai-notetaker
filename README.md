# AI Notetaker

Private, botless meeting notes: no bot joins your call.

AI Notetaker is moving to one cross-platform desktop app for setup, recording,
and local notes. Add your own transcription and summary API keys; no
AI Notetaker login or browser extension is needed for local use. Optional
workspace sync copies finished note text to the web app. Audio and provider
keys stay on this device.

> **Status:** the desktop window and local recording flow are in development.
> Installers and cross-platform acceptance are not ready yet. The Chrome
> extension remains available during migration so current users can keep
> access to existing data. See the
> [desktop-first migration plan](docs/superpowers/plans/2026-10-03-desktop-first-product-migration.md).

## Quickstart

The intended setup is one desktop app: add and test provider API keys, grant
audio permissions, then start and stop a meeting from the app. Installers are
not published yet; see the [desktop-first migration plan](docs/superpowers/plans/2026-10-03-desktop-first-product-migration.md)
for status. Existing extension users can follow the
[Meet recorder guide](docs/getting-started.md#google-meet-recorder-extension).

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
| **Any desktop or browser call** | The AI Notetaker desktop app, transcription and summary API keys, and operating-system audio permission. Native loopback is supported on macOS 13+, Windows, and Linux; see the [audio setup guide](docs/helper-packaging.md) for fallbacks. |

Get permission from the people you record where local law requires it. AI
Notetaker does not bundle a custom audio driver; see the
[audio setup guide](docs/helper-packaging.md) for the fallbacks.

## Google Meet recorder extension

The Chrome extension records Google Meet microphone and call audio separately
in local browser storage. Export a full `.ntarchive` from extension Settings,
import it in the desktop app, then create notes from the saved audio. The
desktop app handles AI processing and other call sources. Older extension
notes and settings remain accessible during migration. See the
[recorder guide](docs/getting-started.md#google-meet-recorder-extension).

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
| Web app (optional) | Stores synced finished note text in one authenticated workspace. |
| Chrome extension | Records Google Meet audio locally and exports it to the desktop app; retains older data during migration. |

The desktop window controls Rust through Tauri IPC; it does not open a
TCP/localhost server. Provider API keys stay in the operating system credential
store and go only to selected AI providers. Native Messaging remains for
legacy extension compatibility during migration.

## Terms

The Meet extension uses **Start recording / Stop recording**. After import, the
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

- **Existing extension users cannot start notes:** check
  `chrome://extensions/shortcuts`, or use the toolbar icon. New desktop
  installs do not use the extension.
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
