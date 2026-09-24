# Hosted AI deployment runbook

This runbook is for the optional project-operated managed service. Free local
BYOK remains the default and does not require an account or this deployment.
The hosted service owns provider credentials, usage limits, private meeting
objects, processing jobs, and billing; the helper still saves raw audio locally
before uploading it.

## Required services

- Next.js webapp with a persistent Postgres database.
- A private S3-compatible object bucket for managed audio chunks. Set
  `S3_BUCKET`, `S3_REGION`, and server-side credentials; set `S3_ENDPOINT` for
  R2, MinIO, or another compatible provider and `S3_FORCE_PATH_STYLE=true` when
  that provider requires path-style requests.
- A durable managed worker. The source and registry Compose files ship a
  first-party worker under the `managed` profile; start it with
  `docker compose --profile managed up -d --build`. It polls
  `/api/v1/jobs/next` with `MANAGED_WORKER_TOKEN`, retries transient endpoint
  failures with bounded backoff, and does not run at all for local/BYOK-only
  deployments. A different scheduler may call the same endpoint instead.
  Worker claims carry a 15-minute lease, so a job left `processing` by a
  crashed worker is eligible for the next poll and cannot be finalized by a
  stale worker after it has been reclaimed.
- On Railway, deploy the webapp and worker as separate services from the same
  `webapp/` source. Use `railway.json` for the webapp service and
  `railway-worker.json` for the worker service. Give both services the same
  `DATABASE_URL`, `AUTH_TOKEN`, and `MANAGED_WORKER_TOKEN`; set the worker's
  `MANAGED_WORKER_WEBAPP_URL` to the webapp's private or HTTPS service URL.
  The webapp service runs migrations before serving, and the worker starts
  polling after the webapp health check is available.
- The released registry Compose file passes the same worker, provider, billing,
  and S3 variables as the source Compose file; do not assume the image alone
  carries deployment secrets.
- Deepgram and Anthropic server-side keys, plus Stripe secret/webhook/price
  configuration when paid plans are enabled.

The filesystem object backend remains available when `S3_BUCKET` is unset. It
is suitable for a single-node self-hosted or Docker deployment with the
`ai-notetaker-objects` volume; it is not a substitute for a shared bucket in a
multi-instance hosted deployment.

## Environment and security

Start from `webapp/.env.example`. Generate long random values for
`AUTH_TOKEN` and `MANAGED_WORKER_TOKEN`; keep
`MANAGED_EXTENSION_ORIGIN` set to the fixed extension origin unless a
controlled fork changes the manifest key. The managed API allows CORS only
from that origin (and same-origin browser requests), never `*`. Never put
provider or Stripe secrets in extension settings, browser bundles, meeting
records, or client-visible configuration. Keep the bucket private and grant
the webapp only object read/write/delete permissions for its configured
prefix.

The managed API uses the per-user session returned by `/api/v1/auth/login`.
The legacy `/api/*` sync API remains `AUTH_TOKEN`-protected for self-hosted
compatibility. `/api/health` is the only unauthenticated health route;
Stripe webhooks are admitted only after signature verification. Failed login
budgets are stored in Postgres, so the same address throttle applies across
web replicas and survives a deployment.

## First deployment checklist

1. Provision Postgres and the private object bucket.
2. Configure the environment variables and deploy the webapp plus the managed
   worker profile. With Compose, run
   `docker compose --profile managed up -d`; the entrypoint applies migrations
   before serving traffic and the worker waits for the healthy webapp.
3. Open `/api/health` and verify the response reports `mode: "managed"` and
   `managedReady: true`; verify the separate worker service is running and
   logs `managed worker idle` or a processed job. A `managedReady: false`
   response means required worker, provider, Stripe, or app-URL configuration
   is incomplete and must not be treated as a release-ready service.
4. Create a managed account, sign in through the extension, and verify the
   returned workspace ID is unique to that account.
5. Set the workspace retention policy from Team settings and verify the worker
   removes an expired meeting, its shares, and private recording objects.
6. Upload a short two-channel fixture; verify checksums, the 24-hour abandoned
   upload expiry/restart behavior, job completion,
   transcript/summary persistence, separate mic/speaker recording reads, and
   bounded provider retry behavior for transient failures.
7. Exercise Stripe test checkout, portal, webhook replay, cancellation, and
   payment-failure grace expiry before enabling paid production prices.
8. Delete the meeting and verify the database rows and every private object
   are removed. Review logs for orphan cleanup failures.
9. Run the OS/browser acceptance checklist in `TODO.md` and record real
   Chrome/Meet, Native Messaging, microphone, loopback, and provider evidence
   separately from unit/build output.

## Operations

- Back up Postgres and configure object-bucket lifecycle/retention rules.
- Monitor queued/error processing jobs, provider failures, usage reservations,
  webhook failures, and object cleanup failures. The managed worker poll also
  reaps expired upload rows and private chunk objects. Do not log transcripts,
  raw audio, bearer tokens, or provider keys.
- Rotate worker/provider/Stripe credentials through the deployment secret
  manager, then restart workers so the new values are loaded.
- Do not call the service released until the real provider, billing, storage,
  deployment, signing, browser, and native-OS gates are complete.
