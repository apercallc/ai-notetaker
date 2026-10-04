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

- The Tauri desktop app is the primary product. It owns setup, recording,
  local BYOK processing, local history, and recovery for browser and desktop
  calls. Local BYOK requires no AI Notetaker account. The web app is optional;
  desktop sync sends finalized note text through its authenticated API.
- The browser extension records Google Meet audio into IndexedDB for desktop
  import. It does not process new calls with browser provider keys or start
  desktop calls. Keep older recordings and settings accessible until the
  archive path and desktop acceptance gates pass.
- Raw audio is persisted locally before any provider call or managed upload.
- New desktop BYOK keys stay in the operating system credential vault; never
  send them to the web app. Existing extension keys remain in
  `chrome.storage.local` during the migration window.
- Desktop UI ↔ Rust communication uses Tauri IPC. Existing extension ↔ helper
  Native Messaging and the local Unix socket/named-pipe relay remain only for
  compatibility until migration acceptance. Never add an open TCP/localhost
  port.
- Wrap BlackHole, base VB-CABLE, or a PulseAudio/PipeWire null sink; do not
  create a custom virtual-audio driver. Keep mic and speaker separate.
- Persist raw audio locally before every provider call. Keep new app provider
  keys in the OS credential vault; legacy extension keys stay in
  `chrome.storage.local` until safely migrated.
- Keep the committed `extension/manifest.json` key unchanged while legacy
  extension support remains.
- Keep the Native Messaging relay during migration; remove it only after the
  desktop-only workflow and old-user data migration pass acceptance.
- The `notetaker-helper` Tauri app gains the primary window and customer
  controls; the tray becomes a secondary surface.

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


<claude-mem-context>
# Memory Context

# [ai-notetaker] recent context, 2026-10-03 10:56pm CDT

Legend: 🎯session 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision 🚨security_alert 🔐security_note
Format: ID TIME TYPE TITLE
Fetch details: get_observations([IDs]) | Search: mem-search skill

Stats: 50 obs (10,964t read) | 598,535t work | 98% savings

