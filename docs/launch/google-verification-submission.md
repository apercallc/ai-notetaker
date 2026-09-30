# Google verification: submission sheet

Paste-ready answers for the two fields the Verification Center reported
missing ("scope justification" and "demo video"), plus a shot-by-shot script
for the video. Everything here matches what the code does today; if a scope
changes, update this file and `google-oauth.md` in the same commit.

App: **AI Notetaker**  ·  Home: https://ai-notetaker.apercallc.com
Privacy: https://ai-notetaker.apercallc.com/privacy#google  ·  Terms: https://ai-notetaker.apercallc.com/terms
Support: support@apercallc.com

## Scopes requested (exactly these four)

| Scope | Class |
| --- | --- |
| `openid`, `https://www.googleapis.com/auth/userinfo.email` | Non-sensitive |
| `https://www.googleapis.com/auth/drive.file` | Non-sensitive |
| `https://www.googleapis.com/auth/calendar.events.readonly` | **Sensitive** (the only one under review) |

Console step: **Data Access → Add or remove scopes**. If `calendar.readonly` is
still listed from an earlier draft, remove it and add
`.../auth/calendar.events.readonly` so the console matches the code exactly.

## Scope justification (paste into the field)

### `https://www.googleapis.com/auth/calendar.events.readonly`

> AI Notetaker is a meeting notetaker. When a user starts recording a meeting,
> the app reads that user's Google Calendar events for the current time window
> (read-only, primary calendar) and finds the event they are in, so the notes
> get the event's real title and attendee names instead of a generic name such
> as "Untitled meeting". This is the only use of Calendar data.
>
> Why this scope and not a broader one: the app calls only the Calendar
> `events.list` method on the user's primary calendar. `calendar.events.readonly`
> is the narrowest scope that allows it. We do not request `calendar` or
> `calendar.readonly`, so the app cannot see calendar settings, other calendars'
> ACLs, or create, edit or delete events. Why not a narrower non-sensitive
> alternative: no narrower scope allows reading event titles and attendees.
>
> What we keep: the app does not store the calendar. Only the matched event's
> title and attendee names are copied into the meeting the user chose to record,
> and they stay in that meeting until the user deletes it. Access tokens are
> stored encrypted (AES-256-GCM) on our server, and the user can disconnect in
> Account → Disconnect (which also revokes the grant at Google) or at
> https://myaccount.google.com/permissions.

### `https://www.googleapis.com/auth/drive.file`

> When the user clicks "Export to Google Drive" on a finished meeting, AI
> Notetaker creates a folder named "ai-notetaker" in the user's Drive and, inside
> it, a Google Doc containing that meeting's summary, action items and
> transcript. `drive.file` grants access only to files the app itself creates, so
> the app cannot list, read, modify or delete any other file in the user's Drive.
> We do not request `drive` or `drive.readonly`. Nothing is written to Drive
> unless the user clicks Export for that meeting.

### `openid` and `userinfo.email`

> Used to show which Google account is connected and to let users sign in or
> create an account with "Continue with Google". We read only the account's
> email address and whether Google has verified it. Sign-in stores no Google
> access token. Calendar and Drive access is a separate, optional step the user
> chooses later from their Account page.

## Other answers reviewers ask for

- **How is Google user data stored and protected?** Access and refresh tokens are
  encrypted with AES-256-GCM before they reach the database; the key is a
  server-side secret. Calendar content is not stored. Exported Docs live in the
  user's own Drive.
- **Is data shared with third parties or used for advertising or AI training?**
  No. Google user data is used only to provide the two features above. The
  meeting audio and text the user chooses to process are handled by the
  providers listed in the privacy notice; Google Calendar/Drive data is never
  sent to them.
- **Can users delete their data?** Yes: Disconnect (revokes and deletes the
  stored tokens), Delete my account, or revoke at Google.
- **Limited Use:** AI Notetaker's use and transfer of information received from
  Google APIs adheres to the Google API Services User Data Policy, including the
  Limited Use requirements (stated at `/privacy#google`).
- **Test account for the reviewer:** sign in with the reviewer's Google account
  via "Continue with Google"; no invitation is needed. Hosted AI includes 3 free
  meetings.

## Demo video script (about 2 minutes 30 seconds)

Requirements from Google: English; record the browser with the address bar
visible; show the real OAuth consent screen with the app name and the
`client_id=` in the URL; show every requested scope being used; upload as an
unlisted YouTube video and paste the link. Narrate, or add captions with the
text below.

| Time | On screen | Say / caption |
| --- | --- | --- |
| 0:00 | Home page, https://ai-notetaker.apercallc.com | "This is AI Notetaker, a meeting notetaker. This video shows how it uses Google sign-in, Calendar and Drive." |
| 0:15 | Login page, click **Continue with Google** | "Users can sign in with Google." |
| 0:25 | Consent screen: pause on the app name; zoom on the address bar so `client_id=` is readable; scroll to the permissions | "Sign-in asks only for the account's email. The app name matches the app; this is our client ID." Approve. |
| 0:50 | Account page, click **Connect Google** | "Calendar and Drive are a separate optional step from Account." |
| 1:00 | Consent screen again, showing calendar events (read-only) and Drive files this app creates | "It asks to read calendar events, read-only, and to create files in Drive that the app itself makes. It cannot see other Drive files." Approve. |
| 1:20 | Google Calendar with an event that has a Meet link, then start a recording on that Meet with the extension | "I have a calendar event for this meeting. When I start recording, the app reads today's events and finds this one." |
| 1:45 | The finished meeting shows the event's title | "The notes take the event's real title. This is the only use of Calendar data." |
| 1:55 | Meeting page, click **Export to Google Drive** | "The user chooses when to export." |
| 2:05 | Drive: the `ai-notetaker` folder and the Google Doc with summary, action items, transcript | "The app created this folder and this Doc. With the drive.file scope it can only touch files it created." |
| 2:20 | Account, click **Disconnect**; then https://myaccount.google.com/permissions | "The user can disconnect at any time, which revokes access at Google, or remove it here." |
| 2:30 | https://ai-notetaker.apercallc.com/privacy#google | "Our privacy notice explains how Google data is used and its Limited Use commitment." |

Before recording: use a Google account with a real upcoming event that has a
Meet link, clear any earlier grant at myaccount.google.com/permissions so the
consent screens appear, and have one finished meeting ready to export.
