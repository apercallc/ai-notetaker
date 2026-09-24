# Getting started

This is the complete first-use guide for AI Notetaker. You only need the
optional webapp if you want meeting history on more than one device.

For the release and installation model—including Homebrew Cask,
WinGet/Chocolatey, OS prerequisite detection, release updates, and the
Docker-only webapp option—see the [distribution and installation architecture](superpowers/specs/2026-09-21-distribution-and-installation-architecture.md).

## What you are installing

AI Notetaker has two required parts:

1. The **desktop helper** is a small tray app. It owns audio capture, local
   files, provider calls, transcription, summaries, retries, and recovery.
2. The **Chrome extension** is the control panel. It starts and stops
   recordings, shows the live transcript, and opens finished meetings.

The optional **self-hosted webapp** stores finished meetings on a server you
control. The extension works without it.

## Before you start

Have these ready:

- Chrome or a Chromium browser.
- A supported virtual-audio device for your OS:
  - macOS: [BlackHole](https://github.com/ExistentialAudio/BlackHole), which
    AI Notetaker does not bundle.
  - Windows: base [VB-CABLE](https://vb-audio.com/Cable/), with its own
    licensing and attribution.
  - Linux: PulseAudio or PipeWire with the helper's null-sink integration.
- Two provider API keys: one transcription key and one summarization key.
- A meeting app that lets you choose its microphone and speakers.
- Consent from the people you record when local law requires it.

The intended production flow is the Chrome Web Store extension plus a native
helper installer for the user's OS. Docker is supported for the optional
history webapp, not for desktop audio capture.

## Install without cloning the repository

Open the [install page](https://apercallc.github.io/ai-notetaker/) first. It
detects your OS and displays only the channels that exist in the current
published release. A native helper is required; the extension cannot capture
audio by itself.

### macOS

```sh
brew install --cask ai-notetaker
brew upgrade --cask ai-notetaker
```

Homebrew Cask installs the same signed DMG used by the release page and runs
the Native Messaging registration hook. AI Notetaker links to the official
BlackHole installer; it never bundles BlackHole.

### Windows

```powershell
winget install AI.Notetaker
winget upgrade AI.Notetaker

# Chocolatey alternative
choco install ai-notetaker
choco upgrade ai-notetaker
```

The installer registers Chrome/Edge/Brave/Firefox Native Messaging. Base
VB-CABLE, if required by the release, is launched visibly with VB-Audio
attribution and may require administrator approval or a reboot.

### Linux

Download the `.deb` matching your architecture from the latest release, then:

```sh
sudo apt install ./AI-Notetaker_<version>_amd64.deb
```

Run `sudo apt install` again with the newer `.deb` to update. Use the AppImage
only when a Debian package is not suitable; it needs an explicit stable-path
Native Messaging registration and is not the recommended first install.

### Extension

Install the extension from the Chrome Web Store when the listing is published.
Until then, use the release ZIP as a managed/development fallback and load it
from `chrome://extensions` with Developer mode. A normal desktop installer
cannot silently install a Chrome extension.

### npm and npx: contributor/diagnostic tools only

Do not use `npm install` or `npx` to install the desktop helper. Node packages
cannot safely register Native Messaging, install OS audio prerequisites, or
handle platform elevation. npm is used below for extension/webapp development;
the supported end-user helper channels are native installers and package
managers. A future `npx @ai-notetaker/cli doctor` may inspect an installation,
but it will not replace the signed helper installer.

### Updating

Use the same channel used to install the helper. Do not mix a package-manager
install with a direct-download updater:

| Install method | Update command |
| --- | --- |
| Homebrew Cask | `brew upgrade --cask ai-notetaker` |
| WinGet | `winget upgrade AI.Notetaker` |
| Chocolatey | `choco upgrade ai-notetaker` |
| Linux `.deb` | `sudo apt install ./AI-Notetaker_<new-version>_amd64.deb` |
| Release DMG/MSI/NSIS | Download and run the newer installer |
| Docker image | `docker compose -f webapp/docker-compose.registry.yml pull && docker compose -f webapp/docker-compose.registry.yml up -d` |

The Tauri automatic updater remains disabled until the release owner supplies
and protects the updater key and endpoint. Package-manager upgrades are the
safe update path today.

## Build from source

This section is for contributors, private managed deployments, and release
owners. End users should use the package-manager path above whenever a release
is published.

### 1. Get the repository

```sh
git clone https://github.com/apercallc/ai-notetaker.git
cd ai-notetaker
```

### 2. Build the extension

```sh
cd extension
npm install
npm run build
cd ..
```

The build creates `extension/dist/`, which Chrome loads as an unpacked
extension.

### 3. Build and install the helper

Install the Rust toolchain and the Tauri desktop dependencies for your OS.
Linux dependencies and package commands are listed in
[`helper/README.md`](../helper/README.md) and
[`helper-packaging.md`](helper-packaging.md).

For a development binary:

```sh
cd helper
cargo build --release -p notetaker-app
cd ..
```

The two binaries are:

- `helper/target/release/notetaker-helper` — the persistent tray app.
- `helper/target/release/notetaker-nm-host` — the short-lived relay Chrome
  starts for each extension connection.

Running `cargo build` alone is not enough. Chrome also needs the Native
Messaging manifest and the relay at a stable path. The easiest source-build
route on Linux is to build and install the Debian package:

```sh
cd helper/crates/app
npx --yes @tauri-apps/cli@latest build --bundles deb
sudo apt install ../../target/release/bundle/deb/*.deb
cd ../../..
```

The Debian installer registers the manifest automatically. Start **AI
Notetaker** from your application menu, then continue below.

On macOS or Windows, build the package on that operating system so its native
installer hooks can run:

```sh
# macOS
cd helper/crates/app && npx --yes @tauri-apps/cli@latest build --bundles dmg

# Windows PowerShell
cd helper\crates\app; npx --yes @tauri-apps/cli@latest build --bundles msi,nsis
```

The macOS DMG requires one extra post-copy step because a DMG has no
post-install hook. After copying **AI Notetaker.app** to Applications, run:

```sh
sh "/Applications/AI Notetaker.app/Contents/Resources/scripts/install-native-messaging.sh"
```

See [`helper-packaging.md`](helper-packaging.md) for the guarded uninstall
commands and platform-specific details.

### Manual Linux registration, if you did not build a package

Use this only when you need the raw development binaries. It installs them
under your user account and writes the manifest Chrome reads:

```sh
mkdir -p "$HOME/.local/bin" "$HOME/.config/google-chrome/NativeMessagingHosts"
cp helper/target/release/notetaker-helper helper/target/release/notetaker-nm-host "$HOME/.local/bin/"
sed "s|__NM_HOST_BINARY_PATH__|$HOME/.local/bin/notetaker-nm-host|" \
  helper/native-messaging-host-manifest/com.ainotetaker.helper.json.template \
  > "$HOME/.config/google-chrome/NativeMessagingHosts/com.ainotetaker.helper.json"
"$HOME/.local/bin/notetaker-helper" &
```

If you use Chromium instead of Google Chrome, place the same manifest under
`~/.config/chromium/NativeMessagingHosts/`. The manifest must keep the fixed
extension origin shown in the template.

## Install the extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select the repository's `extension/dist/` directory.
5. Pin **AI Notetaker** to the toolbar so it is easy to open.

The extension ID should be:
`jidooookkdbbbhkkdmcajnnnhhphodok`.

If Chrome gives you a different ID, the committed `key` was changed or the
wrong directory was loaded. Do not change `extension/manifest.json`'s `key`;
the Native Messaging manifest allowlists the stable ID.

### Using Edge or Brave instead of Chrome

The same extension build works in Edge and Brave (both are Chromium-based
and implement the same extension APIs). Since it isn't published to
Edge Add-ons or listed for Brave, load it manually:

1. Download or build the extension (`extension/dist/`, or the released
   ZIP).
2. Edge: go to `edge://extensions`, enable **Developer mode**, click
   **Load unpacked**, select the `dist/` folder.
   Brave: go to `brave://extensions`, enable **Developer Mode**, click
   **Load unpacked**, select the `dist/` folder.
3. Install the desktop helper as normal — its installer registers the
   Native Messaging host for Edge and Brave automatically, alongside
   Chrome.

### Using Firefox

Firefox support is a real port (its own manifest fields and Native
Messaging host manifest shape — see
`docs/superpowers/specs/2026-09-22-cross-browser-ports-design.md`), but
the extension isn't signed by Mozilla yet, so it only loads temporarily:

1. Build the extension (`extension/dist/`).
2. Go to `about:debugging` → **This Firefox** → **Load Temporary Add-on…**
   → select any file inside `dist/` (e.g. `manifest.json`).
3. This resets every time Firefox restarts until the extension is signed
   and published via addons.mozilla.org (release-owner work).
4. Install the desktop helper as normal — its installer registers the
   Firefox-specific Native Messaging host manifest automatically.

## Complete the first-run wizard

Open the extension popup and choose **Start setup**. Complete each step:

### Step 1: Install the desktop helper

Start the tray helper before continuing. Leave it running while you record.
The extension is only a UI; it cannot capture audio on its own.

### Step 2: Set up audio

Use this normal routing: in the meeting app, choose your **physical
microphone** for Microphone/Input and the platform's **virtual meeting output**
for Speaker/Output. Keep your normal headphones or speakers as the operating
system's output so other apps continue to work normally. The helper captures
the physical/default microphone and listens to the virtual output's monitor.

Google Meet has a lower-setup browser option. Join your call and a small
**Notetaker** pill appears in the corner of the page (drag it anywhere; turn it
off in Settings if you prefer the toolbar popup). Open it and choose **Start
taking notes**. The extension keeps the microphone and the meeting's audio as
two separate channels and continues routing the tab audio so you can use Meet
normally.

The first time, Chrome needs two one-time approvals, and the pill tells you
which one is missing: click **Allow microphone** to grant the microphone, and
click the **Notetaker icon in the Chrome toolbar** once while the Meet tab is
open so Chrome lets the extension capture that tab's audio. (That approval
lasts for the tab, so later starts from the pill are one click.) Optional
keyboard shortcuts start or stop notes and flag a moment. Chrome only assigns
the suggested ones when they are free, so check or change them at
`chrome://extensions/shortcuts`; Settings shows what is currently set. Flagged
moments appear in the finished notes and jump to the matching spot in the
transcript. Zoom, Microsoft
Teams, and Slack Huddles use the desktop-helper routing below.

Choose the devices in the meeting app, not only in the operating system:

- **macOS:** In Audio MIDI Setup, create a Multi-Output Device containing
  BlackHole and your headphones or speakers. Choose the Multi-Output Device
  as the meeting app's Speaker and your physical microphone as Microphone.
  Do not choose BlackHole alone or you will not hear the meeting.
- **Windows:** Enable “Listen to this device” for CABLE Output and choose
  your normal headphones for playback. Choose CABLE Input as the meeting
  app's Speaker and your physical microphone as Microphone.
- **Linux:** Choose the helper's “AI Notetaker” PulseAudio/PipeWire virtual
  device as the meeting app's Speaker and your physical/default microphone as
  Microphone. Keep your normal speakers or headphones as the system output.
  Do not choose `notetaker_mic` as the meeting microphone; the helper reads
  your normal default input directly.

#### Slack huddles

Open your profile picture → **Preferences** → **Audio & video**. Set
**Microphone** to your physical microphone and **Speaker** to the virtual
meeting output above. If Slack changes the device after you join a huddle,
use the huddle's three-dots menu → **Select a speaker**. See Slack's
[huddles preferences guide](https://slack.com/help/articles/1500002037922-Adjust-your-huddles-preferences).

#### Microsoft Teams

Open **Settings and more (…)** → **Settings** → **Devices**. Under **Audio
settings**, set **Microphone** to your physical microphone and **Speaker** to
the virtual meeting output above. During an active meeting, use **More (…)**
→ **Settings** → **Device settings** if you need to change them. See
Microsoft's [Teams device settings guide](https://support.microsoft.com/en-US/Teams/calls-devices/manage-your-call-settings-in-microsoft-teams).

Click **Check devices**, then **Run 2-second test**. Continue only when the
wizard reports that both the microphone and meeting audio are ready.

### Step 3: Add provider keys

Enter **two API keys**, one for each job. They are entered in **Step 3 of the
browser setup wizard**; after setup, edit the same keys under the extension's
**Settings → AI provider** section. A single key is not enough because
transcription and summarization are separate provider calls.

The recommended default tier asks for:

- **Key 1 — Deepgram:** transcription, including live transcript updates.
- **Key 2 — Claude:** summarization and action items after you stop.

AI Notetaker supports these provider roles:

| Role | Supported providers | What it does |
| --- | --- | --- |
| Transcription | Deepgram or Groq | Turns microphone and meeting audio into text |
| Summarization | Claude, Gemini, or DeepSeek | Turns the transcript into a summary and action items |

The **Default** tier uses Deepgram + Claude. The **Budget** tier uses Groq +
Gemini or DeepSeek; choose the summarizer in Settings. Budget transcription is
batch-based, so live partial transcripts are less immediate.

Enter each key, click **Test keys**, and continue only after both checks pass.
Keys are stored in the browser's `chrome.storage.local`; they are not sent to
the optional webapp.

You can switch between the Default and Budget tiers later in **Settings → AI
provider**. The settings page labels every field by role and marks that both
roles need a key.

### Step 4: Acknowledge recording consent

Read the disclosure and check the box only when you understand your local
consent obligations. Finish the wizard.

## Record your first meeting

1. Open the meeting app.
2. For Zoom, Teams, or Slack Huddles, set its microphone and speaker to the AI
   Notetaker devices from Step 2. For Google Meet, leave normal Meet devices
   selected and use the Notetaker pill on the call page (or **Google Meet —
   capture this tab** in the popup) instead.
3. Open the extension popup.
4. Choose **General**, **Standup**, **Sales call**, **1:1**, **Interview**, or
   a custom meeting mode.
5. Confirm the popup says **Audio ready** for desktop-helper mode. Meet browser
   mode does not require the virtual-output probe, but the helper still must
   be connected because it owns local storage and the AI pipeline.
6. Click **Record** and approve the browser capture prompts if shown.
7. Keep the helper tray app running until you click **Stop recording**.

While recording, the extension shows live transcript lines and a recording
indicator. If a provider request is temporarily unavailable, the helper keeps
the audio locally and retries it.

When you stop, wait for processing to finish. Open the meeting from **Recent
meetings** to see:

- the summary;
- action items, including due dates and completion state; and
- the full speaker-labeled transcript.

## Optional: save notes to Google Drive

Open Settings → **Google Drive notes**. Create your own Google Cloud OAuth
client (Chrome extension), enable the Google Drive API, register the redirect
URI shown by the extension, and connect it. The extension requests only
`https://www.googleapis.com/auth/drive.file`; it does not use the Calendar
token or send credentials through the helper or a project server.

When a summary finishes, AI Notetaker creates or reuses `My Drive/ai-notetaker`
and creates a Google Doc titled `<meeting name> — <YYYY-MM-DD>`. The document
contains metadata, Summary, Key decisions, Action items, Discussion
highlights, Open questions, and the speaker-labeled Transcript. Local storage
is authoritative: a Drive outage shows **Retry Drive export** on the meeting
page and cannot lose or invalidate the meeting.

## Use meetings and action items later

- Click a meeting in **Recent meetings** to open its detail page.
- Use **Action inbox** for action items across meetings.
- Open Settings to change providers, keys, meeting mode, vocabulary, summary
  instructions, or the optional webapp connection.
- If the helper or browser crashes during a recording, reopen the popup and
  choose **Resume** or **Discard** on the recoverable-recording banner.

## Optional: connect your own history webapp

Local history is the default and requires no server. For cross-device history:

1. Deploy the webapp by following [`webapp/README.md`](../webapp/README.md).
2. Open the extension's Settings page.
3. Enter the deployed HTTPS URL and its access token.
4. Click **Test connection**, then **Save settings**.

The webapp is self-hosted by you. It stores finished notes and action items;
it does not call Deepgram, Claude, Groq, Gemini, or DeepSeek and never needs
those keys.

For a local/private Docker deployment instead, download the two versioned
configuration files without cloning the repository, then use the prebuilt
registry image:

```sh
mkdir -p ai-notetaker-webapp && cd ai-notetaker-webapp
curl -fsSLo docker-compose.registry.yml https://raw.githubusercontent.com/apercallc/ai-notetaker/main/webapp/docker-compose.registry.yml
curl -fsSLo .env.docker.example https://raw.githubusercontent.com/apercallc/ai-notetaker/main/webapp/.env.docker.example
cp .env.docker.example .env
docker compose -f docker-compose.registry.yml --env-file .env pull
docker compose -f docker-compose.registry.yml --env-file .env up -d
```

The image is for the history webapp only. It never captures audio or replaces
the native helper. If the registry image is not published yet, use the local
build Compose flow in [`webapp/README.md`](../webapp/README.md#deploy-with-docker-compose).

## Optional: connect your calendar

Auto-labels a meeting's title and attendees from Google Calendar or
Outlook Calendar when you start recording. This is entirely optional and
never blocks a recording if it's skipped or fails.

Like your provider API keys, this uses **your own** OAuth app — never one
run by this project — so no calendar data passes through a third-party
server. Register a free app with the provider you use:

- Google: [Google Cloud Console — create OAuth client credentials](https://developers.google.com/identity/protocols/oauth2)
  (application type: Chrome Extension), enable the Google Calendar API,
  and add the `calendar.readonly` scope.
- Microsoft: [Microsoft Entra ID — register an application](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app)
  (public client), and add the `Calendars.Read` and `offline_access`
  Microsoft Graph permissions.

Then, in the extension:

1. Open Settings → **Calendar**.
2. Pick your provider. Copy the redirect URI shown and add it to your
   OAuth app's registered redirect URIs.
3. Paste the Client ID (Google also needs its Client Secret — see the
   design note in
   [`docs/superpowers/specs/2026-09-22-calendar-integration-design.md`](superpowers/specs/2026-09-22-calendar-integration-design.md)
   for why this is safe to store locally for this OAuth client type).
4. Click **Connect** and approve access in the popup.

## Troubleshooting

### “Helper not detected”

Make sure **AI Notetaker** is running in the tray. If you built with Cargo,
make sure you also installed the package or registered
`com.ainotetaker.helper.json`; a binary sitting in `target/release/` is not
automatically visible to Chrome. Reload the extension after installing the
manifest.

### “Audio needs attention”

Check all of the following:

- The meeting app uses the AI Notetaker device for both input and output.
- Your normal headphones or speakers are still connected.
- The helper tray app is running.
- You restarted the meeting app after installing or changing the virtual
  audio device.
- The two-second test hears both microphone and meeting audio.

### A provider key will not validate

Confirm that the key belongs to the provider selected in Settings, has not
been revoked, and has the required account access. Test the key again after
saving the correct tier. Provider pricing and limits are controlled by the
provider, not AI Notetaker.

### The extension ID or Native Messaging connection is wrong

The expected extension ID is
`jidooookkdbbbhkkdmcajnnnhhphodok`. Check that the host manifest's
`allowed_origins` contains exactly:

```text
chrome-extension://jidooookkdbbbhkkdmcajnnnhhphodok/
```

Also check that its `path` points to `notetaker-nm-host`, while the persistent
`notetaker-helper` process is already running.

### I want to remove everything

Stop recording and quit the helper first. Then remove the extension, uninstall
the helper package, remove the Native Messaging manifest, and delete the
helper data directory if you want a clean reset. The data directory contains
raw mic/speaker PCM, transcripts, summaries, pairing state, and retry queues.
Use [`helper-packaging.md#uninstall`](helper-packaging.md#uninstall) for the
OS-specific cleanup and the official BlackHole/VB-CABLE uninstall path.

## What is verified

The repository has automated coverage for the provider clients, local storage,
retry/recovery logic, extension state, and webapp API. A real OS install,
virtual-audio driver, Chrome-to-helper handshake, provider call, and live
meeting still require manual validation on the target machine. That boundary
is intentional: passing tests is not the same as proving a real meeting works.
