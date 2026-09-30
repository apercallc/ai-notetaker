# Google OAuth: step by step

This turns on **Continue with Google** sign-in and optional **Drive** export (a
meeting becomes a Google Doc) for the hosted service. Calendar access was
removed on purpose: without it every scope is non-sensitive, so there is no
sensitive-scope review, no demo video and no 100-user cap. What remains is the
Google Cloud client and (optionally) Google's basic brand check.

**What we ask for, and why it is light:**

| Scope | Class | Used for |
| --- | --- | --- |
| `openid`, `email` | Non-sensitive | Show which Google account is connected. |
| `https://www.googleapis.com/auth/drive.file` | Non-sensitive | Create a folder and Google Docs that AI Notetaker itself makes. It cannot see any other file. |

Every scope is non-sensitive. There are no *sensitive* or *restricted* scopes, so
no scope review, no demo video and no paid security assessment is required. The code used
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
2. **APIs and services**, **Library**, enable the **Google Drive API**.
   (Not the Docs API, and not the Calendar API.)

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
   `.../auth/drive.file`, `openid` and `.../auth/userinfo.email`. Nothing else
   (no Calendar scope of any kind).
3. If Google asks for justifications, use these (longer versions are in
   [`google-verification-submission.md`](google-verification-submission.md)):

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
3. **Disconnect** on the Account page, reconnect, and confirm both work again.

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
- Drive export stays a separate opt-in under **Account → Connect Google**.

Test: sign out, choose **Continue with Google** on the sign-in tab with an
address that has no account (you land on Create workspace), tick the terms and
continue, and confirm you arrive signed in. Then sign out and sign in again.

## 8. Publish (and the optional brand check)

1. **Audience**, **Publish app**, confirm. The status becomes **In production**.
   Because every scope is non-sensitive there is no scope review, no demo video,
   no "unverified app" warning for the scopes and no 100-user cap.
2. Google may still ask for a basic **brand verification** (app name, logo,
   home page, privacy policy and terms links, verified domain). Set the app name
   to exactly `AI Notetaker`, make sure the support email is
   `support@apercallc.com`, and click **Retry** in the Verification Center. The
   home page states the Google data use and links to `/privacy#google`.
3. Answer any email from Google on the same thread.

## After approval

- Nothing to change in code or configuration.
- Keep the scope list as it is. Adding a sensitive scope (Calendar, Gmail, full
  Drive) later sends you back through scope review and a demo video, which is
  why Calendar and the Docs scope were removed.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `redirect_uri_mismatch` | The redirect URI in the client differs from `https://ai-notetaker.apercallc.com/api/google/oauth/callback` by even one character. |
| "Access blocked: app not verified" for someone else | They are not a **Test user** and the app is still in Testing. Add them or publish. |
| Connect Google shows "not configured" | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` or `GOOGLE_OAUTH_ENCRYPTION_KEY` is missing on the `web` service, or `APP_URL` is wrong. |
| "Google did not grant offline access" | The user previously approved without a refresh token. Have them remove AI Notetaker at myaccount.google.com/permissions and connect again. |
| Verification asks why the app needs Drive | Answer with the `drive.file` justification above; if a video is requested anyway, use the short script in `google-verification-submission.md`. |
