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
npm run test:with-postgres
npm run test:coverage
npm run build
npm run lint
```

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

## Test isolation and sensitive data

Webapp integration tests use a disposable Postgres database and must never
use a production `DATABASE_URL`. Tests and fixtures must not contain live
provider keys, access tokens, recordings, or personal meeting content.
