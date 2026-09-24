# In-Meet Notes Widget

Sub-project 1 of the "best-in-class Google Meet notetaker" effort. Sub-projects
2 (smarter notes: structured summaries, chat with a meeting) and 3 (share and
integrations: Slack webhook, Notion, email recap) each get their own spec and
plan; this document covers only the in-call experience.

## Goal

Make taking notes on a Google Meet call one click, keep the live transcript
visible while the call is on screen, and let the user flag important moments
without leaving the call. The comparison point is Scribbl: bot-free capture,
notes right after the call. Our edge is BYOK, local-first, and no meeting caps.

## Decisions

1. **A content script on `meet.google.com` renders a floating widget** inside a
   closed shadow root. It reads nothing from Meet's markup: the meeting is
   recognised from the URL (`/abc-defg-hij`) and named from the tab title, so
   Meet DOM changes cannot break it. SPA navigation is followed by polling the
   pathname once a second. The closed shadow root keeps Meet's CSS and DOM
   queries out; it is not a privacy boundary against page scripts that patch
   `attachShadow` first, which is why the widget only ever holds the last 40
   transcript lines and no secrets.
2. **All state stays in the background worker.** The widget renders
   `WidgetState` (helper status, setup/consent flags, the active meeting with a
   40-line transcript tail and its bookmarks, and the latest finished meeting).
   The worker pushes `TRANSCRIPT_UPDATE`, `MEETING_STATE_CHANGED`,
   `RECORDING_ERROR`, `SUMMARY_READY`, and `HELPER_STATUS` to Meet tabs with
   `chrome.tabs.sendMessage` (runtime messages never reach content scripts).
3. **Chrome's capture rule is designed around, not hidden.** `tabCapture`
   requires the user to have invoked the extension on the tab, and host
   permission alone does not satisfy it. The widget's Start works once that has
   happened (toolbar click, popup open, or a registered shortcut), and the grant
   then lasts for the tab. Otherwise the widget shows Chrome's requirement in
   plain words. The optional commands `toggle-recording` and `add-bookmark`
   (suggested `Alt+Shift+R` / `Alt+Shift+B`) are themselves invocations, but
   Chrome only assigns a suggested key when it is free, so the widget and
   Settings read the real bindings and only mention a shortcut that exists.
   The shortcut ignores non-Meet tabs so it can never leave a failed meeting
   behind.
4. **The stream id is requested in the service worker.** Offscreen documents
   only have `chrome.runtime`, so `getMediaStreamId` moved out of the offscreen
   page and its result is passed in `MEET_CAPTURE_START`. This fixes a defect in
   the earlier Meet capture.
5. **Microphone permission is granted once on a normal tab.** Offscreen pages
   cannot show a permission prompt. The worker pre-checks the permission; if it
   is not granted, the widget shows "Allow microphone", which opens
   `meet/microphone.html`, a page that requests it once and confirms.
6. **Bookmarks** are `{id, offsetMs, note, createdAt}` on the `MeetingRecord`,
   capped at 200 per meeting and 280 characters per note. They appear in the
   meeting view (each jumps to the nearest transcript line), in Markdown/text
   exports, and in the Drive document. They are not sent to the webapp.
7. **The widget is optional.** Settings has "Show the notes widget during Google
   Meet calls" (default on) and a shortcut summary with a link to
   `chrome://extensions/shortcuts`.
8. **Only the right sender may ask for each thing.** The background classifies
   every message sender (extension page, offscreen page, Meet content script,
   untrusted) and lets the content script make only the widget's requests
   (state, start, stop, bookmark, open a page, check helper). Settings, keys,
   deletion, export retry, and audio chunks are unreachable from a page-side
   sender, and a page-side stop must name the live recording. A page-side start
   always captures its own tab in Meet mode; it cannot name another tab. The
   offscreen capture page takes orders only from the extension's own worker.
   `chrome.storage.local` is restricted to trusted contexts, so the content
   script cannot read API keys or calendar tokens at all: the widget's position
   and setting changes travel through background messages instead (verified in
   real Chrome: `Access to storage is not allowed from this context`).
9. **Consent and honesty in the copy.** Nobody else in the call is notified, so
   the panel says so above the Start button and asks the user to tell everyone;
   the toast after starting repeats it. Audio is described as saved on this
   device and sent to the user's own transcription provider.
