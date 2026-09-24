# AI Notetaker — Scribbl-like Dual-Mode Product Design

Date: 2026-09-24
Status: Approved direction; implementation migration in progress

## 1. Product decision

AI Notetaker becomes a botless meeting recorder and searchable meeting
workspace with two execution modes:

1. **Local BYOK (free):** no account is required. The Chrome extension and
   native helper capture locally, save raw audio before provider calls, and
   call transcription/LLM providers directly with keys supplied by the user.
2. **Managed AI (paid):** the same clients authenticate to a project-operated
   hosted service. The client still saves raw audio locally first, then
   uploads encrypted recording data. Hosted workers use platform-owned AI
   credentials, meter usage, enforce plan limits, and bill the account.

The managed service is an additional deployment topology, not a replacement
for the open-source local/self-hosted path. The existing self-hosted webapp
remains useful for users who want their own storage and BYOK execution.

The product goal is Scribbl-like simplicity: install once, detect a Google
Meet tab automatically, record without a bot joining the call, and finish
with a recording, transcript, summary, action items, searchable history, and
sharing/export controls.

## 2. Scope and explicit boundaries

### In scope

- Google Meet in Chrome through a botless extension capture path.
- Zoom, Microsoft Teams, Slack Huddles, browser calls, and other desktop or
  VoIP applications whose audio is available through supported OS capture
  APIs.
- macOS, Windows, and Linux desktop capture.
- Mic and remote/system audio as separate channels.
- Local-first recording durability and crash recovery in both modes.
- Local BYOK providers and hosted provider execution behind one pipeline
  contract.
- Hosted accounts, workspaces, usage metering, retention, deletion, and
  Stripe-backed paid plans.
- Searchable meeting library, transcript search, summaries, action items,
  sharing, Google Docs/Drive export, and recording downloads.

### Not promised

- Cellular/PSTN call interception. Mobile OS and telecom restrictions make
  this a separate product problem.
- DRM/protected or OS-suppressed audio that the capture API cannot expose.
- A meeting bot that joins a participant list.
- Silent recording. The UI must show recording state and consent guidance;
  regional recording law remains the user's responsibility.
- Replacing the project's open-source/self-hosted distribution with a
  hosted-only product.

## 3. Current-state migration map

The 2026-09-21 architecture is a historical baseline, not the target. Its
non-negotiable “no hosted backend, no billing, BYOK only” rules are superseded
by this document. These safety boundaries remain:

- Native Messaging remains the extension-to-helper control channel; no open
  TCP or localhost WebSocket is introduced.
- The helper remains the owner of long-running desktop capture and local
  resilience for desktop-call sources. Google Meet is the exception: the
  extension owns the offscreen tab capture and persists bounded chunks in
  extension IndexedDB, rehydrating the active meeting after a service-worker
  wake before processing or upload.
- Raw audio is persisted locally before every upload or provider call.
- Mic and system/remote audio remain independently persisted and processed.
- No custom kernel or virtual-audio driver is built. Native loopback APIs are
  preferred; BlackHole, VB-CABLE, and PipeWire/PulseAudio monitor sources are
  documented fallbacks.
- Provider keys remain out of the extension in managed mode. Local BYOK keys
  remain in protected local storage and are never synced through
  `chrome.storage.sync`.
- The committed extension manifest key and the two helper binaries remain.

## 4. Capture architecture

### 4.1 Google Meet browser path

When a tab is on `meet.google.com`, the extension offers an automatic
“Record this Meet” control. An offscreen document uses Chrome tab capture for
remote audio and the microphone path for the local speaker. The service worker
persists bounded chunks in extension IndexedDB before any BYOK provider call or
Hosted AI upload. The helper is optional for Meet: when present it can receive
the same chunks for live local processing; when absent the extension finishes
the browser-owned local or managed pipeline itself.

The extension must handle tab navigation, capture permission denial, the Meet
tab closing, one channel starting late, and service-worker reconnects without
losing the already captured channel.

### 4.2 Desktop universal path

The helper exposes one capture interface with platform adapters:

- macOS: ScreenCaptureKit/system-audio capture where available, with
  microphone capture through the native audio stack; BlackHole remains a
  guided fallback for unsupported OS/app combinations.
- Windows: WASAPI loopback for system output plus microphone capture;
  VB-CABLE remains a guided fallback for app-specific routing constraints.
- Linux: PipeWire/PulseAudio monitor-source capture plus microphone capture;
  the existing null-sink setup remains a fallback for distributions where a
  monitor source is unavailable.

The adapter reports capabilities and permissions before recording. It must
not claim “all calls” when the OS reports no loopback source. Each source is
written as its own durable stream and tagged with the capture source and
sample format.

