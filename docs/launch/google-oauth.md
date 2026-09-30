# Google OAuth: step by step

This turns on optional **Calendar** (names the meeting you are in) and **Drive**
(exports a meeting as a Google Doc) for the hosted service. The code is done and
the encryption key is already set on Railway. What is missing is the Google
Cloud client and Google's review.

Start this on the same day as the Chrome Web Store submission: Google's review
of sensitive scopes takes days, and nothing else depends on it.

**What we ask for, and why it is light:**

| Scope | Class | Used for |
| --- | --- | --- |
| `openid`, `email` | Non-sensitive | Show which Google account is connected. |
| `https://www.googleapis.com/auth/drive.file` | Non-sensitive | Create a folder and Google Docs that AI Notetaker itself makes. It cannot see any other file. |
| `https://www.googleapis.com/auth/calendar.events.readonly` | **Sensitive** | Read events to name the current meeting. Cannot edit or delete. |

Only `calendar.events.readonly` needs Google's review. There are no *restricted*
scopes, so no paid third-party security assessment is required. The code used
to request the broad Docs scope as well; it no longer does, because a Google Doc
is now created through Drive's text import.

## 1. Verify your domain (Search Console)

1. <https://search.google.com/search-console>, **Add property**, **Domain**,
   enter `apercallc.com`.
2. Add the TXT record it shows at your DNS host (Hostinger), wait a few
   minutes, click **Verify**.
3. Use the same Google account that will own the Cloud project (or add that
   account as an owner of the property).

## 2. Create the Cloud project and enable the APIs

1. <https://console.cloud.google.com>, **New project**, name it `AI Notetaker`.
2. **APIs and services**, **Library**, enable **Google Calendar API** and
   **Google Drive API**. (Not the Docs API.)

## 3. Branding (consent screen)

**Google Auth Platform**, **Branding**:

| Field | Value |
| --- | --- |
| App name | AI Notetaker |
| User support email | a monitored address you control |
| App logo | `assets/google/logo-120.png` (120x120, PNG) |
| Application home page | https://ai-notetaker.apercallc.com |
| Application privacy policy link | https://ai-notetaker.apercallc.com/privacy |
| Application terms of service link | https://ai-notetaker.apercallc.com/terms |
| Authorized domains | `apercallc.com` |
| Developer contact email | a monitored address you control |

The privacy policy already contains the Google section and the Limited Use
statement Google checks for. Keep the home page, privacy and terms links on the
verified domain.

## 4. Audience and scopes

1. **Audience**: choose **External**. Leave it in **Testing** while you try it
   (step 7); add your own Google account under **Test users**.
2. **Data Access**, **Add or remove scopes**: add exactly
   `.../auth/calendar.events.readonly`, `.../auth/drive.file`, `openid` and
   `.../auth/userinfo.email`. Nothing else.
3. Paste these justifications when asked (they are also what the reviewer
   reads):

**`calendar.events.readonly`**

> AI Notetaker records meetings the user chooses to record. To give the notes a meaningful title and attendee list, it reads the user's calendar events for the current time window (read-only) and matches the one whose Google Meet link the user is in. It never creates, edits or deletes events, and it does not store the calendar.

**`drive.file`**

> When the user chooses "Export to Google Drive" on a meeting, AI Notetaker creates a folder named "ai-notetaker" and a Google Doc containing that meeting's summary, action items and transcript. The drive.file scope limits access to files the app itself created, so it cannot read or change any of the user's other Drive content.

## 5. Create the OAuth client

1. **Clients**, **Create client**, type **Web application**, name
   `AI Notetaker web`.
2. **Authorized redirect URIs**, add exactly:
   `https://ai-notetaker.apercallc.com/api/google/oauth/callback`
   (and, only if you test locally,
   `http://localhost:3000/api/google/oauth/callback`).
3. Leave **Authorized JavaScript origins** empty.
4. **Create**, then copy the **Client ID** and **Client secret**.

## 6. Give the keys to the app

Send them to me, or set them yourself (the encryption key is already there):

```sh
cd webapp
railway variables --service web --environment production \
  --set GOOGLE_OAUTH_CLIENT_ID="<client id>" \
  --set GOOGLE_OAUTH_CLIENT_SECRET="<client secret>"
```

Railway redeploys the service when variables change. Then the **Account** page
in the web app shows **Connect Google**.

