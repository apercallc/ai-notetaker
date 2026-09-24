# AI Notetaker — Codex guidance

Read [`CLAUDE.md`](CLAUDE.md) first for the full architecture contract. The
package-specific `AGENTS.md` files add local rules for `helper/`, `extension/`,
and `webapp/`. Use the project skills in [`.agents/skills`](.agents/skills)
when their descriptions match the task; `.claude/skills` remains the Claude
Code compatibility copy.

Before editing, run `git status --short --branch` and preserve inherited
work. If `.codegraph/` exists, use CodeGraph before text search; otherwise
continue with normal repository tools and do not create an index.

## Non-negotiable architecture

- Two modes are supported: free local BYOK, and optional paid managed AI. The
  managed service is project-operated and multi-tenant; self-hosted history
  remains supported for users who want their own deployment.
- Google Meet capture is extension-owned and helperless. The Rust/Tauri helper
  owns long-running desktop-call capture, transcription/summarization,
  retries, and crash recovery for Zoom, Teams, Slack, and other desktop apps.
- Raw audio is persisted locally before any provider call or managed upload.
- Local BYOK keys stay in `chrome.storage.local`; managed provider secrets stay
  server-side and never reach the extension.
- Extension ↔ helper communication is Chrome Native Messaging plus the
  local Unix socket/named-pipe relay. Never add an open TCP/localhost port.
- Wrap BlackHole, base VB-CABLE, or a PulseAudio/PipeWire null sink; do not
  create a custom virtual-audio driver. Keep mic and speaker separate.
- Persist raw audio locally before every provider call. Keep provider keys in
  `chrome.storage.local` only.
- Keep the committed `extension/manifest.json` key unchanged.
- Keep both helper binaries: `notetaker-nm-host` is the trivial per-connection
  relay; `notetaker-helper` is the persistent Tauri tray app.

## Verification and handoff

Run the focused checks for every changed surface, then report local tests,
builds, commits, pushes, deployments, and interactive/provider proof
separately. Before committing a change under `helper/`, `extension/`, or
`webapp/`, manually review the diff against `CLAUDE.md` and the guardrails
skill. Update `TODO.md` as work lands; deferments must be explicit.

Required release-floor commands:

```sh
cd helper && cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
cd extension && npm run typecheck && npm test && npm run build
cd webapp && npx prisma generate && npm test && npm run build
```
