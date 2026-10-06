# extension/ — Chrome Extension

Manifest V3. This package is an optional browser meeting recorder during the
desktop-first migration. New calls capture separate mic and meeting tracks in
IndexedDB; the Tauri desktop app owns provider keys, notes, and desktop calls.
Meet, Teams, Zoom web meetings, Discord channels, and Slack workspaces have
floating recording controls. Other secure tabs use the popup or shortcut.
Only Meet uses the MAIN-world audio bridge. Keep older recordings, notes, settings, and the explicit archive export
available until acceptance passes. Do not remove storage or alter the stable
manifest key during the transition. See the root `CLAUDE.md` and
`docs/superpowers/specs/2026-10-03-desktop-first-product-design.md`.

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
- **Existing local BYOK keys and tokens stay in `chrome.storage.local`, never
  `.sync`, while the extension remains supported.** The desktop migration
  moves keys into OS credential storage without writing them to exports.
- Keep all legacy processing requests authenticated and workspace-scoped.
  Never send local BYOK keys to any web service.
- Keep it a standard WebExtension where the API allows, even though Chrome
  is the primary target — an Edge/Brave/Firefox port later shouldn't
  require a rewrite (see spec §7).
- **`manifest.json` must carry a committed `key` field** so the extension's
  ID is stable across local dev, CI, and the eventual Web Store listing.
  Never regenerate this key casually — the Native Messaging host manifest
  is allowlisted to the ID it derives from, and changing it breaks every
  installed helper's handshake.
