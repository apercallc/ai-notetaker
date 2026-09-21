---
name: notetaker-guardrails-review
description: Review AI Notetaker changes against its no-backend, helper-owned pipeline, Native Messaging, audio, storage, Tauri, packaging, and auth constraints. Use before committing changes under helper, extension, or webapp.
---

# AI Notetaker guardrails review

Read `CLAUDE.md`, the relevant package `CLAUDE.md`/`AGENTS.md`, and the
changed diff. Report only concrete findings with file and line, constraint,
and user-facing failure mode.

Check that:

1. No project-operated subscription/billing backend was added.
2. Provider calls and pipeline orchestration remain in `helper/`, not the
   extension or webapp.
3. Extension ↔ helper control remains Native Messaging plus the local
   Unix/named-pipe relay, never TCP/WebSocket localhost.
4. Mic and speaker remain separate, and raw audio is persisted before every
   provider call with retry/recovery intact.
5. API keys remain in `chrome.storage.local`; the stable manifest key is
   unchanged; webapp routes remain authenticated except health.
6. The helper remains Tauri/Rust, keeps both binaries, and does not add a
   custom audio driver.
7. BlackHole is linked, not bundled; base VB-CABLE attribution/donation copy
   remains visible wherever its installer is shipped.

Before a commit, also run the focused tests and distinguish local build proof
from real OS, signing, provider, deployment, and browser proof.
