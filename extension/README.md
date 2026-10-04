# AI Notetaker — Chrome Extension

The extension records meetings playing in a secure Chrome tab, including the web
versions of Google Meet, Zoom, Teams, Slack, and Discord. It saves microphone
and tab audio as separate local tracks. Stop recording, then use **Settings → Save full
archive** to export a `.ntarchive` file. Import that file in the desktop app
under **Settings → Import from the extension** and select **Create notes from
saved audio** on the imported recording. The desktop app owns transcription,
summary generation, provider keys, and desktop-call capture.

Extension recording controls stay in Chrome. Desktop provider settings and
extension recordings remain local to their respective apps until you import an
archive. Desktop workspace sync copies web-app notes into the desktop library,
but the extension does not yet display that shared library. Web edits,
deletions, and settings are not synchronized back.
The extension retains older recordings, notes, provider settings, and Native
Messaging compatibility during migration. **Open previous settings** provides
access to those older controls. New browser recordings do not call an AI provider
or require a provider key in Chrome.

For the user-facing install and recording flow, start with
[`../docs/getting-started.md`](../docs/getting-started.md). This package guide
is for building and loading the extension during development.

New extension setup asks for microphone access and recording consent. Existing
extension provider keys remain in `chrome.storage.local` for older records and
are not moved into desktop storage automatically. Enter desktop keys in the
desktop app's Settings. The released ZIP and unpacked build below are fallback
installation paths; npm is for development.

## Develop

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build        # bundles to dist/
```

`npm run watch` rebuilds on file change (does not re-copy static files on
every change beyond the initial build — re-run `npm run build` after
editing an `.html`/`.css` file).

## Load it in Chrome

1. `npm run build`
2. Open `chrome://extensions`, enable "Developer mode"
3. "Load unpacked" → select this package's `dist/` directory

The extension's ID is fixed at `jidooookkdbbbhkkdmcajnnnhhphodok` (derived
from the committed `key` field in `manifest.json` — see the architecture
spec §3.2 for why this has to stay stable).

Loading `dist/` is sufficient for browser-tab capture. Start a secure Teams,
Zoom, or other web meeting from the popup or recording shortcut; Google Meet
also has an in-call control. The desktop app
is needed to process imported audio into notes. Older extension and helper
installs can still use Native Messaging during migration. See the
[source-build steps](../docs/getting-started.md#build-from-source).

## Testing and verification

`npm test` runs the unit suite (jsdom, no browser); `npm run test:coverage`
enforces the coverage floor in `vitest.config.ts`; `npm run typecheck` runs
`tsc`. The suite covers storage, the Native Messaging client, background
orchestration, the Meet widget (rendering, drag, accessibility, sender rules),
capture orchestration, calendar reminders, and the helper protocol.

The Meet capture path was also exercised in real Chromium against a real helper
over Native Messaging, using a local HTTPS stand-in for `meet.google.com`
(strict CSP and Trusted Types on, fake capture devices): capture refusal
without an invocation, a real shortcut start, separate mic/speaker files,
flagged moments reaching the helper, alarm and notification, and real mouse
input on the widget. See "Verified in a real browser" in
`../docs/superpowers/specs/2026-09-24-meet-widget-design.md`.

The recorder-only flow still needs a real Google Meet call, export from an
installed Chrome extension, import into a live desktop app, and processing
with valid desktop provider keys. Older browser/provider behavior has separate
historical coverage; it does not prove this new flow end to end.
