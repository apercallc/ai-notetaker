# Scaling AI Notetaker without losing money

Planning snapshot: 2026-09-30. Target: **100 million registered users**, not
100 million concurrent recordings. The primary scenario assumes 1% use paid
Hosted AI; 10% and 100% are sensitivity cases. These are hypothetical workloads,
not traction, measured capacity, negotiated prices, or guaranteed profit.

## Decision

Keep free local BYOK genuinely local and account-free. Its audio and provider
traffic do not pass through our service. Monetize Hosted AI with explicit audio,
meeting, storage, and concurrency allowances. Grow capacity when measurements
justify it. A large registered-user count alone must not trigger expensive cloud
provisioning, continuous per-user polling, or a permanent cloud audio library.

The current $12 Pro / 60-hour and $39 Team / 200-hour allowances do **not**
support a 70% contribution-margin target when fully used at today's retail
rates and current audio transport. Typical light usage can be profitable;
heavy use and retries expose thin margins. Existing allowances are preserved
by this change. Before broad paid launch, choose new-plan allowances or prices
based on measured cost, and honor existing paid commitments.

## Reproducible economics

Run `node scripts/scale-cost-model.mjs` or supply JSON overrides:

```sh
node scripts/scale-cost-model.mjs '{"paidFraction":0.1,"hoursPerPaidUser":20}'
node scripts/scale-cost-model.mjs '{"monthlyPrice":39,"hoursPerPaidUser":200}'
```

List-rate inputs checked against primary sources on 2026-09-30:

