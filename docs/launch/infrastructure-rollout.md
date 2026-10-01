# Hosted infrastructure rollout

Implemented 2026-10-01. This is a deployment runbook, not proof of live capacity
or profitability. Local BYOK remains account-free and keeps its audio/provider
traffic off this infrastructure.

## Small footprint now, capacity when needed

Prepare the software to scale while keeping provisioned capacity matched to
current paid usage. These changes have not created, resized or deployed live
services. The service configurations below are deployment options, not an
instruction to reserve future capacity now.

- Reuse the current database, bucket and web service. Replace an existing
  worker with the standalone runtime rather than adding a second worker for
  the same workload. Start with one worker only when hosted processing is
  offered; local BYOK does not require a managed worker.
- The standalone worker runs bounded cleanup between jobs at most once per
  minute by default, using the shared lease. No additional cleaner service is
  needed for the current small stack. Long jobs can delay cleanup; use a
  reliable scheduler or dedicated cleaner if that delay becomes unacceptable.
  Set `MANAGED_WORKER_MAINTENANCE=false` only when that replacement is active.
  Where an existing scheduler is available, run
  `npm run managed:cleaner -- --once` periodically instead of keeping a
  separate cleaner replica running. Use the dedicated cleaner service if no
  reliable scheduler exists. Cleanup must continue while staged objects or
  deferred deletions remain, even if new processing is paused.
- Keep replica counts and concurrency explicitly bounded. Increase worker
  capacity only after sustained queue delays miss the chosen service target,
  and after checking provider limits, database headroom and contribution
  margin. Confirm that processing capacity, rather than provider throttling
  or a failing job, is the bottleneck.
- Upgrade database capacity only when measured connections, query latency,
  CPU or storage justify it. Introduce read replicas, regional deployments or
  database partitioning after measurements show the need.
- Track monthly fixed infrastructure cost separately from cost per processed
  hour. Set provider budgets for today's affordable usage and review them as
  paid demand grows. A large registered-user count alone is not a reason to
  provision compute; active hosted work and retained data drive capacity.

Load and recovery checks should precede each capacity increase. This gives a
path to expansion without claiming that current infrastructure has been
proven at 100 million users.

## Services and limits

Use the existing Railway Postgres and private R2 bucket initially. When
activating the hosted runtime, use the same revision for these roles, with
`webapp/` as the root. Cleanup may use scheduled one-shot execution above:

| Service | Config | Command | Initial replicas |
| --- | --- | --- | --- |
| Web/history | `railway.json` | migrations then Next.js | 1 |
| Processing | `railway-worker.json` | `npm run managed:worker` | 1 |
| Cleanup | existing worker by default | maintenance between jobs | 0 additional |

`railway-cleaner.json` and `npm run managed:cleaner` remain available for a
future separate cleanup service; provisioning it now is unnecessary.

The new processing runtime executes provider/storage work directly; it does
not ask Next.js to run it. All three need the same `DATABASE_URL`, private
storage configuration and integration encryption key. Processing needs
transcription and summary credentials. Web still needs summary credentials
for Ask and note regeneration. Secrets remain server-side.

Set `MANAGED_HOSTING=true`, `NODE_ENV=production`,
`MANAGED_WORKER_MODE=standalone`, `DATABASE_POOL_MAX=5` and
`MANAGED_WORKER_CONCURRENCY=2` consistently. The latter is a database-backed
**global job ceiling**, including legacy HTTP execution; a job may have two
channel requests in flight. Start with one worker. Explicitly cap platform
replicas and resources; inspect database headroom before raising either limit.
Cleaner replicas share a renewable lease. Cleanup pages/cursors and failed
object deletions survive restarts. Standalone workers no longer need
`MANAGED_WORKER_WEBAPP_URL`. The old HTTP poller remains available as
`npm run managed:worker:legacy`; dispatch requires explicit
`MANAGED_WORKER_MODE=http`.

## Budget admission

Configure integer USD micro-dollars (`1,000,000 = $1`):

- `MANAGED_DAILY_SPEND_MICROS`: total provider reservations per UTC day.
- `MANAGED_WORKSPACE_DAILY_SPEND_MICROS`: provider reservations per workspace/day.
- `MANAGED_TRIAL_DAILY_SPEND_MICROS`: shared trial provider reservations per day.
- `MANAGED_TRIAL_DAILY_GRANTS`: maximum newly issued trial workspaces per UTC day.

Missing/invalid managed budgets fail closed; zero pauses admission. The
2026-10-01 stability rollout configures $25/day global, $5/day per workspace,
$5/day trials, and 20 trial grants/day on the existing web/worker services.
These are admission ceilings, not reserved capacity or a commitment to spend.
Review them with paid demand; hitting a cap temporarily pauses affected
Hosted AI requests. Signup velocity throttles
and email verification remain in place; daily grants apply to email and Google
signup within the account-creation transaction.

Every provider attempt reserves spend atomically before sending, including
retries, chat and regeneration. Successful responses reconcile reported token
or audio-duration estimates. Timeouts, malformed bodies and failures retain
their conservative reservation. Customer quota refunds and content deletion
cannot erase financial attempts. A crashed attempt remains reserved until an
operator reconciles it against invoices; no automatic ambiguous-cost refund.