10. **Design.** Always-dark, because the call surface is dark; the pill shows an
   unmistakable pulsing "Recording" state with elapsed time; red means recording
   and nothing else (problems are amber); the idle pill has a one-click Start;
   the pill's stop asks for a second press so it cannot be hit beside the flag
   button by accident; the panel opens toward the screen side with room; it is
   draggable or arrow-key movable with the position remembered; a single
   persistent live region announces state changes while the transcript stays
   silent; keyboard events inside the widget never reach Meet's own single-key
   shortcuts; `prefers-reduced-motion` and forced-colors are honoured.

## Boundaries (unchanged)

- No project-operated backend, account, billing, or telemetry.
- The widget never calls a provider, never holds keys, and never touches
  `chrome.storage.local` except its own position key.
- Native Messaging remains the only extension/helper transport.
- Host permission and content script are scoped to `https://meet.google.com/*`.
- The manifest `key` is unchanged.

## Also in this sub-project (added after real-browser testing)

- **Calendar reminders.** With a connected Google Calendar and the opt-out
  setting on, an alarm (only registered while it has work) checks once a minute
  for a Meet-linked event starting within 90 seconds or up to 5 minutes ago, and
  shows one desktop notification per occurrence. Clicking it opens the call. It
  says plainly that the user still clicks the Notetaker icon once; a
  notification is not one of the invocations Chrome accepts for tab capture.
  The widget also names the call from the calendar ("Notes for Weekly sync").
- **Flagged moments reach the summarizer.** `stop_recording` carries optional
  `flaggedMoments` (`offsetMs`, `note`, `positionPercent`). The helper stores
  them in `meta.json` (so a retried summary still has them) and tells the
  summarizer what was marked and how far through the call each flag was, since
  the transcript it receives has no timestamps. Bounded to 200 moments and
  280-character notes; older extensions and helpers interoperate.
- **Real shortcut bindings.** Chrome only assigns a suggested shortcut when it
  is free, and did not assign either in a fresh profile. The widget and Settings
  read the actual bindings, show them as keycaps, and offer "Set one".
- **Processing never traps the user.** The "Writing your notes" card shows why
  it is slow (a retryable provider warning) and can be hidden so the next call
  can start from the pill.

## Verified in a real browser

Real Chromium with the built extension, the real service worker, the freshly
built helper over real Native Messaging, on a local HTTPS origin standing in for
`meet.google.com` (strict CSP and Trusted Types on, fake capture devices, a
playing audio tag):

- Chrome refuses tab capture until the extension is invoked on the tab (its
  exact error is mapped to plain instructions); host permission alone is not
  enough.
- A real `Alt+Shift+R` key chord starts capture; the helper writes separate
  `mic.pcm` and `speaker.pcm`; `Alt+Shift+B` stores a bookmark; the pill's
  two-press stop ends the recording.
- After that first invocation, a later start from the widget with no new
  invocation works: the grant lasts for the tab, including after navigation.
- The stylesheet and `innerHTML` rendering work under a strict CSP and Trusted
  Types.
- A real alarm fires, the reminder notification is created once, and the widget
  names the call from a calendar response.
- Flagged moments arrive in the helper's `meta.json` with their measured
  position.
- Real mouse input: the widget drags (including a fast flick that leaves the
  pill before its first move event, which the first version lost), the position
  persists across a reload, and clicks on its buttons work.
- The content script's own JavaScript world is denied `chrome.storage.local`.

Not verifiable here: a real Google Meet call (real Meet markup and layout, real
participants' audio), a real click on a desktop notification, and real Google
OAuth. Those need a person and an account.

## Acceptance criteria

- On a Meet call route the widget appears; elsewhere on `meet.google.com` it
  does not; it follows in-app navigation; it can be turned off in Settings.
- With the helper connected and permissions granted, one click starts a Meet
  recording, titled from the tab; the pill shows Recording and elapsed time.
- Without Chrome's tab invocation, the widget shows the shortcut instruction; the
  shortcut then starts recording. Without microphone permission, the widget
  offers a one-time grant that then unblocks recording.
- The live transcript updates in place for provisional lines, caps its DOM at
  200 lines, and never renders text as HTML.
- Flagged moments persist, survive re-render, and appear in the meeting view and
  exports.
- After Stop, the widget shows "Writing your notes…", then "Your notes are
  ready" with a link, and the card can be dismissed.
- Helper missing, incompatible, or connecting is explained with a working
  "Set up helper" / "Check again".
