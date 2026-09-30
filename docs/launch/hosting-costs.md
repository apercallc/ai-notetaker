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
  the Groq default (list rates in `hosted-deployment.md`). Uploads are capped at
  1.9 GB, about 2.75 hours, so a worst-case Pro month (300 meetings) could cost
  far more than the $12 price. Typical use is a few dollars. A monthly
  audio-minutes cap is the safeguard; it is a product decision, not yet made.
- **Egress to providers.** The worker sends 48 kHz PCM to Groq, about 0.7 GB per
  two-channel hour, roughly $0.035 at $0.05 per GB. Sending 16 kHz would cut that
  about 3x (saving about $0.02 per hour) at a small audio-quality risk, because
  the resampling filter matters. Low value; not done.
- **Object storage.** Staged audio is transient (deleted after each job; a
  48-hour worker sweep catches strays), so storage cost is near zero. A
  Cloudflare R2 bucket with a 1-day lifecycle rule is an optional second safety
  net, not a requirement.