| Input | Planning value | Source |
| --- | --- | --- |
| Whisper Large V3 Turbo | $0.04 per **channel** hour | [Groq speech docs](https://console.groq.com/docs/speech-to-text) |
| GPT-6 Luna | $0.10/M input; $0.50/M output tokens | [OpenAI model pricing](https://developers.openai.com/api/docs/models/gpt-6-luna) |
| R2 Standard | $0.015/GB-month; $4.50/M writes; $0.36/M reads; no R2 egress fee | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| Railway container egress | $0.05/GB | [Railway resource pricing](https://docs.railway.com/pricing/plans) |
| US domestic card payments | 2.9% + $0.30 | [Stripe Payments](https://stripe.com/pricing) |
| Stripe Billing pay-as-you-go | 0.7% of billing volume | [Stripe Billing](https://stripe.com/billing/pricing) |

R2 free egress does not eliminate Railway's outbound charges. With our current
proxy upload path, audio leaves Railway once for web→R2 staging and again for
worker→transcription provider. At 48 kHz PCM16 mono × two channels, one meeting
hour is **0.6912 decimal GB**. Those two hops cost about $0.0691/hour before
retries; transcription costs $0.08/hour. The older hosting estimate counted
only one egress hop and understated worst-case delivery cost.

Model assumptions: 10% extra provider attempts, two 30-minute meetings/hour,
$0.0025 summary cost/meeting (20k input + 1k output tokens; allowance rather than
measured token usage), 24-hour average staging residence, and **$1/month per
paid workspace reserved for compute, database and support**. This $1 is an
unvalidated budget, not an infrastructure quote. Actual shared infrastructure,
logs, backups and free-account costs must be allocated to paid users. Failed
provider attempts can still incur bills even when customer quota is refunded.

Estimated variable delivery cost: **$0.1672 per two-channel meeting hour**.
This excludes acquisition, development, taxes, chargebacks, refund losses and
fixed overhead. Payment rates vary by country/card; enterprise contracts may
change all provider rates. Contribution is not company net profit.

| Case per paid workspace/month | Revenue | Modeled cost incl. fees and $1 reserve | Contribution margin |
| --- | ---: | ---: | ---: |
| Pro, 10 hours | $12 | $3.40 | 71.6% |
| Pro, current 60-hour ceiling | $12 | $11.77 | 1.9% |
| Team, current 200-hour ceiling | $39 | $36.15 | 7.3% |

At these assumptions the 70% target supports about **11.2 Pro hours** or
**53.8 Team hours**, before unexpected costs. Recommendation for new plans:
10 Pro hours and 50 Team hours, or raise prices / sell explicitly purchased
hour packs. Start hour-pack modeling around $0.60/hour, sell in batches so
fixed transaction fees do not dominate, and validate discounts at the actual
payment/provider contract. Do not enable automatic paid overages without
customer consent. Keep the meeting-count ceiling as an additional abuse guard.

## Workload, not just registered users

Assume every paid user is one Pro workspace using 10 hours/month. Team users
share workspace allowances, so do not multiply the flat Team price by seats.

| Paid fraction of 100M registered users | Paid workspaces | Audio h/month | Gross revenue/month | Modeled delivery cost/month |
| --- | ---: | ---: | ---: | ---: |
| 1% | 1M | 10M | $12M | $3.40M |
| 10% | 10M | 100M | $120M | $34.04M |
| 100% | 100M | 1B | $1.2B | $340.43M |

Linear cost extrapolation is only a planning baseline. At even the 1% case,
there are 20M meetings/month and 6.912 PB/month of raw audio ingress: average
2.67 GB/s, with a hypothetical 10× peak of 26.7 GB/s. Packed uploads still
average ~640 chunk requests/second before retries, auth, status and completion
traffic. One Railway/Postgres deployment and default provider quotas cannot be
assumed to handle that. Obtain contracted throughput and measure peak traffic.

Free BYOK audio has zero project provider cost, but distribution, support,
optional hosted accounts and synchronized history have real costs. Even a
$0.001/month allowance for each of 99M free users adds $99k/month. Keep cloud
history opt-in, put a clear bounded retention/size policy on it, and show its
cost in the cohort model. Unlimited free cloud history is not approved here.

## Changes implemented in this audit

- Hosted Meet frames are streamed into deterministic **4 MiB per-channel upload
  chunks**; original PCM samples remain unchanged and raw IndexedDB audio stays
  local until processing succeeds. The previous 0.5s frames meant ~14,400
  requests/hour, exceeding the server's 10,000-chunk ceiling after ~42 minutes.
  Packing produces ~166/hour: ~87× fewer chunk requests, objects and rows, with
  bounded buffers. A versioned upload layout preserves retry idempotency and
  avoids conflicts with old manifests; old incomplete staging expires normally.
- Helper capture backlog stores disk ranges rather than retaining PCM vectors.
  Live socket backlog is bounded; local recovery audio remains durable.
- Quota reads aggregate audio and meeting counts together; hour exhaustion now
  appears correctly in billing. Serializable quota reservations remain intact.
- Global job polling and expiry get suitable database indexes. Cleanup queries
  are capped at 100 manifests; object deletion concurrency is capped at 16.
- Object orphan sweeps continue past the first five listing pages across passes;
  bounded manifest cleanup rotates past failures instead of starving later audio.
- Upload and meeting-ownership races are closed; failed UI processing exposes a
  retry, avoiding unnecessary duplicate support/upload work.
- Releases use the actual CI-checked commit and atomic branch/tag publication.

These improvements reduce specific known amplification paths. They are not a
100M-user capacity certification. The index migration is tested locally and
must be deployed through the normal migration/release process.

## Implementation order and acceptance gates

### 1. Before opening Hosted AI broadly

1. **Record irreversible provider spend separately from customer quotas.**
   Persist an attempt ledger per provider window/summary, reserve estimated
   spend before a request, reconcile reported tokens/duration, and record
   failed/ambiguous attempts. Refunding a meeting must never erase real spend.
   Add deployment/day, workspace/day and trial-cohort spend limits. A single
   global admission control must reject new work when the budget is exhausted;
   allow downloads, recovery and already-reserved work to finish safely.
2. **Control trial liability.** Email verification is necessary but insufficient
   against repeated signup. Add privacy-conscious signup velocity/abuse checks,
   daily cohort grants, provider account limits and operator budget alerts.
   100M fully used 3-hour trials alone imply 300M hours and ~$50M variable cost
   under this model, with no subscription revenue. Do not treat trial refunds
   or per-account caps as a global safety net.
3. **Measure actual unit cost.** Track billed channel seconds, minimum-billed
   requests, provider attempts, input/output/reasoning tokens, uploaded bytes,
   egress hops, object ops, DB time, worker time, refunds and support by plan.
   Existing ProcessingJob costMicros is an estimate; reconcile invoices.
   Alert at 50/80/100% daily budget and when rolling plan contribution <70%.
4. **Move cleanup off the job-poll hot path.** A scheduled cleaner should page
   workspaces and expired manifests using durable cursors, isolate persistent
   object-deletion failures in a retry queue, and use staging-prefix lifecycle
   expiration as a second safety net. Current in-process listing and manifest
   progress resets on restart; frequent restarts can revisit the same prefix.
   Configure object expiry beyond the allowed active processing/retry lifetime,
   and verify it cannot delete a live lease's data.
5. **Add operational proof.** Run real provider, Stripe, Chrome Meet and native
   OS flows, backup/restore, worker crash/reclaim, concurrent upload/claim, and
   retention deletion checks before declaring production-ready. Load-test with
   synthetic local audio; do not generate a massive live provider bill.

### 2. When paid activity outgrows the single deployment

- Separate upload admission, web/history reads, processing and cleanup capacity.
  Queue small job references, never audio bytes. Use durable leased work and
  bounded provider concurrency; start with existing database job claims and
  move to a dedicated queue when measured polling/claim load warrants it.
  Autoscale on oldest ready-job age plus available provider budget/quotas, with
  a hard replica ceiling. More workers do not fix an upstream 429 limit.
- Add **direct signed private object uploads** after server-side entitlement
  and staging reservation. Expiring keys must bind workspace/upload/index,
  size, checksum and channel; completion must independently verify storage
  metadata. Preserve raw-local-first and retry idempotency. This removes
  web→R2 proxy egress and large-body web CPU. Test cross-tenant and stale-key
  attempts before enabling it. Multipart/packing must stay protocol-versioned.
- Benchmark lossless FLAC or well-filtered 16 kHz provider staging while keeping
  original raw audio locally. A 3× PCM reduction saves network/objects, not
  provider billed duration. Ship only if transcription quality, quiet speech,
  noise, language and timing fixtures pass. Avoid silently dropping silence
  or overlapping speaker channels to save money.
- Separate tenant reads from global maintenance queries; use bounded keyset
  pagination, query plans and connection pooling. Global indexes landed now.
  At larger tables, plan online/concurrent index creation; today's plain index
  migration is intended for the small prelaunch database.
- Reduce status polling with adaptive backoff and push updates where useful.
  Cache public static content at the edge; cache private reads only with tenant
  keys and explicit invalidation/revocation behavior. Never share raw audio or
  customer transcripts across tenant caches to save cost.

### 3. Regional scale and the 100M-registration case

- Route workspaces to regional cells. Each cell owns tenant metadata, private
  storage, queue and processing budgets; maintain one billing identity and
  auditable routing. Add cells based on measured headroom, not user-count lore.
- Negotiate provider and payment quotas/prices before committing peak capacity.
  At 10M hours/month, provider channel throughput is 20M hours/month; that is
  roughly 2.4B channel seconds/day on average, requiring explicit capacity
  agreements. Use degraded queued service during outages, with honest status.
- Partition large job/usage/attempt/history tables by appropriate time/tenant
  keys when query plans and maintenance require it. Archive bounded history
  under a disclosed policy. Estimate rows/meeting and retention before buying
  storage; 20M meetings/month can create billions of transcript rows.
- Keep control-plane admission global enough to bound aggregate spend, but
  distribute signed budget allocations to cells to avoid a global lock on every
  audio frame. Use reserved allocations, expiry, reconciliation and fail-closed
  exhaustion; eventual counters alone cannot enforce a hard spend ceiling.

Proposed operating targets, to validate with benchmarks: p95 history/API reads
<300ms, upload error rate <0.1%, job admission <1s, queued age <60s at normal
load, no stale active leases or cross-workspace data access. Start scaling when
sustained DB CPU >60%, connection/worker memory >70%, or latency/queue-age
targets fail. Promote each stage only after a 2× projected peak soak, bounded
cost/meeting, tested deletion and recovery, and explicit rollback proof.

## Profitability rule

For each paid cohort:

`contribution = revenue - payment fees - provider attempts - transfer/storage
- allocated compute/database/observability - support/refunds`

Then subtract acquisition and fixed company costs to estimate net profit.
Require positive contribution even at the advertised allowance and stress it
with doubled provider attempts, 10× bursts and paid-plan mix changes. Free
trial issuance must fit its own budget. Do not fund unbounded free processing
or build a global platform before those conditions are demonstrated.
