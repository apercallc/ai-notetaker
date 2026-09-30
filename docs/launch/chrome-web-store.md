# Chrome Web Store: step by step

Everything you paste is in this file. Budget about an hour for the dashboard,
then wait for review (a first submission commonly takes a few days, sometimes
longer; later updates are usually faster).

**The one thing that can go wrong:** the store may assign the extension a
different ID than the one our manifest `key` pins, and that ID is hard-coded in
the desktop helper's Native Messaging manifests, the hosted API's CORS
allowlist and the release validator. A mismatch makes the helper silently
refuse the store build. Steps 2 to 4 below prevent it. Do them in order.

## 0. Before you start

- A Google account with **2-Step Verification on** (the store requires it).
- **US$5** one-time registration fee and a card.
- A publisher name, a verified contact email, and, because Hosted AI is a paid
  service, expect to declare **trader** status for EU users. Traders have their
  contact address and phone number shown publicly on the listing, so use a
  business address and number you are happy to publish.
- The images in `docs/launch/assets/chrome-web-store/` (icon, five
  screenshots, two promo tiles).

## 1. Register

1. Open <https://chrome.google.com/webstore/devconsole> and sign in.
2. Accept the developer agreement and pay the fee.
3. **Account** tab: set the publisher name, verify the contact email, and
   complete the trader declaration.

## 2. Create the draft and read the store's public key

The upload in this step is only to create the draft. Do not submit it.

