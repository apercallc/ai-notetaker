# extension/ — Codex guidance

Read [`../CLAUDE.md`](../CLAUDE.md), [`../AGENTS.md`](../AGENTS.md), and this
package's `CLAUDE.md` before changing the extension. New extension calls
record Google Meet mic and call audio only; provider processing and desktop
call controls belong in the Tauri app. Keep older notes, keys, and settings
accessible during migration.

Preserve existing extension capture, IndexedDB recordings, and local settings
until export/migration is proven. Do not add an open localhost WebSocket. API
keys and pairing tokens remain in `chrome.storage.local`, never
`chrome.storage.sync`, during the compatibility window. Do not alter or
regenerate the committed `manifest.json` `key` field. Preserve accessible
state, dark mode, reduced motion, and existing records.

Run `npm run typecheck`, `npm test`, and `npm run build` from this directory.
