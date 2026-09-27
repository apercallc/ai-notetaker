# extension/ — Codex guidance

Read [`../CLAUDE.md`](../CLAUDE.md), [`../AGENTS.md`](../AGENTS.md), and this
package's `CLAUDE.md` before changing the extension.

The extension owns the Google Meet browser path: its offscreen document
captures the tab and microphone, persists chunks in IndexedDB, and may call
the user's selected BYOK providers directly for Meet. In managed mode it
uploads only durable audio to the authenticated hosted service; managed
provider keys never reach the extension. For desktop calls, the extension is
a thin Manifest V3 UI that uses Native Messaging to control the helper. Never
add an open localhost WebSocket. API keys and pairing tokens belong in
`chrome.storage.local`, never `chrome.storage.sync`. Do not alter or
regenerate the committed `manifest.json` `key` field. Preserve accessible
state, dark mode, reduced motion, and the existing provider/helper contracts.

Run `npm run typecheck`, `npm test`, and `npm run build` from this directory.
