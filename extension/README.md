# AI Notetaker — Chrome Extension

The UI layer of AI Notetaker: popup (audio preflight, meeting mode, start/stop
and live transcript), a settings page (BYOK provider keys, vocabulary, custom
summary instructions, optional self-hosted webapp), a first-run onboarding
wizard, meeting detail/history, and a cross-meeting action-item inbox. All
recording/transcription/summarization logic lives in the desktop helper
(`../helper/`) — see `../docs/native-messaging-protocol.md` for the wire
contract between them, and `CLAUDE.md` in this directory for the conventions
this package follows.

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

## What's implemented vs. not yet verified live

Implemented and unit-tested (61 tests, all passing): local storage
(settings/meetings, `chrome.storage.local` only, never `.sync`), the
Native Messaging client and reconnect behavior, the background
orchestration logic (transcript/summary handling, webapp sync, crash
recovery state), and API-key/webapp health validation.

**Not verified in this environment** (no real Chrome browser or running
helper process was available to test against): actually loading the
unpacked extension in Chrome, the real Native Messaging handshake against
a live helper, and real provider API calls (the "test key" buttons are
helper-routed but still need real credentials — untested against real keys
here). These need a manual pass once `helper/` is built and both are
loaded together on a real machine.
