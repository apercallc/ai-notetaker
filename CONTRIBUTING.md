# Contributing to AI Notetaker

Thanks for helping improve a local-first meeting notetaker. Before opening a
change, read [`AGENTS.md`](AGENTS.md), [`CLAUDE.md`](CLAUDE.md), and the
package guidance for the surface you are changing.

## Local checks

Run the focused checks for every changed package:

```sh
cd helper && cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
cd ../extension && npm run typecheck && npm test && npm run build
cd ../webapp && npx prisma generate && npm run test:with-postgres && npm run build
```

The webapp tests use Postgres. `webapp/.env.example` documents the required
local variables; `npm run test:with-postgres` provisions a disposable database
and is the supported local test entrypoint. See
[`docs/testing.md`](docs/testing.md) for coverage commands and scope.

For changes under `helper/`, `extension/`, or `webapp/`, review the diff
against the guardrails before committing. UI changes should also receive a
design/accessibility review. Keep local builds, real OS/provider testing,
signing, deployment, and store submission as separate evidence.

## Architecture boundaries

- The extension owns botless Google Meet capture, IndexedDB-first browser
  durability, and Meet-local BYOK or managed processing. For desktop calls,
  it is a thin UI that communicates with the helper through Native Messaging.
- The helper owns long-running desktop capture, local BYOK processing,
  managed upload recovery, retries, and crash recovery.
- Do not add an open TCP or localhost WebSocket listener.
- Keep microphone and speaker audio separate and persist raw audio before a
  provider call.
- Local BYOK provider keys belong in `chrome.storage.local`; never add them to
  sync or send them to the hosted service. Managed provider keys stay
  server-side.
- The webapp supports both user-operated self-hosting and project-operated
  managed hosting, and must authenticate every route except `/api/health`.

## Pull requests

Describe the user-visible behavior, affected surfaces, tests run, and any
external proof that remains. Keep commits focused and update `TODO.md` when a
backlog item lands or its scope changes. Do not include API keys, recordings,
or provider responses containing private meeting data.