### Sep 22, 2026
S354 Progress summary for completion of four batch items from original scope selection (Sep 22 at 6:10 PM)
S353 Scan project for remaining work and assess feasibility of easy driver install, updates, and web+extension integration (Sep 22 at 6:10 PM)
### Sep 23, 2026
S355 Confirmed clean working tree and pushed documentation and calendar timeout fix commits to main (Sep 23 at 5:19 PM)
S356 Project scan for remaining installation, driver, update, web, and extension work (Sep 23 at 5:21 PM)
S357 Scan entire codebase for issues, gaps, and improvement opportunities; fix all findings found. (Sep 23 at 5:23 PM)
11390 6:13p ✅ Added lint and typecheck steps to CI workflow
11391 " 🔴 Prevented double startRecording calls with startInFlight guard
11392 " ✅ Introduced RETRYABLE_HELPER_ERROR_PREFIXES constant for error prefix matching
11393 " 🟣 Enhanced Outlook event parsing with all-day detection and time zone handling
11397 " 🔴 Fixed IPC socket stale file handling to prevent permanent bind failures
11398 " 🔴 Fixed pairing token blank-file deadlock and added constant-time comparison
11399 " 🔴 Fixed pending_processing_meeting_ids missing summary-only meetings
11400 " 🔴 Fixed pipeline session None panic and added summarize-after-giving-up
11401 " ✅ Updated coverage metrics and Rust test count in TODO.md
11402 6:14p 🟣 Implemented login throttling with failure tracking
11403 " 🔄 Refactored team member addition to return results instead of throwing errors
11404 " 🔴 Fixed meeting pagination to prevent duplicate/missing meetings
11405 " 🟣 Implemented session reaping for abandoned sessions
11406 " 🟣 Implemented in-process login throttling with email-based rate limiting
11407 " 🔵 Discovered installed Rust cross-compile targets for Windows
11408 " 🔵 Extension manifest key already configured
11409 " 🔐 Extension URL and storage security constraints confirmed
11410 " 🔵 Extension supports multiple AI transcription and summarization providers
11411 " 🔵 Extension outbound HTTPS hosts identified
11412 " 🔵 Electron not found in helper crate configuration
11413 " 🔵 Rust unwrap/expect/panic usage identified in non-test code
11414 " 🔵 Provider error mapping and client configuration documented
11415 " 🔵 Audio capture trait contract and platform architecture defined
11416 " 🔵 Deepgram uses batch REST endpoint instead of spec-mandated streaming WebSocket
11417 " 🔵 Helper confirmed as Tauri/Rust, not Electron; no bundled drivers in repo
11418 " 🔵 Two non-test panic sites identified in Rust source
11419 " 🔵 Provider error enum maps to native messaging error codes
11420 " 🔵 Audio capture trait wraps platform-specific virtual audio device drivers
11421 " 🔵 Deepgram uses batch REST endpoint instead of spec-mandated streaming WebSocket
11423 " 🟣 Double-start guard prevents duplicate recording starts
11424 " ✅ Reconnect backoff replaces instant retry on disconnect
11425 " ✅ Retryable error prefixes synchronized across TS and Rust
11426 " 🔵 accepting_audio guard prevents audio callbacks from reopening finalized meetings
11427 " ✅ Comment typo fix in nativeMessaging.ts reconnect logic
11428 " 🔵 Webapp authentication remains centrally enforced
11429 6:15p 🔵 Helper startup recovers interrupted recordings
11430 " ✅ Comment updated to clarify retry behavior
11431 " 🔵 Retry queue and crash recovery paths identified
11433 " 🔵 Provider key validation routes through helper IPC
11437 " ✅ **Webapp quality gate now includes explicit lint and typecheck**
S358 Scan entire codebase for issues, gaps, and improvement opportunities; fix all findings found. (Sep 23 at 6:16 PM)
S359 Repository-wide quality audit — scan entire code base for issues, gaps, and opportunities; fix all findings found. (Sep 23 at 6:16 PM)
11438 6:17p 🔵 Working tree shows extensive modifications from recent fixes
11439 " 🔵 Rust helper final gate running in background
11440 " 🔵 Extension passes typecheck, tests, and build after fixes
11441 " 🔵 Rust helper final gate completed successfully
11442 " 🔵 Webapp passes all quality gates
11443 6:18p 🔄 Audit changes staged across extension, webapp, and helper crates
11444 " 🔴 Repository-wide quality audit committed (sha 1c2a17b)
11445 " ✅ Audit commit pushed to origin/main
11446 " ⚖️ TODO.md documents single-instance caveat for login throttle
11447 6:37p ✅ **Repository audit changes are committed and pushed**
S360 **Repository-wide quality audit — scan, fix, and verify all issues across the codebase.** (Sep 23 at 6:37 PM)
**Investigated**: Full codebase scan for bugs, gaps, and improvement opportunities. Guardrails review completed two turns ago with zero violations found. Git state verified: clean working tree, HEAD synced with origin/main.

**Learned**: The audit commit `1c2a17b` addresses lockouts, attribute injection, and stranded state. The prior commit `acca591` wired release signing, fixed accessibility/design gaps, and verified license compliance. CI runs on `aarch64-apple-darwin` only; Windows and Linux builds are reasoned but not compiled locally. Login throttle is in-process (single-node OK, breaks on horizontal scale).

**Completed**: - Audit changes committed (`1c2a17b`) and pushed (0 ahead/behind origin/main).
    - Guardrails review: no violations, nothing to fix.
    - Release signing, accessibility/design gaps, and license compliance addressed in `acca591`.

**Next Steps**: - Verify CI run for `1c2a17b` (Windows/Linux builds not compiled locally).
    - Configure repo secrets for Apple Developer certs and Windows code-signing.
    - Generate Tauri updater keypair and publish endpoint.
    - Test on real macOS/Windows/Linux hardware: audio routing, Chrome Native Messaging, BlackHole deep-link, Zoom/Meet/Teams/Slack meetings.
    - Accept native installers, package-manager paths, and Web Store/manual extension installs.
    - Consider Postgres-backed login throttle if scaling beyond single Railway node.


Access 599k tokens of past work via get_observations([IDs]) or mem-search skill.
</claude-mem-context>
