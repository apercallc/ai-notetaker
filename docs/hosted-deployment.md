# Hosted AI deployment runbook

This runbook is for the optional project-operated managed service. Free local
BYOK remains the default and does not require an account or this deployment.
The hosted service owns provider credentials, usage limits, meeting notes,
processing jobs, and billing; the helper still saves raw audio locally before
uploading it for processing. Hosted audio is temporary staging only.

## Required services

- Next.js webapp with a persistent Postgres database.
- A shared private S3-compatible bucket for short-lived managed audio staging.
  Cloudflare R2 and existing S3 buckets are supported. Configure either the
  `R2_*` variables or `S3_*` variables on both webapp and worker. Grant only
  object read/write/delete access; do not enable public access or versioning.
  Workers delete audio immediately after successful processing and cleanup
  expires failed/abandoned uploads after 24 hours.
  **Use Cloudflare R2 for the project-operated service.** All large data
  (staged audio) goes through this one storage layer, so pointing it at R2 is
  configuration only: set `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID` and
  `R2_SECRET_ACCESS_KEY` on both webapp and worker (when `R2_BUCKET` is set it
  takes priority over `S3_*`; remove the `S3_*` variables afterwards). Then add
  an R2 lifecycle rule that deletes objects under the `uploads/` prefix after
  1 day. Railway Storage Buckets do not support lifecycle configuration.
  Whatever the provider, the worker also deletes staged audio older than
  48 hours every 30 minutes as a provider-independent backstop.
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
  Also set the selected transcription and summary provider keys on both
  services. Default managed processing uses Groq Whisper Large V3 Turbo and
  OpenAI GPT-6 Luna; Deepgram Nova-3 and Anthropic remain selectable.
  The webapp service runs migrations before serving, and the worker starts
  polling after the webapp health check is available.
- The released registry Compose file passes the same worker, provider, billing,
  and private temporary-storage variables as the source Compose file; do not assume the image alone
  carries deployment secrets.
- The selected managed provider keys: by default `MANAGED_GROQ_API_KEY` and
  `MANAGED_OPENAI_API_KEY`. Deepgram and Anthropic credentials are only needed
  when `MANAGED_TRANSCRIPTION_PROVIDER=deepgram` or
  `MANAGED_SUMMARY_PROVIDER=anthropic` is selected. The summary model defaults
  to the selected provider's model; set `MANAGED_SUMMARY_MODEL` only to
  override it with a model supported by that provider.
- Ask your notes runs in the webapp service (not the worker) with the same summary
  provider key and model. Set `MANAGED_CHAT_MODEL` on the webapp service only to
  give chat a different model. Its monthly question caps are
  `PLAN_CHAT_QUESTION_LIMITS` in `webapp/src/lib/plans.ts`; chat has no cost
  ledger yet, so watch provider spend before raising them.
- File import decodes uploads with `ffmpeg`/`ffprobe`, which the web Docker image
  installs. Jobs run in the web process (the worker only triggers them), so any
  other build (for example Nixpacks) must also provide both binaries or the
  `/import` page reports that import is unavailable. `FFMPEG_PATH` and
  `FFPROBE_PATH` override the binary locations. Imports use the live-capture
  transcription provider; set `MANAGED_IMPORT_TRANSCRIPTION_PROVIDER=deepgram`
  to label speakers on imported files at Deepgram's higher rate. Decoding uses
  scratch disk (up to the file size plus ~115 MB per hour of audio) under the
  system temp directory and removes it when the job ends.
- Stripe secret/webhook/price configuration when paid plans are enabled.

