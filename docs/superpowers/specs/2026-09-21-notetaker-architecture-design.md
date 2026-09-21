# AI Notetaker — Architecture Design

Date: 2026-09-21
Status: Approved for implementation planning

## 1. Problem & Goals

Build an open-source, self-hosted alternative to CRISP/Krisp-style AI meeting
notetakers, without a required subscription. Three pillars drive every
decision below:

1. **Affordable** — no subscription. Users bring their own AI API key(s)
   (BYOK) and pay the underlying provider directly, at cost (cents per
   meeting, see §5).
2. **Open source** — the entire stack (desktop helper, browser extension,
   optional web app) ships under one MIT-licensed monorepo. Nothing is
   closed-source or run as a paid service by the project itself.
3. **Simple, great UX** — install should feel like installing any consumer
   app: a guided wizard, not a README full of manual steps.

### Non-goals (explicitly out of scope for this design)

- Mobile (iOS/Android) capture — see research findings in §9; deferred to a
  future, architecturally-separate sub-project.
- A centrally-hosted, multi-tenant backend operated by the project — would
  reintroduce subscription-style hosting costs and data-liability, which
  contradicts pillar 1.
- Building a custom virtual-audio-device driver from scratch — unnecessary
  engineering risk when mature open-source drivers already exist per OS.