## 5. Pipeline and execution modes

The core pipeline receives a `ProcessingMode` and a `MeetingCapture`:

```text
ProcessingMode = LocalByok(provider configuration)
              | Managed(account, workspace, plan)

MeetingCapture = MeetTab(chunks) | DesktopSystemAudio(channels)
```

The pipeline stages are shared:

1. Capture and append mic/system audio to local durable files.
2. Produce bounded transcription work units.
3. Execute either a direct local provider call or an authenticated managed
   upload/job request.
4. Stream partial transcript state to the extension when available.
5. Finalize transcript, summary, and action items.
6. Sync completed metadata and recording according to the selected mode.

Managed mode uses short-lived upload credentials or authenticated chunk
endpoints, idempotency keys per meeting/chunk, resumable uploads, and a job
status channel. The server never trusts client-reported usage or completion.

## 6. Hosted service architecture

The hosted topology adds these deployable components:

- **Web/API:** account, workspace, device/session, capture upload, meeting
  library, sharing, export, plan, and billing endpoints.
- **Postgres:** tenants, memberships, meetings, transcript segments, action
  items, usage ledger, subscriptions, upload manifests, job state, and audit
  events. Every tenant-owned row carries a workspace boundary.
- **Object storage:** encrypted raw audio/video and export artifacts with
  private-by-default keys and signed, expiring download URLs.
- **Workers/queue:** transcription, summarization, title/action extraction,
  retention cleanup, and failed-job retries. Jobs are idempotent and scoped
  to a workspace.
- **Billing:** Stripe Checkout/customer portal/webhooks. Entitlements come
  from verified webhook state; the client cannot grant itself paid capacity.
- **Provider gateway:** server-side provider adapters using platform-owned
  credentials, timeout/retry policy, quota reservation, and redacted
  correlation logs.

The managed service must support a free hosted allowance only when the
project can afford its provider/storage cost. The initial commercial design
therefore defaults to free local BYOK and paid managed AI; a limited hosted
trial may be added behind explicit quotas without changing the client
contract.

## 7. Privacy, security, and retention

- Managed uploads use TLS, authenticated sessions, workspace authorization,
  idempotency, size/type limits, and malware/content safety checks appropriate
  to the deployment.
- Provider secrets are server-side secret-manager values in managed mode and
  local protected storage in BYOK mode. They are never sent to the webapp
  browser bundle or persisted in meeting records.
- Raw recordings are private by default. Sharing creates a revocable,
  expiring capability scoped to one meeting; it does not make the library
  public.
- Users can delete a meeting locally, remotely, or everywhere, and can set a
  retention policy. Deletion marks the job/objects first, then removes them
  asynchronously with a visible status.
- Hosted logs contain workspace-safe IDs and failure categories, not audio,
  transcript bodies, provider keys, or bearer tokens.
- Consent state is recorded per meeting as user acknowledgement and displayed
  before capture; it is not treated as legal advice or a substitute for
  participant notice.

## 8. User experience

The first-run flow asks for the user's preferred mode:

- **Use my own AI key (free):** provider setup and local storage explanation.
- **Use hosted AI:** account sign-in, plan/usage explanation, and payment
  setup only when the user selects a paid plan.

The primary home surface is a meeting library, not a provider settings page.
It shows capture readiness, current mode, recording state, processing status,
search, filters, and retryable failures. Google Meet gets an in-call widget
and automatic tab detection. Desktop calls get a tray/popup control with
platform permission and source diagnostics.

## 9. Delivery order

1. Update contracts and documentation so no package still encodes the old
   product decision.
2. Finish Google Meet botless capture as a durable local recording source.
3. Add universal OS capture capability reporting and loopback adapters.
4. Extract a mode-neutral processing interface and preserve local BYOK.
5. Add hosted account/workspace/upload/job APIs and managed worker contracts.
6. Add hosted library/search/share/download and self-hosted compatibility.
7. Add usage ledger, Stripe entitlements, retention, and operational controls.
8. Run real Chrome/Meet and physical macOS/Windows/Linux acceptance tests;
   provider, billing, deployment, and signing proof are separate gates.

## 10. Success criteria

- A new Chrome user can recognize a Meet tab, start a botless recording, and
  recover a completed transcript/summary after closing the popup.
- A desktop user can select a supported native loopback source on each OS and
  record a Zoom/Teams/browser call with separate mic and remote audio.
- The same meeting pipeline works in local BYOK mode without an account and
  managed mode without exposing provider keys to the client.
- A hosted user sees only their workspace data, can search/share/delete it,
  and cannot exceed verified plan entitlements through client manipulation.
- A self-hosted/BYOK user retains local-first operation and can upgrade the
  client without being forced onto the hosted service.
