# extension/ — Codex guidance

Read [`../CLAUDE.md`](../CLAUDE.md), [`../AGENTS.md`](../AGENTS.md), and this
package's `CLAUDE.md` before changing the extension.

The extension is a thin Manifest V3 UI. Use Native Messaging for helper
control; never call Deepgram, Groq, Claude, Gemini, or DeepSeek directly and
never add an open localhost WebSocket. API keys and pairing tokens belong in
`chrome.storage.local`, never `chrome.storage.sync`. Do not alter or
regenerate the committed `manifest.json` `key` field. Preserve accessible
state, dark mode, reduced motion, and the existing provider/helper contracts.

Run `npm run typecheck`, `npm test`, and `npm run build` from this directory.
