# AI Notetaker — Chrome Extension

The UI layer of AI Notetaker: popup (audio preflight, meeting mode, start/stop
and live transcript), a floating notes widget on Google Meet calls (one-click
start, live transcript, flagged moments, calendar reminders), a settings page (BYOK provider keys, vocabulary, custom
summary instructions, optional self-hosted webapp), a first-run onboarding
wizard, meeting detail/history, and a cross-meeting action-item inbox. All
recording/transcription/summarization logic lives in the desktop helper
(`../helper/`) — see `../docs/native-messaging-protocol.md` for the wire
contract between them, and `CLAUDE.md` in this directory for the conventions
this package follows.

For the user-facing install and recording flow, start with
[`../docs/getting-started.md`](../docs/getting-started.md). This package guide
is for building and loading the extension during development.

Normal users should install the extension from the Chrome Web Store and pair
it with the native helper installed through Homebrew, WinGet, Chocolatey, or a
Linux package. The released ZIP and unpacked build below are fallbacks for
managed/private installations; npm is a development dependency path, not a
replacement for the native helper.

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
spec §3.2 for why this has to stay stable). It won't function fully without
a running helper process registered as the `com.ainotetaker.helper` Native
Messaging host — that's built separately in `../helper/`.

Loading `dist/` is only the browser half of the setup. The desktop helper must
also be running, and Chrome must have the Native Messaging manifest installed;
see the complete [source-build and registration steps](../docs/getting-started.md#build-from-source).

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

Still needing a person: a real Google Meet call with real participants, a click
on a real desktop notification, real Google OAuth, and real provider API keys
(the "test key" buttons are helper-routed).
