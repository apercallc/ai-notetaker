# Google Meet recording without the toolbar click

Date: 2026-10-02
Status: Implemented locally; 637 extension tests and synthetic Chromium media smoke pass. Live Google Meet acceptance remains outstanding.

This document describes the legacy extension-owned Meet capture path. The
desktop-first architecture in
[`superpowers/specs/2026-10-03-desktop-first-product-design.md`](superpowers/specs/2026-10-03-desktop-first-product-design.md)
supersedes it for new product work: the desktop app captures microphone and
system audio without Chrome. Keep this investigation as implementation history
and reference only while supporting existing extension users.

## Delivered implementation

The extension now prefers direct remote-track capture when the Meet adapter
is available. Start in the widget no longer needs toolbar invocation on that
path. A receive-only local WebRTC relay supplies the existing offscreen
recorder; the extension still captures its own microphone separately and
saves both channels in IndexedDB before provider calls or managed uploads.

The old tab-capture route remains a fallback for pages where discovery or
connection fails. That fallback still requires Chrome's toolbar/shortcut
invocation. Already-open tabs need refreshing after loading the new extension
because the MAIN-world observer must run before Meet creates its connections.
Initial microphone permission is still required.

New implementation files:

- `extension/src/content/directMain.ts`: early MAIN-world observer.
- `extension/src/content/directBridge.ts`: isolated signaling, bound to the
  current document and accepting extension-origin control only.
- `extension/src/meet/directSource.ts`: remote receiver discovery, dynamic
  participant mixing, and send-only local relay. Meet tracks are never stopped.
- `extension/src/meet/directReceiver.ts`: receive-only offscreen relay and
  muted media-element consumer required for Chromium audio decoding.
- `extension/src/meet/directProtocol.ts`: bounded, validated signaling.

The capture controller integrates discovery, fallback, cancellation, and
session recovery. Shutdown waits for durable tail writes. Failed starts keep
any partial audio already saved. A bounded persistence backlog stops capture
with an error if local storage cannot keep up. Widget, popup, and badge retain
Connecting state until capture succeeds.

## Verification and how to try it

- `cd extension && npm run typecheck`: passed.
- `cd extension && npm test`: 637 tests passed across 53 files.
- `cd extension && npm run test:direct-browser`: build and real Chromium smoke
  passed. The test first confirms tabCapture is denied for lack of invocation,
  then verifies non-silent mic and speaker PCM in IndexedDB through the direct
  path, restoration of capture metadata, stopping without ending Meet's own
  receiver track, and another start/stop in the same call.
- The browser test uses the production capture controller, page adapter,
  offscreen recorder, and audio storage. Its synthetic Meet-origin page and
  test orchestration replace the real Meet application and provider/account
  pipeline. It verifies media transport, not Google Meet compatibility or
  actual service-worker termination. It uses an isolated temporary profile.
- Project guardrail and design reviews completed; their shutdown-race and
  premature Recording-state findings were fixed. UI review was source-based.
- `git diff --check`: passed. No commit, push, publication, provider call, or
  deployed change was made for this task. Inherited working-tree edits remain.

To try locally: reload the unpacked extension from `extension/dist`, refresh
Meet before joining a call, then press **Start notes** inside the widget.
An actual call with multiple participants is still required to validate
reconnects, presentation audio, headphones, mic/device changes, and long
recordings. Do not publish a claim of universal one-click Meet compatibility
until those checks pass. The fallback remains necessary.

The repeatable browser test requires Playwright Chromium (`npx playwright
install chromium` if absent); `CHROMIUM_PATH` can select an existing binary.
It does not use any real account, API key, or provider.

## Architectural recommendation

Keep the source adapter small and the durable recorder extension-owned. This
removes toolbar friction where direct audio is available while retaining the
browser-supported fallback when Meet changes. It avoids helper installation
and preserves both local BYOK and managed execution.

The local relay re-encodes audio using the browser's negotiated WebRTC codec.
The saved PCM is captured relay output, not a bit-exact copy of remote input.
Treat real-call transcription quality and long-call resource use as acceptance
criteria. Do not replace durable audio with scraped captions or expose keys
to the Meet page to simplify the integration.

## Original investigation

The original extra click was caused by our choice of Chrome's `tabCapture` API.
It is not a necessary feature of every possible Meet recorder. Chrome requires
extension invocation on the target tab before this API grants capture; our
in-page Start button does not satisfy that requirement.

The original sequence, retained in the fallback, was:

- `extension/src/meet/meetCapture.ts`: `prepare()` calls
  `tabCapture.getMediaStreamId({ targetTabId })` during preflight and start.
- `extension/src/meet/session.ts`: invocation failures save a pending start.
- `extension/src/meet/pendingStart.ts` and `extension/src/meet/hints.ts`:
  the user is directed to click the toolbar, then the popup resumes that start.
- `extension/manifest.json`: the existing Alt+Shift+R command is another
  extension invocation route. It avoids the popup but does not deliver the
  requested in-page, one-click experience.