Defaults use the documented default models' estimated rates. For a custom
summary/chat model set the relevant `MANAGED_OPENAI_*_MICROS_PER_TOKEN` or
`MANAGED_ANTHROPIC_*_MICROS_PER_TOKEN` input/output rates. Reservations are
conservative estimates, **not a guarantee of provider invoices**. An actual
reported charge above its reservation is retained as debt and blocks later
admission when the budget is reached. Provider-account limits and invoice
reconciliation are still needed. Storage, egress, compute, payment and support
costs are separate from this provider ledger.

Run `npm run managed:cost-report -- YYYY-MM-DD` from a server environment.
It reports attempt counts, reserved/reconciled estimates, ambiguous spend,
50/80/100% budget status, trial issuance and oldest queued age without content
or credentials. Feed that output into operator monitoring; alert delivery and
full revenue/cohort contribution dashboards are not configured by this patch.

## Direct private uploads

Extension Meet, desktop helper and browser import clients support the new
path. It is **off by default**; older clients retain the authenticated proxy.

1. Configure exact bucket CORS using [r2-upload-cors.json](r2-upload-cors.json).
   Adjust the public app/extension origins for your deployment; never use a
   wildcard. Browser/extension clients use bucket CORS without adding a
   permanent storage host permission. The desktop helper uses a separate
   credential-free HTTPS storage client.
2. Set `MANAGED_OBJECT_UPLOAD_ORIGIN` to the actual bucket URL origin generated
   by the S3 SDK, e.g. `https://BUCKET.ACCOUNT.r2.cloudflarestorage.com`.
   This exact origin is also allowed by the web CSP; mismatched signing fails.
3. Confirm on real R2 that signed `content-length`, `content-type` and
   `if-none-match` work: wrong length fails, a second PUT returns 412, and
   browser preflight accepts the fixed extension origin and public app origin.
4. Exercise Chrome Meet, browser import and desktop upload/retry against that
   bucket, including a lost PUT response and revoked workspace access.
5. Only then enable `MANAGED_DIRECT_UPLOADS=true` on web.

Server tickets bind workspace, manifest index, channel, byte length and SHA-256
and reserve manifest capacity before signing. Signatures last at most 120 s
and cannot overwrite existing objects. Completion independently downloads one
bounded chunk to verify stored size/SHA-256. This removes web-to-R2 outbound
upload traffic; verification still uses web ingress and hashing. Original raw
audio remains local before every upload; packing/audio quality is unchanged.

Direct objects are retained until outstanding signatures plus a short grace
expire. Successful jobs otherwise delete staged audio promptly. Meeting and
workspace deletion retain independent cleanup records, including pending
tickets; storage failures retry with backoff. Staging's usual 24-hour deadline
excludes a live processing lease and the short capability grace. The 48-hour
orphan sweep is an absolute backstop. Set a bucket lifecycle only after proving
its age exceeds legitimate processing/retry/grace lifetimes; do not blindly
apply a one-day rule to active jobs. Backend identity keeps deletion retries
from running against a different bucket after reconfiguration.

R2 capabilities were checked against the official
[S3 compatibility table](https://developers.cloudflare.com/r2/api/s3/api/) and
[presigned URL guide](https://developers.cloudflare.com/r2/api/s3/presigned-urls/).
Real SDK signature tests use fake keys and make no network request; they do
not replace a live bucket/CORS check.

## Deployment sequence and rollback

1. Snapshot Postgres and verify a restore into an isolated database. Keep
   production backups encrypted, off the primary service, and monitored.
2. Set budgets/shared configuration, then apply the six additive migrations
   from `20261001190000_provider_spend` through
   `20261001195000_deferred_object_deletion` once through the web service.
3. Keep default worker cleanup enabled or configure its replacement, and replace/start one
   standalone worker for hosted processing, with direct uploads still disabled.
   Confirm real job progress, worker crash/reclaim, spending rows and cleanup.
4. Perform the real bucket/client checks above, then enable direct uploads.
5. Monitor attempts, backlog, deletion retries, CPU/memory/connections and
   invoices. Soak at twice the projected pilot peak using synthetic audio and
   stub providers before increasing replicas. Negotiate provider throughput
   before increasing paid load substantially.

To roll back direct transport, disable `MANAGED_DIRECT_UPLOADS`. Existing
direct tickets must be completed by the current client or expire normally;
do not force a ticket's chunk into the legacy PUT path. Keep cleaner running.
Roll back code only after queued direct manifests/tickets finish or expire;
older code cannot safely handle those new records. Keep additive migrations
and the financial ledger; never erase actual spend as part of rollback.

## Proof and remaining decisions

Local verification on 2026-10-01:

- Webapp: 760 tests across 83 files with fresh Postgres migrations;
  Prisma generation, typecheck, lint and production build passed.
- Extension: 595 tests across 49 files; typecheck and build passed.
- Helper: formatting, strict workspace Clippy and workspace tests passed.
- Compose configuration and diff whitespace checks passed. The operator cost
  report is included in the production image alongside both runtimes.

Local checks cover migrations, tenant isolation, concurrent spend/ticket
reservations, retry accounting, signature headers, trial grants and worker
leases. Standalone worker/cleaner `--once` and the cost report executed against
an isolated local Postgres. A local `pg_dump`/`pg_restore` drill restored all 35
migrations and a synthetic spend counter; it is not production backup proof.

Live deployment, provider invoices, CORS/client paths, backup policy, platform
spending limits, alert destinations and load capacity remain operational gates.
Plan pricing/allowances remain unchanged pending the business decision. The
existing fully consumed Pro/Team allowances still have thin margins. Follow
[the scale and profitability plan](scale-and-profitability.md) for pricing and
regional/database expansion; this patch does not claim 100M-user capacity.