- Team/workspace collaboration features (CRISP's "Workspaces") — noted as a
  forward-compatibility concern in the data model (§7), not built now.

## 2. Sub-project Roadmap

This design covers **Sub-project #1** only. Later sub-projects, in order:

1. **Core capture + notes pipeline (this doc)** — helper + extension +
   BYOK AI pipeline + optional self-hosted history web app, macOS + Windows
   first, Linux fast-follow.
2. **Cross-platform helper packaging polish** — code signing/notarization,
   smoother first-run detection, Linux distro packaging breadth.
3. **Meeting history & "all-in-one place" features** — cross-meeting search,
   calendar integration, action-item tracking across meetings.
4. **Mobile capture** — Android via `AudioPlaybackCapture`/`MediaProjection`
   (genuinely feasible); iOS via a manual ReplayKit "record then join" flow
   (weaker, no clean OS API); cellular call recording excluded entirely on
   both platforms (blocked by OS/store policy, not a solvable gap).
5. **Polish/extras** — custom vocabulary, richer summarization templates,
   cross-browser (Edge/Brave/Firefox) ports, multi-user webapp auth.

## 3. Components

### 3.1 Desktop Capture Helper

A small, persistent background app (tray icon on macOS/Windows, daemon on
Linux) that is the system's audio bridge and — per the gap review — **owns
the AI pipeline**, not the extension.

- **Built on Tauri (Rust)**, not Electron. Rationale: one shared codebase
  across the three OSes with small platform-specific modules for the actual
  audio-device glue, a much smaller install size than Electron, and Tauri
  ships a built-in updater — resolving the "how do users get security
  patches" gap.
- **Virtual audio device**, built on existing open-source drivers rather
  than a custom one:
  - macOS: [BlackHole](https://github.com/ExistentialAudio/BlackHole)
  - Windows: [VB-Cable](https://vb-audio.com/Cable/)
  - Linux: a PulseAudio/PipeWire null-sink module
- **Dual-channel capture**: the helper captures the user's own mic input and
  the remote speaker/meeting-app output as **two separate streams**, not one
  mixed blob. This gives free "you vs. everyone else" diarization before the
  audio ever reaches the transcription API, which then further splits
  "everyone else" into individual speakers.
- **Resilience**: raw audio is always written to local disk first,
  independent of any API call succeeding. Failed transcription/summarization
  chunks are queued for retry; a full meeting can be reprocessed from raw
  audio if the pipeline fails outright.
- **Pipeline orchestration**: chunks/streams captured audio directly to the
  transcription API (Deepgram live-streaming endpoint by default) and, once
  a meeting ends, sends the assembled transcript to the LLM (Claude Haiku by
  default) for summary + action items.

### 3.2 Chrome Extension

A thin UI layer — deliberately not the pipeline owner, because Manifest V3
service workers are killed after ~30s idle and cannot hold a live connection
for a 45+ minute meeting.

- Start/stop recording, live transcript view (fed by the helper), meeting
  history (local list), notes/action-items view, settings page (API keys,
  provider choice, optional webapp URL/token).
- **Native Messaging** for the control channel to the helper — OS-enforced,
  allowlisted to this extension's ID only, with a per-session random token.
  (Not a raw localhost WebSocket: any webpage's JS can open a WebSocket to
  `127.0.0.1`, so an open port is a real security hole — Native Messaging
  closes it.)
- API keys stored in `chrome.storage.local` only (never `.sync`, which would
  ship them to Google's sync servers).
- Persistent on-screen recording indicator while active, plus a one-time
  onboarding note about consent-law obligations (one/two-party consent laws
  vary by jurisdiction — the product surfaces this, it does not gate on it).

### 3.3 AI Pipeline (BYOK)

No backend billing, ever — the helper calls these APIs directly with the
user's own key(s).

| Tier | Transcription | Summarization | Cost / 45-min meeting |
|---|---|---|---|
| **Default (recommended)** | Deepgram Nova-3 (live streaming, built-in diarization) | Claude Haiku 4.5 | ~$0.21 |
| **Budget** | Groq Whisper Large-v3 Turbo (batch only — choppier live partials, documented trade-off) | Gemini Flash or DeepSeek V4 Flash | ~$0.03 |

LLM choice barely affects cost (fractions of a cent either way) — it's
chosen for summary quality. Transcription is where the quality/cost
trade-off actually lives, which is why Deepgram is the default despite
costing more than Groq.

### 3.4 Local Storage

- **Raw audio + full transcripts**: helper's local filesystem. Browser
  storage quotas (`chrome.storage`/IndexedDB, ~10MB by default) are unsuited
  to weeks of audio.
- **Extension storage**: lightweight references to helper-side files, plus
  the final notes/summaries (small text), settings.
- This is the default, zero-setup experience — no account, no webapp
  required to use the product.

### 3.5 Self-Hosted History Web App (optional)

For persistent/cross-device history, additive to local storage.

- Stack: **Next.js + Postgres** — frontend, API, and DB in one deployable
  unit, pairs cleanly with a "Deploy on Railway" one-click template.
- **Self-hosted by the user**, not run centrally by the project. Each user
  deploys their own instance to their own Railway account (free tier
  available). This keeps hosting cost and data liability at zero for the
  project and matches the BYOK/no-subscription ethos exactly.
- Data model includes a `user_id`/`workspace_id` column from day one, even
  though the MVP is single-user — so future team/workspace sharing (a
  CRISP-Workspaces-style feature) doesn't require a schema migration later.
- Extension POSTs a finished meeting note to the configured webapp URL+token
  after local save, if configured. Default behavior with no webapp
  configured: local-only.

## 4. Data Flow

1. User selects the helper's virtual device as mic + speaker in their
   meeting app (one-time setup per meeting app, guided by the onboarding
   wizard).
2. User hits "Record" in the extension → Native Messaging tells the helper
   to start.
3. Helper streams the two audio channels (mic, speaker) to Deepgram's live
   endpoint; partial transcript segments stream back to the extension for a
   live view.
4. User hits "Stop" → helper finalizes the transcript, sends it to the LLM
   for summary + action items.
5. Extension saves the result locally always; if a webapp is configured, the
   extension also POSTs it there.

## 5. Security Model

- Native Messaging (not an open localhost port) for extension↔helper
  control, with a per-session random token.
- API keys live in `chrome.storage.local` only.
- Webapp deployments are single-user by default, secured by a token the
  user generates on deploy; multi-user auth is future scope (§2, item 5).

## 6. Onboarding UX

A first-run wizard in the extension:

1. Install helper (per-OS installer, signed/notarized where the OS requires
   it — full signing/notarization polish is sub-project #2, but installers
   must not trigger a raw "unidentified developer" wall in the MVP).
2. Select the helper's virtual device as mic/speaker in your meeting app,
   with per-platform screenshots.
3. Paste your AI API key(s) — Deepgram + Claude pre-filled as the default,
   with a one-click "budget option" toggle for Groq + Gemini/DeepSeek.
4. (Optional) Deploy the history webapp via the Railway button, paste the
   resulting URL + token.

## 7. Scaling Considerations Built In Now

- Webapp schema carries `user_id`/`workspace_id` from day one.
- Extension uses standard Manifest V3 / WebExtension APIs where possible, so
  an Edge/Brave/Firefox port later doesn't require a rewrite.
- Helper's per-OS audio glue is isolated behind a shared Rust interface, so
  adding a new OS or swapping a virtual-audio backend doesn't touch the
  pipeline/orchestration code.

## 8. Repo Structure

```
ai-notetaker/
├── extension/     # Chrome extension (Manifest V3)
├── helper/        # Tauri/Rust desktop capture helper, per-OS audio modules
├── webapp/        # Optional Next.js + Postgres history app, Railway template
├── docs/          # Setup guides per OS, webapp deploy guide, this spec
└── LICENSE        # MIT
```

## 9. Mobile Research Findings (reference, not in scope for this design)

- **Cellular call recording is not buildable** on iOS or Android — blocked
  by OS/App Store/Play Store policy on both platforms, not a technical gap
  to engineer around.
- **Android VoIP/meeting-app audio capture is genuinely feasible** via
  `AudioPlaybackCapture`/`MediaProjection` (Android 10+, user-consent
  prompt).
- **iOS has no equivalent clean API** — only a manual, whole-screen
  ReplayKit recording flow.
- Competitors (Otter, Fireflies, Fathom, tl;dv) don't solve this elegantly
  either; they use the phone mic for ambient recording or a server-side bot
  that joins the meeting independently — a fundamentally different (heavier)
  architecture than the BYOK/local-first approach chosen here.

## 10. Testing Approach

- Helper: unit tests per platform audio module (mockable audio I/O), plus a
  manual per-OS smoke test checklist (select device, speak, verify capture)
  before each release.
- Extension: standard WebExtension testing (unit tests for UI/state,
  manual checklist against each supported meeting platform: Zoom, Meet,
  Teams, Slack Huddles).
- Pipeline: fixture-based tests against recorded sample audio for both the
  default and budget provider tiers, verifying transcript + summary shape
  without needing live API calls in CI (mocked provider responses).
- Webapp: standard Next.js/API route tests; a Railway deploy smoke test
  documented in `docs/` for contributors.
