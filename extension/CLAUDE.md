# extension/ — Chrome Extension

Manifest V3. This package owns the Google Meet browser path: its offscreen
document receives remote Meet audio from a minimal MAIN-world receiver-track
adapter (with tab capture as a fallback), captures the microphone separately,
and IndexedDB persists chunks before
local BYOK processing or Hosted AI upload. For desktop-call sources it is a
**thin UI** that forwards start/stop and settings to the native helper. See the root `CLAUDE.md` and
`docs/superpowers/specs/2026-09-24-dual-mode-product-design.md`
for why: service workers die after ~30s idle and cannot own the long-running
desktop pipeline; the offscreen Meet path is explicitly durable and rehydrates
from IndexedDB after service-worker suspension.

## Conventions

- **The Meet page bridge carries bounded signaling only.** No provider keys,
  tokens, storage access, or generic extension commands enter the MAIN world.
  The local WebRTC relay is receive-only in the offscreen document; never
  attach the microphone to it. Only offscreen-origin messages may persist
  audio through the service worker. A changed page document invalidates its
  old signaling session. Keep Meet's original tracks and playback untouched.

- **Helper communication is Native Messaging only.** Never open a raw
  WebSocket to `127.0.0.1` for extension↔helper control — any webpage's JS
  can connect to an open local port. Native Messaging is OS-enforced and
  allowlisted to this extension's ID.
- **Local BYOK keys and tokens live in `chrome.storage.local`, never `.sync`.**
  Managed provider keys remain server-side and never reach the extension.
- **Meet BYOK provider calls are direct from the extension only for the
  browser-owned Meet path.** Raw mic/speaker chunks must already be in
  IndexedDB before a call. Desktop-call BYOK remains helper-routed, and
  managed mode uses the authenticated hosted service; never send local keys
  to that service.
- **Local mode requires no account.** Managed mode may authenticate to the
  project-operated hosted service, but requests must be explicit,
  authenticated, workspace-scoped, and visible in settings. Never send local
  BYOK keys to the hosted service.
- Keep it a standard WebExtension where the API allows, even though Chrome
  is the primary target — an Edge/Brave/Firefox port later shouldn't
  require a rewrite (see spec §7).
- **`manifest.json` must carry a committed `key` field** so the extension's
  ID is stable across local dev, CI, and the eventual Web Store listing.
  Never regenerate this key casually — the Native Messaging host manifest
  is allowlisted to the ID it derives from, and changing it breaks every
  installed helper's handshake.