## 7. Test it end to end while in Testing

1. Sign in at https://ai-notetaker.apercallc.com, open **Account**, **Connect
   Google**, approve. (You will see an "unverified app" warning until review
   passes; that is expected, choose **Continue**.)
2. Open a finished meeting and **Export to Google Drive**. Check that a Google
   Doc appears in a Drive folder named `ai-notetaker` with the summary, action
   items and transcript as text. **This is the one piece not yet exercised
   against real Google**: the Doc is created through Drive's text import. If
   the Doc is empty or created as plain text, tell me and I will adjust the
   upload.
3. Start a meeting at a time with a calendar event that has a Meet link and
   confirm the notes take the event's title.
4. **Disconnect** on the Account page, reconnect, and confirm both work again.

Note: while the publishing status is **Testing**, Google expires the refresh
token after 7 days. That is fine for this test and is fixed by publishing in the
next step.

### Continue with Google (sign-in)

The login and sign-up tabs also offer **Continue with Google**. It reuses this
same OAuth client and callback URL (`/api/google/oauth/callback`) but requests
only `openid email`, so it adds no scope to review and needs no console change.
It appears only when the Google variables in step 6 are set.

- **Sign in** signs into an existing account whose email is confirmed. Google
  must report the address as verified.
- An account that exists but never confirmed its email is refused (otherwise
  someone could pre-register a victim's address). Confirming the email or
  resetting the password unblocks it.
- A new Google user is sent to the **Create workspace** tab, where the terms
  tick is captured before Google opens; the account then gets a workspace and
  the free trial like any email sign-up. Its password is random; "Forgot your
  password?" sets one.
- Calendar and Drive stay a separate opt-in under **Account → Connect Google**.

Test: sign out, choose **Continue with Google** on the sign-in tab with an
address that has no account (you land on Create workspace), tick the terms and
continue, and confirm you arrive signed in. Then sign out and sign in again.

## 8. Publish and submit for verification

1. **Audience**, **Publish app**, confirm. The status becomes **In production**
   and the verification request opens.
2. Fill in the verification form with the justifications in
   [`google-verification-submission.md`](google-verification-submission.md),
   and link the demo video (script below and in that file).
3. Google replies by email, usually within a few business days for sensitive
   scopes. Answer any question on the same thread. Until it is approved, users
   see the "unverified app" warning and the app is capped at 100 new users.

### Demo video (about 2 minutes, unlisted YouTube)

Google wants to see the real consent screen and every scope in use. Record the
browser with the address bar visible, in English, with narration or captions.

1. **Show the app**: https://ai-notetaker.apercallc.com, sign in, open Account.
2. **Consent**: click **Connect Google**. Pause on the consent screen so the
   app name is readable and the URL shows `client_id=`. Scroll so the two
   permissions (calendar read-only, Drive files this app creates) are visible.
   Approve.
3. **Calendar scope in use**: show a calendar event with a Meet link, start a
   recording on that Meet, and show the meeting taking the event's title.
4. **Drive scope in use**: open a finished meeting, click **Export to Google
   Drive**, then show the `ai-notetaker` folder in Drive and the Google Doc it
   created. Say that the app cannot see any other Drive file.
5. **Control**: go back to Account, click **Disconnect**, show the status
   change, and show https://myaccount.google.com/permissions to explain the user
   can also revoke there.
6. Show the privacy policy's "Google Calendar and Drive" section.

## After approval

- Nothing to change in code or configuration. The "unverified" warning and the
  100-user cap go away.
- Keep the scope list as it is. Adding a scope later sends you back through
  review, which is why the Docs scope was removed before the first submission.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `redirect_uri_mismatch` | The redirect URI in the client differs from `https://ai-notetaker.apercallc.com/api/google/oauth/callback` by even one character. |
| "Access blocked: app not verified" for someone else | They are not a **Test user** and the app is still in Testing. Add them or publish. |
| Connect Google shows "not configured" | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` or `GOOGLE_OAUTH_ENCRYPTION_KEY` is missing on the `web` service, or `APP_URL` is wrong. |
| "Google did not grant offline access" | The user previously approved without a refresh token. Have them remove AI Notetaker at myaccount.google.com/permissions and connect again. |
| Verification asks why the app needs Drive | Answer with the `drive.file` justification above and point to the demo video's export segment. |
