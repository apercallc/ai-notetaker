---
name: notetaker-guardrails-review
description: Review AI Notetaker changes against its dual-mode capture, Native Messaging, audio persistence, credential storage, workspace isolation, Tauri, packaging, and auth constraints. Use before committing changes under helper, extension, or webapp.
---

# AI Notetaker guardrails review

Read `CLAUDE.md`, the relevant package `CLAUDE.md`/`AGENTS.md`, and the
changed diff. Report only concrete findings with file and line, constraint,
and user-facing failure mode.

Check that:

1. Free local BYOK remains account-free; optional managed AI uses the
   project-operated service with server-side provider credentials, verified
   billing state, and workspace-scoped access. Self-hosted history remains supported.
2. Google Meet capture and processing remain extension-owned and helperless;
   the helper owns desktop-call capture and processing. Managed processing
   runs server-side. Follow the current root `CLAUDE.md` and
   `docs/superpowers/specs/2026-09-24-scribbl-dual-mode-product-design.md`;
   the historical no-backend and helper-only pipeline rules are superseded.
3. Extension ↔ helper control remains Native Messaging plus the local
   Unix/named-pipe relay, never TCP/WebSocket localhost.
4. Mic and speaker remain separate, and raw audio is persisted before every
   provider call with retry/recovery intact.
5. Local BYOK keys remain in `chrome.storage.local`, never sync or the managed
   service; managed keys stay server-side. The stable manifest key is unchanged.
   Private webapp routes check authentication and workspace scope. Public auth
   entry points, health, verified webhooks, and explicitly token-scoped shares
   expose only the data their purpose requires.
6. The helper remains Tauri/Rust, keeps both binaries, and does not add a
   custom audio driver.
7. BlackHole is linked, not bundled; base VB-CABLE attribution/donation copy
   remains visible wherever its installer is shipped.
8. Startup recovery preserves helper recordings and extension IndexedDB Meet
   recordings; neither crashes nor provider failures discard recoverable audio.

Before a commit, also run the focused tests and distinguish local build proof
from real OS, signing, provider, deployment, and browser proof.
