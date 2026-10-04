---
name: notetaker-guardrails-review
description: Review AI Notetaker changes against its desktop-first migration, audio persistence, credential storage, webapp auth/workspace isolation, Tauri, and packaging constraints. Use before committing changes under helper, extension, or webapp.
---

# AI Notetaker guardrails review

Read `CLAUDE.md`, the relevant package `CLAUDE.md`/`AGENTS.md`, and the
changed diff. Report only concrete findings with file and line, constraint,
and user-facing failure mode.

Check that:

1. Local BYOK in the Tauri desktop app remains account-free. Optional web-app
   sync sends only completed note text through an authenticated API token;
   provider keys and raw audio stay local by default. Existing managed hosting
   remains tenant-scoped and server-secret-only until separately deprecated.
2. New browser and desktop recordings use the desktop app's native loopback
   and mic capture. The extension is a legacy client during migration; preserve
   its IndexedDB data and compatibility until export/import and acceptance
   gates pass. Follow `CLAUDE.md` and
   `docs/superpowers/specs/2026-10-03-desktop-first-product-design.md`.
3. Desktop UI ↔ Rust control uses Tauri IPC. Existing extension ↔ helper
   control remains Native Messaging plus the local Unix/named-pipe relay only
   during migration. Never add TCP/WebSocket localhost.
4. Mic and speaker remain separate, and raw audio is persisted before every
   provider call with retry/recovery intact.
5. New desktop BYOK keys and webapp API tokens remain in the OS credential
   vault. Existing extension keys remain in `chrome.storage.local`, never sync,
   until migrated. The stable manifest key is unchanged while compatibility
   remains. Private webapp routes check authentication and workspace scope. Public auth
   entry points, health, verified webhooks, and explicitly token-scoped shares
   expose only the data their purpose requires.
6. The desktop app remains Tauri/Rust and does not add a custom audio driver.
   Keep the Native Messaging relay only until migration acceptance passes.
7. BlackHole is linked, not bundled; base VB-CABLE attribution/donation copy
   remains visible wherever its installer is shipped.
8. Startup recovery preserves local recordings; neither crashes nor provider
   failures discard recoverable audio. Extension IndexedDB is not deleted
   until its export/import path is proven.

Before a commit, also run the focused tests and distinguish local build proof
from real OS, signing, provider, deployment, and browser proof.
