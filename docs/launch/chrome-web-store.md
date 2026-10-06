# Chrome Web Store: step by step

> **Browser recorder listing draft.** New recordings stay in Chrome until the
> user exports them and imports the archive in AI Notetaker desktop for notes.
> Validate screenshots and real calls before submission. Expanded site access
> may require existing users to approve new permissions and reload meeting tabs.

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

## 3. Verify the stable extension ID

The committed manifest key and ID must remain unchanged while existing users
rely on Native Messaging. Compare the store Item ID with
`jidooookkdbbbhkkdmcajnnnhhphodok`. Stop submission if they differ and resolve
the publisher/package identity before proceeding; do not rotate the key as a
routine release step.

## 4. Upload the real package

1. Wait for the new release (about 20 minutes) and download its
   `ai-notetaker-chrome-web-store-<version>.zip`.
2. Dashboard, **Package**, **Upload new package**. Confirm the package retains
   the committed manifest `key` that matches the store's key.
3. Confirm the version shown is the new one.

## 5. Store listing

**Name:** AI Notetaker

**Summary:** Record Meet, Teams, Zoom, Discord and Slack browser audio locally. Export to AI Notetaker desktop for notes.

**Description** (plain text):

```
Record your meeting without adding a bot.

Capture the audio playing in a Chrome meeting tab and your microphone as separate local tracks. Use Google Meet, Microsoft Teams, Zoom web meetings, Discord calls, or Slack huddles. A floating recording control is available on supported web app pages; other secure meeting tabs use the toolbar popup or recording shortcut.

1. Complete microphone and recording-consent setup.
2. Join the call in Chrome and tell everyone before recording.
3. Choose Start recording. If Chrome asks, click the AI Notetaker toolbar icon or use the recording shortcut to enable tab audio.
4. Stop recording, then export the archive from extension Settings.
5. Import the archive in AI Notetaker desktop and use your provider keys to create a transcript, summary and action items.

No AI Notetaker account or provider key is required to record browser audio. Transcription and summaries happen in the desktop app after import. Optional workspace sync shares finished note text; the extension does not yet share a live desktop library.

For meetings in a desktop app, use AI Notetaker desktop for macOS, Windows or Linux. System audio can include other apps and notifications. Site and device behavior varies; see the current acceptance status in the project documentation.

Recordings are saved on your device as capture progresses. Keep exported copies before removing the extension or its browser profile.

Open source: https://github.com/apercallc/ai-notetaker
Desktop downloads: https://ai-notetaker.apercallc.com/download
Privacy: https://ai-notetaker.apercallc.com/privacy

Tell everyone before recording and obtain the consent required by your workplace and local rules. No bot or automatic participant notification is added.
```

Replace historical screenshots with current captures of setup, a floating
control, the popup, archive export, and desktop import before submission.
Do not submit images that imply new calls are processed in the extension.

## 6. Privacy practices and permissions

**Single purpose:** Record a user-selected meeting tab and microphone locally
for export to AI Notetaker desktop.

| Permission | Purpose |
| --- | --- |
| `storage` | Local recording settings and preserved legacy notes/settings. No synced secret storage. |
| `unlimitedStorage` | Durable local recording audio, including long calls and recovery. |
| `activeTab` | Access to the current tab after the user invokes the toolbar action or shortcut. An in-page click alone does not grant it. |
| `tabCapture` | Capture the meeting audio in the user-selected browser tab. |
| `offscreen` | Keep separate microphone and meeting audio capture running after the popup closes. |
| `notifications` | Recording errors and preserved legacy notes-ready notifications. |
| `clipboardWrite` | User-initiated copy of disclosure text or existing notes. |
| Meeting-site hosts | Floating controls on `meet.google.com`, `teams.microsoft.com`, `teams.live.com`, `teams.cloud.microsoft`, `*.zoom.us`, `discord.com`, and `app.slack.com`. Only Google Meet receives the direct audio bridge; other sites use Chrome tab capture. No chat markup is read. |
| `nativeMessaging` (optional) | Preserve the installed extension/helper compatibility path. New browser recordings do not need it. |
| `alarms` (optional) | Existing bounded retry and reminder features. |
| `identity` (optional) | User-initiated legacy Google/Calendar/Drive features. |
| Optional service and provider hosts | Retained for existing records and settings during migration, requested only for the configured origin. New browser recording does not call providers. |

**Remote code:** No. Code ships in the extension package.

**Data usage:** Meeting audio and retained transcripts are personal
communications. Preserved legacy accounts and credentials also require the
applicable identity/authentication disclosures. Audit the packaged build
against the dashboard declarations before submission.

**Privacy policy:** https://ai-notetaker.apercallc.com/privacy

## 7. Distribution

The extension is free to record. Processing requires AI Notetaker desktop and
the user's provider keys. Keep browser capture and desktop processing clear
in the listing and screenshots.

## 8. Reviewer instructions

```
No AI Notetaker account or provider key is required for extension recording.

1. Complete setup: grant microphone access and acknowledge recording consent.
2. Open a meeting in Chrome (Meet, Teams, Zoom web, Discord, or Slack).
3. Tell participants, then use the floating recording control. If prompted, click the extension toolbar icon or use the recording shortcut to grant tab capture. The popup also offers Start recording.
4. Speak and play call audio, then stop recording. The popup shows Audio saved.
5. Open Settings and export recordings. Import the .ntarchive in AI Notetaker desktop to process it using provider keys.
6. Confirm both microphone and meeting audio are present after import. Check stop, tab close, navigation, permission denial, and a second recording.

The extension saves audio locally. No bot joins the call. Native Messaging is retained for compatibility and is not required for this recording/export flow.
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
permissions for the meeting-site hosts listed above; optional hosts as listed above. If the
manifest changes, update the justifications before submitting.
