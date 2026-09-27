# Getting started

This is the complete first-use guide for AI Notetaker. It has two paths:

- **Google Meet in Chrome** needs only the Chrome extension. There is nothing
  else to install, and no audio routing to configure.
- **Desktop calls** (Zoom, Microsoft Teams, Slack huddles, and other desktop
  apps) additionally need the desktop helper and a system-audio source. Jump
  to [Desktop calls](#desktop-calls-zoom-teams-slack).

You only need the optional webapp if you want meeting history on more than
one device.

For the release and installation model, including Homebrew Cask,
WinGet/Chocolatey, OS prerequisite detection, release updates, and the
Docker-only webapp option, see the [distribution and installation architecture](superpowers/specs/2026-09-21-distribution-and-installation-architecture.md).

> **Release status.** The repository has no public release yet. Package
> manager commands, the Chrome Web Store listing, and the signed installers in
> this guide describe the release channels as they will work
> **when released**. Until then, use the [build from source](#build-from-source)
> path.

## Terms used in the product

The extension, helper tray, and webapp use the same plain vocabulary. If you
are contributing, keep user-facing copy consistent with it.

| You will see | It means |
| --- | --- |
| **Start notes / Stop notes** | Begin or end recording a meeting. (Not "record" or "capture" in user-facing copy.) |
| **Notes style** | The summary template for a meeting: General, Standup, Sales call, 1:1, Interview, or your own. |
| **Use my own API keys (free)** | You provide a transcription key and a summarization key and pay those providers directly. No account is needed. |
| **Hosted (paid)** | You sign in to the project-operated service, which handles the AI providers and bills you for usage. |

"Managed" and "BYOK" are internal engineering terms. They appear in code,
specs, and the contributor documentation, but not in the product UI or in
user-facing copy.

The recording state uses one red across the extension, the helper tray icon,
and the webapp, so "this is being recorded" always looks the same.

## Quickstart: Google Meet in about a minute

1. Install the AI Notetaker extension from the Chrome Web Store (when the
   listing is published), or load it from source as described in
   [Install the extension](#install-the-extension).
2. Installing opens the setup screen automatically. On that one screen:
   - choose **Use my own API keys (free)** and paste a transcription key and a
     summarization key, or choose **Hosted (paid)** and sign in;
   - allow the microphone when Chrome asks; and
   - tick the one-line recording-consent box.
3. Click **Finish**, then **Open Google Meet**.
4. Join a call. Press **Alt+Shift+R** (or click the AI Notetaker toolbar icon)
   to start notes.
5. When the call ends, press **Alt+Shift+R** again, or simply hang up. Either
   one stops the notes and finalizes them.
6. A **Notes ready** notification appears. Click it to open the notes page with
   the summary, action items, and transcript.

The details behind each step follow below.

## What you are installing

1. The **Chrome extension** owns Google Meet tab capture. It saves the
   microphone and meeting audio in local browser storage (IndexedDB) and then
   runs the AI step itself, either directly with your own keys or through the
   hosted service.
2. The **desktop helper** is a tray app that is required only for Zoom, Teams,
   Slack, and other desktop-call sources. It owns native audio capture, local
   files, provider calls, retries, and recovery for those sources. It is never
   needed for Google Meet.

The optional **self-hosted webapp** stores finished meetings on a server you
control. The extension works without it.

## Before you start

### For Google Meet

- Chrome.
- One of:
  - **Use my own API keys (free):** two provider keys, one for transcription
    and one for summarization. See [Choose how AI runs](#choose-how-ai-runs).
  - **Hosted (paid):** an account on the hosted service. No provider keys are
    needed, and provider keys never enter the extension.
- Consent from the people you record when local law requires it.

### For desktop calls (in addition to the above)

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

The intended production flow is the Chrome Web Store extension plus, for
desktop calls, a native helper installer for your OS. Docker is supported for
the optional history webapp, not for desktop audio capture.

## Install the extension

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
Messaging manifest allowlists that stable ID, and desktop-call capture depends
on it.

A normal desktop installer cannot silently install a Chrome extension, so the
extension is always installed from the store or loaded manually.

## First-run setup

Installing the extension opens the setup screen in a new tab. If you closed it,
click the toolbar icon to reopen it. Everything happens on one screen.

### Choose how AI runs

Pick one:

- **Use my own API keys (free).** Enter two keys, one for each job. A single
  key is not enough because transcription and summarization are separate
  provider calls. Click **Test keys** and continue once both checks pass.
  Keys are stored only in the browser's `chrome.storage.local`. They are never
  synced and never sent to the optional webapp or the hosted service.
- **Hosted (paid).** Sign in to the hosted service. It uses its own provider
  credentials, so no keys go into the extension. Plan, usage, and billing are
  under Settings, in **Manage hosted billing**.

The provider roles for your own keys:

| Role | Supported providers | What it does |
| --- | --- | --- |
| Transcription | Deepgram or Groq | Turns microphone and meeting audio into text |
| Summarization | Claude, Gemini, or DeepSeek | Turns the transcript into a summary and action items |

The **Default** tier uses Deepgram and Claude. The **Budget** tier uses Groq
plus Gemini or DeepSeek. Google Meet recordings are transcribed after you
stop, with either tier. Desktop calls can show live transcription through
the helper; Groq uses batch transcription with less immediate updates. You
can switch tiers and edit keys later under **Settings, AI provider**.

### Allow the microphone

Chrome asks once for microphone access. Allow it. Your microphone and the
meeting's audio are kept as two separate channels, which is what lets the notes
tell you apart from everyone else.

### Confirm consent

Read the one-line disclosure and tick the box only when you understand your
local consent obligations. Recording is blocked until you do. This is general
information, not legal advice.

### Finish

Click **Finish**, then **Open Google Meet**.

## Record your first Google Meet call

1. Join a call. A small **Notetaker** pill also appears in a corner of the call
   page; drag it anywhere, or turn it off in Settings if you prefer the toolbar.
2. Start notes with **Alt+Shift+R** or the toolbar icon. You can also use the
   pill's **Start notes** button. Optionally choose a **Notes style** first
   (General, Standup, Sales call, 1:1, Interview, or your own).
3. The first time, Chrome needs the extension to be invoked once on the Meet
   tab before it may capture that tab's audio. Pressing **Alt+Shift+R** or
   clicking the toolbar icon counts as that invocation, and the approval lasts
   for the tab, so later starts on it are one press.
4. While notes run, the pill shows a red recording indicator and elapsed time.
   The transcript and summary are written after you stop. Press
   **Alt+Shift+B** to flag a moment. Flagged
   moments appear in the finished notes and jump to the matching place in the
   transcript. The meeting's audio keeps playing normally.
5. To finish, press **Alt+Shift+R** again, or use **Stop notes**, or just hang
   up. Ending the call finalizes the notes too.
6. A **Notes ready** notification appears when processing is done. Click it to
   open the notes page.

Chrome assigns the suggested shortcuts only when they are free. Check or change
them at `chrome://extensions/shortcuts`; Settings shows what is currently set.

If your provider is temporarily unavailable, the audio stays saved in the
browser and is retried. If Chrome or the browser closes mid-call, reopen the
extension and choose **Resume** or **Discard** on the recovery banner.

On the notes page you get the summary, action items (with due dates and
completion state), and the full speaker-labeled transcript. You can find every
meeting later under **Recent meetings**.

## Desktop calls (Zoom, Teams, Slack)

Use this section only for calls that do not run in a Chrome tab. It requires
the desktop helper.

### 1. Install the helper

> The package-manager commands below work **when released**. Until a release
> is published, use [Build from source](#build-from-source).

Open the [install page](https://apercallc.github.io/ai-notetaker/) to see the
channels that exist in the current published release for your OS.

**macOS** (when released):

```sh
brew install --cask ai-notetaker
brew upgrade --cask ai-notetaker
```

Homebrew Cask installs the same signed DMG used by the release page and runs
the Native Messaging registration hook. On first desktop capture, macOS asks
for Microphone and Screen Recording permission. Grant both in System Settings;
the native ScreenCaptureKit path does not require BlackHole. If Screen
Recording permission cannot be granted, AI Notetaker links to the official
BlackHole installer; it never bundles BlackHole.

**Windows** (when released):

```powershell
winget install AI.Notetaker
winget upgrade AI.Notetaker

# Chocolatey alternative
choco install ai-notetaker
choco upgrade ai-notetaker
```

The installer registers Native Messaging for Chrome, Edge, and Brave. Base
VB-CABLE, if a release includes it, is launched visibly with VB-Audio
attribution and may require administrator approval or a reboot.

**Linux** (when released): download the `.deb` matching your architecture from
the release page, then:

```sh
sudo apt install ./AI-Notetaker_<version>_amd64.deb
```

Run `sudo apt install` again with the newer `.deb` to update. Use the AppImage
only when a Debian package is not suitable; it needs an explicit stable-path
Native Messaging registration and is not the recommended first install.

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

Use the same channel used to install it. Do not mix a package-manager install
with a direct-download updater:

| Install method | Update command |
| --- | --- |
| Homebrew Cask | `brew upgrade --cask ai-notetaker` |
| WinGet | `winget upgrade AI.Notetaker` |
| Chocolatey | `choco upgrade ai-notetaker` |
| Linux `.deb` | `sudo apt install ./AI-Notetaker_<new-version>_amd64.deb` |
| Release DMG/MSI/NSIS | Download and run the newer installer |
| Docker image (webapp only) | `docker compose -f webapp/docker-compose.registry.yml pull && docker compose -f webapp/docker-compose.registry.yml up -d` |

The Tauri automatic updater is disabled until the release owner supplies and
protects the updater key and endpoint, so package-manager upgrades and newer
installers are the update path.

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

## Optional: connect your own history webapp

Local history is the default and requires no server. For cross-device history:

1. Deploy the webapp by following [`webapp/README.md`](../webapp/README.md).
2. Open the extension's Settings page.
3. Enter the deployed HTTPS URL and its access token.
4. Click **Test connection**, then **Save settings**.

The webapp is self-hosted by you. It stores finished notes and action items; it
does not call Deepgram, Claude, Groq, Gemini, or DeepSeek and never needs those
keys.

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
the native helper. If the registry image is not published yet, use the local
build Compose flow in [`webapp/README.md`](../webapp/README.md#deploy-with-docker-compose).

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

This section is for contributors, private deployments, and release owners, and
it is the way to run AI Notetaker until a public release is published.

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
extension (see [Install the extension](#install-the-extension)). That is all a
Google Meet user needs.

### 3. Build and install the helper (desktop calls only)

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
