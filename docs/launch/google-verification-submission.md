# Google verification: submission sheet

Calendar access was removed from AI Notetaker, so every scope it requests is
**non-sensitive**. That means Google's scope review, the demo video and the
"unverified app" warning do not apply. This sheet keeps the short answers ready
in case Google asks anyway (for example during the basic brand check), and a
short video script as a fallback.

App: **AI Notetaker**  ·  Home: https://ai-notetaker.apercallc.com
Privacy: https://ai-notetaker.apercallc.com/privacy#google  ·  Terms: https://ai-notetaker.apercallc.com/terms
Support: support@apercallc.com

## Scopes requested (exactly these)

| Scope | Class |
| --- | --- |
| `openid`, `https://www.googleapis.com/auth/userinfo.email` | Non-sensitive |
| `https://www.googleapis.com/auth/drive.file` | Non-sensitive |

Console: **Data Access** should list only those three, with empty "sensitive"
and "restricted" sections. If Google's Verification Center still says a
justification or video is missing after you **Save** on that page, click
**Retry**; the requirement is tied to sensitive scopes, which no longer exist.

## Justifications (each under 1,000 characters)

### `drive.file` (545 characters)

> When the user clicks "Export to Google Drive" on a finished meeting, AI Notetaker creates a folder named "ai-notetaker" and, inside it, a Google Doc with that meeting's summary, action items and transcript. The drive.file scope only covers files the app itself creates, so it cannot list, read, modify or delete any other file in the user's Drive. We do not request drive or drive.readonly. Nothing is written to Drive unless the user clicks Export for that meeting. Users can disconnect in Account or revoke at myaccount.google.com/permissions.

### `openid` and `userinfo.email` (about 300 characters)

> Used to let users sign in or create an account with "Continue with Google" and to show which Google account is connected. We read only the email address and whether Google has verified it. Sign-in stores no Google access token. Drive export is a separate, optional step the user chooses later.

## Other answers reviewers ask for

- **How is Google user data stored and protected?** Drive access and refresh
  tokens are encrypted with AES-256-GCM before they reach the database; the key
  is a server-side secret. Exported Docs live in the user's own Drive.
- **Shared with third parties, used for advertising or AI training?** No. Google
  user data is used only for sign-in and Drive export.
- **Can users delete their data?** Yes: Disconnect (revokes at Google and deletes
  the stored tokens), Delete my account, or revoke at Google.
- **Limited Use:** stated at `/privacy#google`.
- **Test account for the reviewer:** sign in with the reviewer's Google account
  via "Continue with Google"; no invitation is needed.

## Fallback demo video (about 1 minute, only if Google requests one)

English, address bar visible, unlisted YouTube link.

1. Home page → **Continue with Google** → pause on the consent screen with
   `client_id=` visible in the URL: "Sign-in asks only for the account's email."
2. Account → **Connect Google** → consent screen: "Drive access is limited to
   files this app creates."
3. Open a finished meeting → **Export to Google Drive** → show the
   `ai-notetaker` folder and the Doc in Drive.
4. Account → **Disconnect**, then myaccount.google.com/permissions.
5. Show https://ai-notetaker.apercallc.com/privacy#google.