1. Download `ai-notetaker-chrome-web-store-<version>.zip` from the latest
   [GitHub release](https://github.com/apercallc/ai-notetaker/releases/latest).
   It has `manifest.json` at the zip root, which the store requires.
   (Older releases only had `ai-notetaker-extension-<version>.zip`, which has a
   `dist/` folder inside. Repack it with
   `unzip ai-notetaker-extension-*.zip && (cd dist && zip -r ../store.zip .)`.)
2. Dashboard, **Add new item**, upload the zip.
   - If the dashboard rejects the package because of the `key` field, remove
     it for this draft only: `unzip -o store.zip manifest.json && jq 'del(.key)' manifest.json > m.json && mv m.json manifest.json && zip store.zip manifest.json`,
     then upload again.
3. In the left menu open **Package**, then **View public key**. Copy the whole
   base64 block. Also note the **Item ID** (32 letters, a to p).

## 3. Make the project match the store's ID

On your machine, in the repository:

```sh
node scripts/rotate-extension-id.mjs --dry-run "<paste the public key>"
node scripts/rotate-extension-id.mjs "<paste the public key>"
```

The script derives the ID from the key itself, so a typo cannot produce a
mismatched pair. It rewrites the manifest `key` and every pinned ID (helper
installers for macOS, Windows and Linux, the hosted API's CORS default, the
release validator, the docs). Check that the ID it prints equals the **Item
ID** from step 2. Then run the tests, commit, and merge. The auto-release
publishes a new helper and extension build that agree with the store.

Anyone who installed an earlier helper (only you, so far) should reinstall it.

## 4. Upload the real package

1. Wait for the new release (about 20 minutes) and download its
   `ai-notetaker-chrome-web-store-<version>.zip`.
2. Dashboard, **Package**, **Upload new package**. The manifest `key` now
   matches the store's key.
3. Confirm the version shown is the new one.

## 5. Store listing tab

| Field | Value |
| --- | --- |
| Name | AI Notetaker (comes from the manifest) |
| Summary (132 max) | Meeting notes without the meeting bot: record Google Meet from your browser, get a transcript and action items. |
| Category | Productivity |
| Language | English |
| Icon | `assets/chrome-web-store/icon-128.png` |
| Screenshots | `screenshot-1.png` to `screenshot-5.png` (1280x800), captions below |
| Small promo tile | `promo-small-440x280.png` |
| Marquee promo tile | `promo-marquee-1400x560.png` (optional) |
| Official URL | none, or your verified domain |
| Homepage URL | https://ai-notetaker.apercallc.com |
| Support URL | https://github.com/apercallc/ai-notetaker/issues |
| Mature content | No |

**Description** (plain text, paste as is):

```
Meeting notes without the meeting bot.

AI Notetaker records the meeting you are in from your own browser, then turns it into a transcript, a summary, decisions and action items. No bot joins your call, and nothing is added to the participant list.

HOW IT WORKS
1. Install the extension and choose how the AI runs.
2. Open a Google Meet and start recording. You confirm a recording notice first.
3. When the call ends, review the transcript, summary and action items, and search across all your meetings.

Your microphone and the meeting's audio are recorded as two separate channels, so what you said and what everyone else said stay distinct. Audio is saved on your device before anything is sent anywhere, so a crash or a failed upload never loses a recording.

TWO WAYS TO RUN THE AI
- Your own keys (free): bring your own AI provider keys. No AI Notetaker account is needed. Keys stay in protected storage on your device and go only to the providers you choose.
- Hosted AI: we run transcription and summaries for you. Your first 3 meetings are free with no card. Pro is $12 a month for up to 300 meetings, and Team is $39 a month for a shared workspace with up to 2,500. Audio is deleted from our servers as soon as processing succeeds, and we keep your text notes, not your recordings.

ZOOM, TEAMS AND SLACK
Google Meet needs only this extension. For desktop calls, install the optional AI Notetaker desktop helper for macOS, Windows or Linux from https://ai-notetaker.apercallc.com/download. We are still verifying each app on every operating system.

OPEN AND PRIVATE
AI Notetaker is open source under the MIT license: https://github.com/apercallc/ai-notetaker
Privacy notice: https://ai-notetaker.apercallc.com/privacy

Always tell participants you are recording and get the consent your local law and workplace policy require. AI Notetaker asks you to acknowledge this before every recording. It is not legal advice.
```

**Screenshot captions**

1. Choose how the AI runs: your own keys or Hosted AI.
2. Join a Google Meet and notes begin, with audio saved on your device first.
3. A transcript that keeps you and everyone else separate.
4. Decisions and action items from every meeting, in one inbox.
5. Free with your own keys, or hosted for a flat monthly price.

## 6. Privacy practices tab

**Single purpose**

> AI Notetaker records the audio of a meeting the user chooses to record and turns it into a transcript, summary and action items.

**Permission justifications** (one box per permission)

| Permission | Paste this |
| --- | --- |
| `storage` | Saves the user's settings, provider keys (own-keys mode), sign-in session (Hosted AI) and meeting notes in `chrome.storage.local`. Nothing is written to `chrome.storage.sync`. |
| `unlimitedStorage` | Keeps recoverable meeting audio and notes on the device, so a long meeting is not interrupted or lost when the ordinary extension quota is reached. |
| `activeTab` | Lets the user start capture on the Google Meet tab they are looking at, only when they click the extension or the in-call button. |
| `tabCapture` | Captures the audio of the user's own Google Meet tab so the meeting can be transcribed without a bot. Only starts after the user chooses to record. |
| `offscreen` | Chrome requires an offscreen document to process tab audio in Manifest V3. It exists only while a recording is running. |
| `notifications` | Tells the user when their notes are ready or when a recording needs attention. |
| `clipboardWrite` | Lets the user copy a summary, transcript or share link with one click. |
| Host permission `https://meet.google.com/*` | Runs the in-call Record button and reads the call title on Google Meet, the only site the extension acts on by default. |
| `nativeMessaging` (optional) | Requested only when the user chooses desktop-call recording. Talks to the AI Notetaker desktop helper they installed, using Chrome Native Messaging. No network port is opened. |
| `alarms` (optional) | Schedules bounded background retries and reminders while the service worker is asleep. |
| `identity` (optional) | Runs the user-initiated Google sign-in for optional Calendar and Drive features. |
| Optional host permissions (`https://*/*`, `http://localhost/*`, `http://127.0.0.1/*`) | Requested at runtime, never at install, and only for the single origin the user enters: the Hosted AI service when they sign in, or their own self-hosted history server. |
| Optional provider hosts (Deepgram, Groq, Anthropic, Google Generative Language, DeepSeek) | In own-keys mode, requested only for the AI providers the user picks, so their audio and text can be sent to that provider with their own key. |

If review pushes back on `https://*/*` even as an optional permission, the
fallback is to request the fixed Hosted AI origin only and keep the self-hosted
server as a separate, explicitly entered origin.

**Remote code:** No. All code ships in the package. The extension sends data to
AI providers and the Hosted AI service but never downloads or runs code from
them.

**Data usage** (tick these, leave the rest unticked)

- Personally identifiable information: the email address of a Hosted AI account.
- Authentication information: the user's own provider keys, stored locally, and the Hosted AI session.
- Personal communications: meeting audio and the transcripts made from it.

**Certifications** (tick all three; each is true)

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes unrelated to the item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** https://ai-notetaker.apercallc.com/privacy

The policy includes the Google API Services Limited Use statement, which the
store also expects when an extension touches Google user data.

## 7. Distribution tab

- Visibility: **Public**.
- Regions: all regions.
- Pricing: free. (The store no longer handles payments; Hosted AI is billed on
  the website through Stripe.)

## 8. Notes for the reviewer

Paste into **Test instructions** (Privacy practices tab). Create the reviewer
account first (Hosted AI free trial, three meetings) and fill in the two
bracketed lines.

```
No account is needed to load the extension and see the setup screen.

To try recording with Hosted AI, sign in with this reviewer account:
  Email: [reviewer email]
  Password: [reviewer password]
  (Open the extension, choose "Hosted AI", then "Sign in".)

Steps:
1. Open https://meet.google.com/new and join the call.
2. Click the AI Notetaker icon (or the in-call "Record" button) and confirm the recording notice.
3. Chrome may ask once to capture the tab. Approve it.
4. Talk for about 30 seconds, then stop. Notes appear in the extension a minute or two later, and in the library at https://ai-notetaker.apercallc.com.

Notes: the extension records the user's own Meet tab and microphone. No bot joins the call. The desktop helper is optional and only used for Zoom, Teams and Slack.
```

## 9. Submit

1. **Submit for review**. Leave "Publish automatically after review" on.
2. After it is live, copy the listing URL
   (`https://chromewebstore.google.com/detail/ai-notetaker/<id>`).
3. On Railway (`web` service) set `CHROME_WEB_STORE_URL` to that URL so the
   site's Download page shows **Add to Chrome**.
4. Add the published version to `CHANGELOG.md`.

## 10. Automatic uploads from then on (optional, about 20 minutes)

The release workflow already contains an upload job. It stays off until these
exist, and the first upload must always be manual (steps 1 to 9).

1. <https://console.cloud.google.com>, pick or create a project, then enable the
   **Chrome Web Store API**.
2. **Google Auth Platform**: configure the consent screen as **External**, add
   the scope `https://www.googleapis.com/auth/chromewebstore`, add your own
   Google account as a test user, then set the publishing status to **In
   production**. (In "Testing", the refresh token expires after 7 days and the
   automation would stop working.)
3. **Clients**, **Create client**, type **Desktop app**. Keep the client ID and
   secret.
4. Get a refresh token: run `npx chrome-webstore-upload-keys`, paste the client
   ID and secret when asked, sign in, and copy the refresh token it prints.
5. Store them on GitHub:

```sh
gh secret set CWS_CLIENT_ID
gh secret set CWS_CLIENT_SECRET
gh secret set CWS_REFRESH_TOKEN
gh variable set CWS_EXTENSION_ID --body "<the 32-letter item id>"
```

Every release after that uploads and submits the new extension build. Run
`npx chrome-webstore-upload-cli --help` once to confirm the options still match
the job in `.github/workflows/release-build.yml`; the store has been moving its
publishing API to a new version.

## Reference: what the extension actually requests

From `extension/manifest.json`: permissions `storage`, `activeTab`,
`tabCapture`, `offscreen`, `notifications`, `unlimitedStorage`,
`clipboardWrite`; optional `nativeMessaging`, `alarms`, `identity`; host
permission `https://meet.google.com/*`; optional hosts as listed above. If the
manifest changes, update the justifications before submitting.