The default Groq transcription profile is cheaper and does not identify
individual speakers in the remote-audio channel; the transcript labels it
`Them`. Select Deepgram when individual speaker diarization is more important
than the lower transcription cost. Groq input is sent in bounded four-minute
WAV chunks (about 23 MB of 48 kHz mono PCM each) to fit its documented 25 MB
free-tier request limit. Published list rates currently put Groq Whisper Large
V3 Turbo at $0.04 per audio hour and GPT-6 Luna at $0.10/$0.50 per million
input/output tokens; Deepgram Nova-3 is $0.0043 per minute and Claude Sonnet 5
is $2/$10 per million tokens. The app sends microphone and speaker as separate
audio, so a one-hour meeting with both channels active costs about $0.08 for
Groq transcription or $0.52 for Deepgram transcription at these list rates,
plus the comparatively small summary-token charge. Actual provider invoices
depend on account tier, usage, and provider pricing changes. See the current [Groq](https://console.groq.com/docs/model/whisper-large-v3-turbo),
[Deepgram](https://deepgram.com/pricing), [OpenAI](https://developers.openai.com/api/docs/pricing),
and [Anthropic](https://www.anthropic.com/news/claude-sonnet-5) pricing pages.

Managed audio is uploaded to our temporary private staging bucket and then
sent to the selected transcription provider. Our staging copy is deleted after
processing or expires within 24 hours; the provider processes the audio under
its own account terms and retention settings. Summarization receives transcript
text, not audio.

The filesystem object backend remains available for local or self-hosted
deployments when no bucket is configured. Managed production requires a shared
private R2 or S3 bucket and does not fall back to local disk. Bucket contents
are processing staging, never hosted recordings: successful jobs purge audio
immediately, and the worker expires failed/abandoned audio within 24 hours.
The filesystem backend is suitable for a single-node self-hosted or Docker
deployment with the `ai-notetaker-objects` volume; it is not a substitute for
a shared bucket in a multi-instance hosted deployment.

## Environment and security

Start from `webapp/.env.example`. Generate long random values for
`AUTH_TOKEN` and `MANAGED_WORKER_TOKEN`; keep
`MANAGED_EXTENSION_ORIGIN` set to the fixed extension origin unless a
controlled fork changes the manifest key. The managed API allows CORS only
from that origin (and same-origin browser requests), never `*`. Never put
provider or Stripe secrets in extension settings, browser bundles, meeting
records, or client-visible configuration. Keep the bucket private, disable
versioning, and grant the webapp/worker only object read/write/delete
permissions for its configured prefix. Do not back up or replicate temporary
recording objects.

The managed API uses the per-user session returned by `/api/v1/auth/login`.
The legacy `/api/*` sync API remains `AUTH_TOKEN`-protected for self-hosted
compatibility. `/api/health` is the only unauthenticated health route;
Stripe webhooks are admitted only after signature verification. Failed login
budgets are stored in Postgres, so the same address throttle applies across
web replicas and survives a deployment.

## First deployment checklist

1. Provision Postgres and a shared private R2 or S3-compatible bucket scoped to
   short-lived processing objects.
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
5. Set the workspace note-retention policy from Team settings and verify the
   worker removes expired notes and shares. Audio must be purged after job
   success and after the 24-hour staging window, independent of note retention.
6. Upload a short two-channel fixture; verify checksums, the 24-hour abandoned
   upload expiry/restart behavior, job completion,
   transcript/summary persistence, successful audio-object deletion, abandoned
   upload cleanup, and bounded provider retry behavior for transient failures.
7. Exercise Stripe test checkout, portal, webhook replay, cancellation, and
   payment-failure grace expiry before enabling paid production prices.
8. Delete the meeting and verify the database rows and every private object
   are removed. Any leftover temporary object is also deleted. Review logs for
   orphan cleanup failures.
9. Run the OS/browser acceptance checklist in `TODO.md` and record real
   Chrome/Meet, Native Messaging, microphone, loopback, and provider evidence
   separately from unit/build output.

## Operations

- Back up Postgres. Keep audio staging out of backups and ensure the worker
  cleanup loop remains healthy; configure an object lifecycle expiry as a
  second deletion safeguard (R2 supports it; Railway buckets do not, which is
  why the worker's 48-hour orphan sweep exists).
- Monitor queued/error processing jobs, provider failures, usage reservations,
  webhook failures, and object cleanup failures. The managed worker poll also
  reaps expired upload rows and private chunk objects. Do not log transcripts,
  raw audio, bearer tokens, or provider keys.
- Rotate worker/provider/Stripe credentials through the deployment secret
  manager, then restart workers so the new values are loaded.
- Do not call the service released until the real provider, billing, storage,
  deployment, browser, and native-OS gates are complete. Desktop artifact
  signing is intentionally not a release prerequisite in the current budget
  plan; see the native download trust policy.
