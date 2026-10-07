# Getting started

AI Notetaker is one desktop app for macOS, Windows, and Linux. It records your
microphone and the meeting audio, saves the audio on your device first, and creates
notes, all without a browser extension. Choose **Hosted AI** (sign in; no provider
keys) or **your own keys** (account-free) in **Settings → Processing**. Optional
workspace sync sends finished notes to the web app and copies workspace notes into
the desktop library. The Chrome extension is an optional extra for recording a
browser tab.

For the release and installation model, including direct platform downloads,
first-open warnings, checksums, and the Docker-only webapp option, see the
[current distribution decision](superpowers/specs/2026-09-28-direct-download-distribution.md).

> **Release status.** Preview installers are published for macOS, Windows, and
> Debian/Ubuntu Linux. They are unsigned, and fresh-install and real-call capture
> acceptance is still in progress across platforms. See the
> [release acceptance checklist](launch/release-candidate-checklist.md) before
> relying on a platform capture path.

## Terms used in the product

The desktop app, browser recorder extension, and webapp use plain vocabulary. If
you are contributing, keep user-facing copy consistent with each surface.

| You will see | It means |
| --- | --- |
| **Start recording / Stop recording** | Begin or end saving the active Chrome tab and microphone audio in the extension. |
| **Create notes from saved audio** | Use desktop provider keys to transcribe and summarize imported audio. |
| **Notes style** | The summary template for a meeting: General, Standup, Sales call, 1:1, Interview, or your own. |
| **Hosted AI** | Sign in to your AI Notetaker account and we run transcription and summaries for you, within your plan. No provider keys needed. |
| **Your own keys** | You provide transcription and summarization keys and pay those providers directly. No AI Notetaker account or sign-in is needed. |

"Managed" and "BYOK" are internal engineering terms. They appear in code,
specs, and the contributor documentation, but not in the product UI or in
user-facing copy.

The recording state uses one red across the desktop app and legacy extension,
so "this is being recorded" always looks the same.

## Quickstart: install the desktop preview

