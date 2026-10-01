# Hosting cost and performance notes

Measured on Railway production, 2026-09-30 (`get-service-metrics`, about 1 hour
of samples, no real traffic yet):

| Service | Avg CPU | Memory |
| --- | --- | --- |
| web | 0.0016 vCPU | 0.22 GB |
| managed-worker | 0.0005 vCPU | 0.09 GB |
| Postgres | 0.0006 vCPU | 0.05 GB |

Roughly $4 a month of compute plus about $0.75 for the 5 GB volume at Railway's
published rates. Every service runs one replica and is already near its floor,
so right-sizing saves cents. Not worth the risk: merging the worker into web
(about $0.90 a month), serverless sleep (the worker polls every 5 seconds, so
web would never sleep), or shrinking the volume.

## What actually moves cost

- **Deploy churn.** Every push rebuilt and restarted web and the worker, even
  docs-only ones. `build.watchPatterns: ["/webapp/**"]` in `railway.json` and
  `railway-worker.json` limits rebuilds to webapp changes.
- **Per-meeting provider cost.** About $0.09 per hour of two-channel audio on
  the Groq default (list rates in `hosted-deployment.md`). The meeting count
  alone let one workspace cost far more than its price (uploads can be 1.9 GB,
  about 2.75 hours, times 300 meetings). Implemented 2026-09-30: a monthly
  **audio-hours cap** per plan in `src/lib/plans.ts` (`PLAN_AUDIO_HOUR_LIMITS`:
  trial 3, Pro 60, Team 200), metered from the upload size (two-channel
  equivalent, 192 KB per second) in `usageLedger.ts`. It is checked when an
  upload starts (so nothing is staged for a refused recording) and again,
  serializably, when the job is queued; a failed job gives its hours back.
  The [scale and profitability model](scale-and-profitability.md) supersedes
  the earlier worst-case estimate: staging and provider upload incur two
  Railway egress hops, and refunded jobs can still incur provider bills.
  At full allowance utilization, current Pro and Team contribution margins
  are thin under the documented retail-rate assumptions.
  Change the numbers in one place. Marketing copy and the billing page read
  them from there.
- **Audio transfer.** Two-channel 48 kHz PCM is 0.6912 decimal GB/hour.
  Proxy staging (web→R2) plus provider upload (worker→Groq) total about
  $0.069/hour at $0.05/GB, before retries. Direct private object uploads and
  evaluated compression/resampling are prioritized in the scale plan.
- **Object storage.** Staged audio is transient (deleted after each job; a
  48-hour worker sweep catches strays). Storage and operation charges still
  grow with volume and residence time. Lifecycle expiration is a second safety
  net; choose its cutoff beyond permitted live upload/job leases and test it
  against recovery before enabling it.
