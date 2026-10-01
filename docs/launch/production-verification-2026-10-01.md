# Production verification — 2026-10-01

## Repository and deployment

- Implementation: `cbff594` — hosted spend controls, standalone processing,
  durable cleanup, direct-upload support and staged scaling configuration.
- CI fixture fix: `967b654` — identify concurrent transcription responses by
  audio bytes rather than nondeterministic request order.
- Existing release automation created `1bca3d6`, tag `v0.15.0`, updating all
  package versions together. Release manifest validation passed.
- Railway web and managed-worker deployments for `1bca3d6` reached `SUCCESS`.
  Documentation updates following this release do not change shipped code.

## Checks passed

- Webapp: 760 tests, fresh Postgres migrations, Prisma generation, typecheck,
  lint, production build and existing coverage thresholds.
- Extension: 595 tests, typecheck, build and existing coverage thresholds.
  Added storage-write recovery and attendee-notice tests to repair the prior
  function-coverage failure; thresholds were preserved.
- Helper: local formatting, strict workspace Clippy and workspace tests;
  hosted CI passed on Linux, macOS and Windows, including native bundles and
  the dependency audit.
- Standalone worker with default maintenance executed successfully against an
  isolated local database; Compose configuration and diff checks passed.
- Local backup/restore drill restored 35 migrations and a synthetic spend
  counter. This is local evidence, not a production backup recovery drill.

Source CI evidence: [webapp](https://github.com/apercallc/ai-notetaker/actions/runs/36918154750),
[extension](https://github.com/apercallc/ai-notetaker/actions/runs/36918154753),
[helper](https://github.com/apercallc/ai-notetaker/actions/runs/36918154794),
[release metadata automation](https://github.com/apercallc/ai-notetaker/actions/runs/36918154790).

## Live evidence

- `/api/health`: HTTP 200, `ok=true`, `managedReady=true`, existing S3-compatible
  storage configuration.
- `/pricing` and `/login`: HTTP 200.
- Unauthenticated `/api/v1/entitlements`: HTTP 401. Legacy managed
  `/api/meetings`: HTTP 404, preserving the disabled legacy ingestion route.
- Production Prisma migration status: all 35 migrations applied.
- The operator cost report ran inside the live worker. At verification it
  showed no provider attempts, zero new trial grants and no queued backlog for
  the UTC day. No paid provider request was issued for these checks.
- Current standalone-worker log snapshot showed no maintenance or processing
  operation failures. An earlier transient maintenance failure during the
  rolling migration was followed by successful startup and cleanup readiness.
- Web and worker configuration matches for the database, storage, provider
  credentials and daily budgets; both keep direct uploads disabled.

## Capacity and cost

The before/after Railway inventory contains the same web, managed-worker and
Postgres service IDs and configured replica counts. No cleaner service,
database replica, region, storage service, capacity reservation or resource
resize was added. Cleanup runs in the existing worker between jobs under a
shared lease. Provider admission caps are $25/day overall, $5/day per workspace,
$5/day for trials, and 20 newly granted trials/day. They are limits, not a
commitment to spend; actual provider invoices can differ from estimates.

Prices and included hours remain unchanged. Existing infrastructure billing
still depends on actual compute, storage and usage; this work does not claim
that all usage is free. Future capacity increases require measured queue
latency, database/provider headroom and margin checks, as described in the
[rollout guide](infrastructure-rollout.md).

## Evidence boundaries

Direct private uploads remain off pending real bucket CORS and client checks.
No live authenticated recording, paid transcription, payment, OAuth journey
or physical-device/browser capture was exercised in this verification. The
code and deployed health checks do not establish 100-million-user capacity.
Production backup recovery, alert routing and invoice reconciliation remain
operational follow-ups. The separately dispatched `v0.15.0` release artifact
build was still running when this report was prepared; installer/store
publication and signing are separate from the successful hosted deployment.