Download the [desktop installer for your platform](https://github.com/apercallc/ai-notetaker/releases/latest).
The installers are unsigned, and fresh-install and real-call capture checks
are still in progress. Review
the [release checklist](launch/release-candidate-checklist.md) before relying
on a platform capture path.

## Your account in the desktop app

Sign in under **Settings → Processing** and the desktop app shows the same things as the
web app: **Plans & usage** (meetings, meeting hours and Ask-your-notes questions used, with
upgrade and cancel through the secure billing page), **Ask**, **Actions** (action items
across all notes), **Team** (owners invite, change roles and remove members), and a
**Library** that matches the web library because signing in also connects notes sync.
Recording is the one thing only the desktop app does. Signing out ends the session on the
server and the app goes back to your own keys.

## Developer quickstart: run from source

Building from source is optional; it is not the end-user install path.

1. Install the Rust and Tauri prerequisites for your OS (see
   [`helper/README.md`](../helper/README.md)).
2. Start the development app:

   ```sh
   cd helper
   cargo run -p notetaker-app
   ```

3. In **Settings → Processing**, sign in to Hosted AI, or choose providers and
   enter and test your own API keys, then save.
4. Allow microphone and system-audio access when the OS asks.
5. In **Record**, enter an optional title, confirm recording consent, then
   start and stop the meeting. Find the finished notes under **Notes**.

## Browser meeting recorder extension

The extension records secure browser meeting tabs, including web versions of
Google Meet, Teams, Zoom, Slack, and Discord in Chrome. It saves microphone and tab audio as
separate local tracks. The desktop app imports that audio and makes notes.

### What existing users have installed

1. The **Chrome extension** records the current meeting tab and saves audio in
   browser storage (IndexedDB). New browser recordings do not call AI providers.
2. The **desktop app** imports browser audio, makes notes, and records Zoom,
   Teams, Slack, and other standalone desktop calls directly.

The optional webapp stores finished desktop notes synced to a workspace you
choose. Workspace notes are also copied into the desktop library for local
viewing. Web edits, deletions, and settings are not synchronized back, and extension
captures must still be exported and imported in desktop.

### Recorder prerequisites

### For browser meetings

- Chrome.
- Microphone permission and available Chrome storage. Enter transcription and
  summary provider keys in the desktop app when you create notes.
- Consent from the people you record when local law requires it.
- Start and stop from the extension popup or shortcut on the meeting tab.
  Meet, Teams, Zoom web meetings, Discord channels, and Slack workspaces also have floating recording controls. Chrome may require a toolbar click or shortcut to enable tab audio. Keep the popup's recording state
  visible and stop manually when a same-site call ends.

### For desktop calls in the desktop app

- The desktop helper for your operating system.
- A system-audio source. Native loopback is preferred and needs no extra
  software on current systems:
  - macOS 13 or later: ScreenCaptureKit (grant Screen Recording permission).
    [BlackHole](https://github.com/ExistentialAudio/BlackHole) is a fallback
    that AI Notetaker does not bundle.
  - Windows: WASAPI loopback. Base [VB-CABLE](https://vb-audio.com/Cable/) is a
    fallback with its own licensing and attribution.
  - Linux: a PipeWire or PulseAudio monitor source. A dedicated null sink is a
    fallback only, for systems where no monitor source is available.
- A meeting app that lets you choose its microphone and speakers.

The desktop app uses native loopback where available and does not require
Chrome or Native Messaging.

### Move extension recordings and older notes to the desktop app

1. In extension **Settings → Move recordings to the desktop app**, choose
   **Save full archive** and save the `.ntarchive` file.
2. In desktop app **Settings → Import from the extension**, choose **Full
   archive** and select that file.
3. Select an imported browser recording and choose **Create notes from saved audio**.
   That sends audio through the desktop transcription flow. Check the resulting transcript and summary. Matching meeting IDs are skipped,
   so importing the same file again is safe.
4. Re-enter provider API keys in desktop Settings. Create a separate desktop
   sync token only if you want to connect a web-app workspace.

The archive streams saved raw browser audio in chunks, so long recordings do not
need to fit in memory. It also includes meeting text, partial transcripts, and
portable preferences. The note manifest is limited to 20 MB and total archive
size to 50 GB. Audio from older completed calls may have been removed after
notes were saved, so those meetings transfer as text. New recorder-only audio
stays in Chrome until you remove it. Older 20 MB
notes-only JSON files remain importable. Neither format contains API keys,
web-app tokens, or Google connections. Export and import copy data; the source
extension records are never deleted. Keep the extension installed until you
have checked the imported notes and recordings.

### Install the extension

Install the extension from the Chrome Web Store when the listing is published.
Installing it opens the setup screen automatically.

Until then, load it from source:

1. Build it (see [Build from source](#build-from-source)), or unzip a release
   ZIP if you were given one.
2. Open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select the `extension/dist/` directory.
5. Pin **AI Notetaker** to the toolbar so it is easy to open.

The extension ID should be `jidooookkdbbbhkkdmcajnnnhhphodok`. If Chrome shows
a different ID, the committed `key` was changed or the wrong directory was
loaded. Do not change the `key` in `extension/manifest.json`; the Native
Messaging manifest allowlists that stable ID for older installations.

A normal desktop installer cannot silently install a Chrome extension, so the
extension is always installed from the store or loaded manually.

### Recorder first-run setup

Installing the extension opens the setup screen in a new tab. If you closed it,
click the toolbar icon to reopen it. Everything happens on one screen.

### Provider keys for notes

New Meet recordings need no provider key in Chrome. Enter provider keys in the
desktop app when you create notes from imported audio. Older extension provider
settings remain under **Open previous settings** for migration.

### Allow the microphone

Chrome asks once for microphone access. Allow it. Your microphone and the
meeting's audio are kept as two separate channels, which is what lets the notes
tell you apart from everyone else.

### Confirm consent

Read the one-line disclosure and tick the box only when you understand your
local consent obligations. Recording is blocked until you do. This is general
information, not legal advice.

### Finish

Click **Finish**, then open a Google Meet call.

### Record a Google Meet call

1. Join a call. A small **Notetaker** pill appears in the call; drag it or
   turn it off in Settings if you prefer the toolbar.
2. Start recording with **Alt+Shift+R**, the toolbar icon, or the pill's
   **Start recording** button. Chrome may first need you to invoke the extension
   on the Meet tab to grant capture.
3. The pill shows the recording state and elapsed time. Microphone and call
   audio are saved separately in Chrome.
4. Stop with **Alt+Shift+R**, **Stop recording**, or by ending the call.
5. In extension Settings, choose **Save full archive**. Import that archive in
   desktop Settings and select **Create notes from saved audio** on the
   imported recording.

Chrome assigns suggested shortcuts only when they are free. Check or change
shortcuts at `chrome://extensions/shortcuts`. If Chrome closes mid-call, reopen
the extension and inspect the saved recording before exporting.

## Earlier helper setup for existing extension users

The instructions below describe older extension and helper installations.
New desktop calls start in the desktop app. The older path requires
the desktop helper.

### 1. Install the helper

Open the [AI Notetaker download page](https://ai-notetaker.apercallc.com/download)
or the [latest GitHub release](https://github.com/apercallc/ai-notetaker/releases/latest)
and download the desktop app for your computer. The desktop-first release
workflow targets Apple silicon and Intel Macs, 64-bit Windows, and 64-bit
Debian/Ubuntu Linux.

- **Mac:** choose the Apple silicon or Intel DMG that matches your Mac, open it,
  and double-click **Install AI Notetaker.command**. The package is not
  notarized, so macOS blocks it the first time with a "Not Opened" dialog that
  offers only Cancel and Move to Trash. Choose **Cancel**, open **System
  Settings → Privacy & Security → Security**, click **Open Anyway** next to the
  installer, and enter your password. Then double-click the installer again and
  choose **Install**; it copies AI Notetaker to Applications and opens it. Repeat
  **Open Anyway** if macOS also blocks the app. Never run a command that
  disables Gatekeeper globally.
- **Windows:** run the downloaded installer. If SmartScreen appears, confirm
  the file came from the official GitHub release and compare its SHA-256 with
  `SHA256SUMS`; then choose **More info → Run anyway**. Never disable
  SmartScreen globally.
- **Linux:** open the downloaded `.deb` in Software Install and choose
  **Install**, or use `sudo apt install ./<downloaded-file>.deb`. This release
  path targets Debian/Ubuntu on x86_64 and registers Native Messaging for
  Chrome.

Base VB-CABLE, if included on Windows, is launched visibly with VB-Audio
attribution and may require administrator approval or a reboot. macOS
ScreenCaptureKit and Windows WASAPI loopback do not need virtual drivers for
the usual setup.

Start **AI Notetaker** from your application menu so the tray helper is
running. Launch-at-login is an opt-in tray menu action and is off by default,
so start the helper before a desktop call unless you turn it on.

Do not use `npm install` or `npx` to install the helper. Node packages cannot
safely register Native Messaging, install OS audio prerequisites, or handle
platform elevation.

### 2. Tell the extension it is a desktop call

Open the extension popup, or the setup screen, and choose **Another meeting
app**, **Zoom**, **Microsoft Teams**, or **Slack**. Only this choice shows the
helper install check and audio setup. The extension talks to the helper over
Chrome Native Messaging; there is no open network port.

### 3. Set up audio

Keep your normal headphones or speakers as the operating system's output so
other apps work normally. In the meeting app, choose your **physical
microphone** for Microphone. What you choose for Speaker depends on the OS.

- **macOS:** On macOS 13 and later, keep your physical microphone and normal
  speakers or headphones selected; the helper captures system audio through
  ScreenCaptureKit. Grant Screen Recording permission when prompted. If the
  helper reports the BlackHole fallback, create a Multi-Output Device that
  contains BlackHole and your normal speakers or headphones, then choose it as
  the meeting app's Speaker. Do not choose BlackHole alone or you will not hear
  the meeting.
- **Windows:** The helper normally captures the default speaker or headphone
  endpoint through WASAPI loopback, so no virtual device or routing change is
  needed. If the helper reports the VB-CABLE fallback, enable "Listen to this
  device" for CABLE Output and choose CABLE Input as the meeting app's Speaker;
  keep your physical microphone as Microphone.
- **Linux:** Keep your normal output routing. The helper listens to the
  monitor source of your default output, so the meeting app can keep using your
  usual speakers or headphones, and nothing needs to be re-routed. Only if the
  helper reports that no monitor source is available should you use the
  fallback: choose the helper's "AI Notetaker" null-sink device as the meeting
  app's Speaker (and route it to your real output so you can still hear).
  Either way, do not choose `notetaker_mic` as the meeting microphone; the
  helper reads your normal default input directly.

#### Slack huddles

Open your profile picture, then **Preferences**, then **Audio & video**. Set
**Microphone** to your physical microphone. Leave **Speaker** on your normal
output unless the helper reported a fallback route above. If Slack changes the
device after you join a huddle, use the huddle's three-dots menu and **Select a
speaker**. See Slack's [huddles preferences guide](https://slack.com/help/articles/1500002037922-Adjust-your-huddles-preferences).

#### Microsoft Teams

Open **Settings and more (...)**, then **Settings**, then **Devices**. Under
**Audio settings**, set **Microphone** to your physical microphone, and change
**Speaker** only if the helper reported a fallback route. During an active
meeting, use **More (...)**, then **Settings**, then **Device settings** to
change them. See Microsoft's [Teams device settings guide](https://support.microsoft.com/en-US/Teams/calls-devices/manage-your-call-settings-in-microsoft-teams).

Click **Check devices**, then **Run 2-second test**. Continue only when the
popup reports that both the microphone and the meeting audio are ready.

### 4. Record

1. Start the desktop call and keep the helper tray app running.
2. Open the extension popup, pick a **Notes style**, confirm it says **Audio
   ready**, and click **Start notes**.
3. Click **Stop notes** when the call ends. Keep the helper running until then.

While notes run, the extension shows the live transcript and a red recording
indicator. If a provider request is temporarily unavailable, the helper keeps
the audio locally and retries it. A crash or reboot leaves the recording
recoverable: reopen the popup and choose **Resume** or **Discard**.

### Updating the helper

The helper checks GitHub once a day for a newer stable release and asks before
opening the official download page. GitHub receives the ordinary network
metadata for that request; the helper sends no recordings or provider keys.
The helper never downloads or installs an update for you. Choose **Check for
Updates…** from the tray menu to check manually, then download and install the
new build for your platform. For the optional Docker webapp update path, see
its separate deployment guide.

Download the newer installer from GitHub Releases for each manual update.

## Optional: save notes to Google Drive

Open Settings, then **Google Drive notes**. Create your own Google Cloud OAuth
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

## Optional: connect your calendar

Auto-labels a meeting's title and attendees from Google Calendar or Outlook
Calendar when you start notes. This is optional and never blocks a recording if
it is skipped or fails.

Like your provider API keys, this uses **your own** OAuth app, so no calendar
data passes through a third-party server. Register a free app with the provider
you use:

- Google: [Google Cloud Console, create OAuth client credentials](https://developers.google.com/identity/protocols/oauth2)
  (application type: Chrome Extension), enable the Google Calendar API, and add
  the `calendar.readonly` scope.
- Microsoft: [Microsoft Entra ID, register an application](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app)
  (public client), and add the `Calendars.Read` and `offline_access` Microsoft
  Graph permissions.

Then, in the extension:

1. Open Settings, then **Calendar**.
2. Pick your provider. Copy the redirect URI shown and add it to your OAuth
   app's registered redirect URIs.
3. Paste the Client ID (Google also needs its Client Secret; see the design
   note in
   [`docs/superpowers/specs/2026-09-22-calendar-integration-design.md`](superpowers/specs/2026-09-22-calendar-integration-design.md)
   for why this is safe to store locally for this OAuth client type).
4. Click **Connect** and approve access in the popup.

## Use meetings and action items later

- Click a meeting in **Recent meetings** to open its notes page.
- Use **Action inbox** for action items across meetings.
- Open Settings to change providers, keys, Notes style, vocabulary, summary
  instructions, or the optional webapp connection.

## Optional web-app sync

Local history is the default and requires no server. For cross-device history:

1. Deploy or sign into the webapp and open **Settings → Integrations**.
2. Create a **Desktop note sync** token for the selected workspace.
3. In the desktop app's **Settings**, enter the web-app URL and token, then
   test the connection and save.

Sync is optional. It sends finished transcripts, summaries, and action items;
raw audio and provider keys remain local. The webapp does not call Deepgram,
Claude, Groq, Gemini, or DeepSeek and never needs those keys. Existing
extension users keep their prior connection settings during migration.

For a local or private Docker deployment instead, download the two versioned
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
the native helper. If the registry image cannot be pulled, use the local build
Compose flow in [`webapp/README.md`](../webapp/README.md#deploy-with-docker-compose).

## Other browsers

Chrome is the supported browser. Non-Chrome browser ports are out of scope for
now, so nothing below is tested against real Google Meet calls or covered by
support.

- **Edge and Brave** are Chromium-based and may load the same extension build
  (`edge://extensions` or `brave://extensions`, Developer mode, **Load
  unpacked**, select `dist/`). This is unsupported. The helper installer also
  registers its Native Messaging host for these browsers, which is what
  desktop-call capture would use.
- **Firefox** has an **experimental** port with its own manifest fields and
  Native Messaging host shape (see
  [`docs/superpowers/specs/2026-09-22-cross-browser-ports-design.md`](superpowers/specs/2026-09-22-cross-browser-ports-design.md)).
  It is unsigned, so it loads only as a temporary add-on through
  `about:debugging`, and it resets every time Firefox restarts. Do not rely on
  it for meetings that matter.

## Troubleshooting

### Nothing happens when I press Alt+Shift+R

Chrome assigns the suggested shortcut only when it is free. Open
`chrome://extensions/shortcuts` to check or set it, or use the toolbar icon or
the on-page pill instead. The shortcut only works on a `meet.google.com` tab.

### Chrome will not capture the Meet tab

Chrome must be invoked on the Meet tab once before it lets the extension
capture its audio. Click the AI Notetaker toolbar icon (or press the shortcut)
while the Meet tab is open, then start notes again. Also confirm microphone
access is allowed for the extension.

### "Helper not detected" (desktop calls only)

This applies only to Zoom, Teams, Slack, and other desktop calls. Make sure
**AI Notetaker** is running in the tray. If you built with Cargo, make sure you
also installed the package or registered `com.ainotetaker.helper.json`; a binary
sitting in `target/release/` is not automatically visible to Chrome. Reload the
extension after installing the manifest.

### "Audio needs attention" (desktop calls only)

Check all of the following:

- The meeting app uses the physical microphone you expect, and, if the helper
  reported a fallback route, the fallback device for its Speaker.
- Your normal headphones or speakers are still connected.
- The helper tray app is running.
- You restarted the meeting app after installing or changing a virtual audio
  device.
- The two-second test hears both microphone and meeting audio.

### A provider key will not validate

Confirm that the key belongs to the provider selected in Settings, has not been
revoked, and has the required account access. Test the key again after saving
the correct tier. Provider pricing and limits are controlled by the provider,
not AI Notetaker.

### The extension ID or Native Messaging connection is wrong (desktop calls)

The expected extension ID is `jidooookkdbbbhkkdmcajnnnhhphodok`. Check that the
host manifest's `allowed_origins` contains exactly:

```text
chrome-extension://jidooookkdbbbhkkdmcajnnnhhphodok/
```

Also check that its `path` points to `notetaker-nm-host`, while the persistent
`notetaker-helper` process is already running.

### I want to remove everything

Stop notes first. For Google Meet, removing the extension removes its local
data. For desktop calls, quit the helper first, then remove the extension,
uninstall the helper package, remove the Native Messaging manifest, and delete
the helper data directory if you want a clean reset. The data directory
contains raw mic/speaker audio, transcripts, summaries, pairing state, and
retry queues. Use [`helper-packaging.md#uninstall`](helper-packaging.md#uninstall)
for the OS-specific cleanup and the official BlackHole/VB-CABLE uninstall path.

## Build from source

This section documents development and legacy builds. For the desktop app
preview, use the [installer quickstart](#quickstart-install-the-desktop-preview).
Source builds are optional and are not the general-user install path.

### 1. Get the repository

```sh
git clone https://github.com/apercallc/ai-notetaker.git
cd ai-notetaker
```

### 2. Build the legacy extension

```sh
cd extension
npm install
npm run build
cd ..
```

The build creates `extension/dist/`, which Chrome loads as an unpacked
extension (see [Install the extension](#install-the-extension)).

### 3. Build the legacy helper/Native Messaging path

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

- `helper/target/release/notetaker-helper`, the persistent tray app.
- `helper/target/release/notetaker-nm-host`, the short-lived relay Chrome
  starts for each extension connection.

Running `cargo build` alone is not enough. Chrome also needs the Native
Messaging manifest and the relay at a stable path. The easiest source-build
route on Linux is to build and install the Debian package:

```sh
cd helper/crates/app
npx --yes @tauri-apps/cli@2.11.5 build --bundles deb
sudo apt install ../../target/release/bundle/deb/*.deb
cd ../../..
```

The Debian installer registers the manifest automatically. Start **AI
Notetaker** from your application menu.

On macOS or Windows, build the package on that operating system so its native
installer hooks can run:

```sh
# macOS
cd helper/crates/app && npx --yes @tauri-apps/cli@2.11.5 build --bundles dmg

# Windows PowerShell
cd helper\crates\app; npx --yes @tauri-apps/cli@2.11.5 build --bundles msi,nsis
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

## What is verified

The repository has automated coverage for the provider clients, local storage,
retry and recovery logic, extension state, and webapp API. A real OS install, a
real audio-loopback setup, a Chrome-to-helper handshake, a provider call, and a
live meeting still require manual validation on the target machine. That
boundary is intentional: passing tests is not the same as proving a real
meeting works.
