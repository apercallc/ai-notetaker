# Testing and quality gates

The project has three independently testable surfaces. Run the focused gate
for the surface you change, then run the release-floor commands from the root
`AGENTS.md` before a release.

## Local commands

```sh
cd helper
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo llvm-cov --workspace --all-targets --summary-only

cd ../extension
npm run typecheck
npm test
npm run test:coverage
npm run build

cd ../webapp
npx prisma generate
npm run lint
npm run typecheck
npm run test:with-postgres
npm run test:coverage
npm run build
```

`npm run typecheck` is not redundant with `npm run build`: `next build`
typechecks only what it bundles, which leaves every `*.test.ts` outside the
type gate. Run it after `prisma generate`, or the generated client's types
won't resolve.

## Coverage policy

Coverage reports are generated in CI as artifacts and are intended to make
regressions visible. The 90% target applies to deterministic unit-testable
logic: the Rust core, extension protocol/storage/controller modules, and
webapp data/API modules. Native audio drivers, Tauri tray integration, Chrome
entrypoints, and rendered Next.js pages require OS/browser smoke coverage in
addition to unit tests because they cannot be faithfully tested with a fake
runtime alone.

A passing unit report is not evidence that a provider call, native audio
driver, OAuth-like browser flow, or production deployment has been exercised.
Those checks must be reported separately in release notes.

## Browser smoke evidence

On 2026-09-24, Chrome for Testing 148 loaded `extension/dist` with the
committed extension key. The live unpacked-extension smoke check verified:

- the first-run popup presents `Start with Google Meet`;
- that action opens `onboarding/onboarding.html?mode=meet`;
- the current generated popup bundle keeps Google Meet selected even when
  opened from a new tab or another site; desktop-helper setup appears only
  after selecting the explicit desktop capture mode. A fresh live-browser
  rerun of this post-fix popup path remains a release-owner acceptance gate;
- onboarding defaults to `google-meet` and does not render the helper download
  button;
- the public install page defaults to Google Meet/browser capture, while the
  explicit desktop-call choice's helper link adds `mode=desktop` and opens the
  desktop-call section;
- an older `?mode=desktop` onboarding URL is normalized back to Google Meet by
  the current bundle; the update-only reload for already-open legacy wizard
  tabs is implemented but still needs an actual extension-update event for
  browser acceptance.
- selecting Zoom explicitly renders the OS-specific helper installation step;
- a real `https://meet.google.com/abc-defg-hij` page receives the extension's
  Meet widget host.
- with a rebuilt Linux helper and a registered Native Messaging manifest, the
  live extension reports `connected` with helper protocol 3; a fresh Chrome
  profile also re-pairs when the helper already has a token.

This still does not prove a real participant call, microphone/tab-audio
permission grant, provider call, or physical macOS/Windows/Linux audio
capture. The Native Messaging result is Linux-only; macOS and Windows
installer/OS acceptance remain separate gates.
Branded Chrome in this environment rejects `--load-extension`; use Chrome for
Testing or a developer-loaded unpacked extension for this smoke check.

## Test isolation and sensitive data

Webapp integration tests use a disposable Postgres database and must never
use a production `DATABASE_URL`. Tests and fixtures must not contain live
provider keys, access tokens, recordings, or personal meeting content.