Chrome documents both the invocation requirement and the target-tab permission
restriction in its [tabCapture reference](https://developer.chrome.com/docs/extensions/reference/api/tabCapture).
Treat automatic popup opening or adding broader host access as unproven
workarounds, not a product solution. The extension already has Meet host access.

## Options

| Approach | User experience | Assessment |
| --- | --- | --- |
| Existing tabCapture | Toolbar click or shortcut authorizes capture | Supported and already implemented, but retains the reported friction |
| Browser tab-sharing picker | Start in widget, select Meet and share tab audio | Supported API alternative; removes toolbar dependency but adds a picker |
| Read Meet's existing audio tracks | Start in widget after initial setup, without toolbar/picker | Best candidate for the desired UX; requires a compatibility prototype |
| Read Meet captions | Collect text shown by Meet | Does not preserve raw audio or the existing retry contract; not a replacement |
| Desktop helper loopback | Native recording workflow | Does not meet this project's helperless Meet requirement |

The extension API [desktopCapture.chooseDesktopMedia](https://developer.chrome.com/docs/extensions/reference/api/desktopCapture)
provides a picker for tab/audio sources and reports whether audio sharing was
allowed. Its `targetTab` controls where the result may be consumed, not which
source the user must select. A picker implementation must handle cancellation,
missing audio, incorrect source selection, stream expiration, and offscreen
consumption. Those integration details have not been tested here.

The web alternative `getDisplayMedia()` also requires user interaction and a
source picker. Its permission cannot be permanently granted for future calls;
see the [Screen Capture specification](https://www.w3.org/TR/screen-capture/).

## Recommended direction

The investigation recommended a Meet audio-track adapter before rollout.
The intended experience is: join Meet, click Start in our widget, see recording
begin. Keep the existing recorder available as an explicit compatibility fallback.

The browser primitives exist: WebRTC receivers expose remote audio tracks,
and media elements may expose their source streams. This is an architectural
inference from the [WebRTC specification](https://www.w3.org/TR/webrtc/) and
[Media Capture from DOM Elements](https://www.w3.org/TR/mediacapture-fromelement/),
not proof that today's Meet implementation exposes all necessary tracks in a
stable way. It is also not evidence of how any particular competitor works.
The competitor's identity remains unconfirmed.

### Prototype shape

1. Add a minimal Meet-only discovery script at `document_start` in the MAIN
   world to observe peer connections before Meet creates them. Investigate
   DOM media streams first where available; observing new connections alone
   will miss calls already running when an extension is installed or reloaded.
   Preserve constructors, prototypes, behavior, and original track lifetimes.
2. Keep discovery separate from recording. Start audio collection only after
   an explicit Start or the user's previously enabled auto-record preference.
   Stop only resources owned by the recorder, never Meet's original tracks.
3. Aggregate remote tracks into the speaker channel without duplicate audio.
   Handle track replacement, participant joins/leaves, device switches,
   reconnects, and presentation audio. Decide and test the local microphone
   policy explicitly: cloning Meet's sender can behave differently from our
   present independent mic capture when the user mutes themselves.
4. Establish a bounded audio transport to an extension-owned recording context.
   Do not assume MediaStream objects can simply be sent through Chrome runtime
   messaging. Prototype the transport, persistence acknowledgements, and
   backpressure before choosing an implementation.
5. Preserve extension IndexedDB persistence before provider calls/uploads,
   separate mic/speaker channels, existing processing-mode/workspace identity,
   and recovery after service-worker suspension. Provider credentials and
   managed tokens must never enter the Meet page.
6. Keep page-originated audio an explicitly untrusted input. The existing
   `senderPolicy.ts` intentionally admits audio only from the offscreen
   document. Do not weaken it with a generic page-message forwarding path.
   Bind any new transport to the worker-authorized tab, document, meeting,
   channel, bounded chunk size, and sequence. Page-visible nonces cannot
   authenticate against scripts in that same page.
7. Show Recording only after capture is established. Detect missing or lost
   channels separately from natural silence; report capture interruptions and
   preserve completed chunks. Offer the existing capture route when direct
   capture is unavailable, without silently starting a second recorder.

Chrome's [content-script documentation](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
explains execution-world isolation. A MAIN-world adapter shares the page's
environment and must contain no secrets. Keeping most code in the isolated
world and extension contexts limits the amount affected by Meet changes.

This changes the capture-source design recorded in CLAUDE.md and the dual-mode
spec, even though capture stays extension-owned and helperless. Those contracts
now document the direct adapter and its fallback.

### Acceptance evidence required before adoption

- Fresh browser session and fresh Meet tab: widget Start works without any
  toolbar invocation, registered shortcut, or prior tab-capture grant.
- Real call with at least two participants: independently audible local and
  remote recording, headphones, mute/unmute, device changes, and presentation
  audio; no double playback or disruption of the call.
- Participant changes and reconnects retain coverage; missing required tracks
  produce an actionable state rather than a false success indicator.
- Late extension injection, page navigation, tab closure, stop/start races,
  and service-worker suspension leave persisted audio recoverable.
- Both local BYOK and managed mode process only durable chunks; no credentials
  or cross-workspace data cross the page bridge.
- Malformed, oversized, duplicate, stale-document, and wrong-tab messages are
  rejected; queues stay bounded under a slow or interrupted persistence path.
- Focused tests plus extension typecheck, full tests, and build pass. Perform
  project design and guardrail reviews before shipping the new capture flow.

## Work completed and limitations

The first investigation inspected the capture flow, inherited changes, and
Chrome/W3C documentation. Implementation and synthetic browser validation
followed at the user's request, as recorded above. No actual Google Meet call,
provider test, or deployment was performed. The competitor's identity and
implementation remain unverified.
