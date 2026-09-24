import { getSettings } from "../lib/storage";
import { testProviderKey as testApiKey } from "../lib/testProviderKey";
import { DEFAULT_SETTINGS, type AudioProbeResult, type AudioStatus, type NotetakerSettings, type ProviderKind } from "../types";
import { escapeHtml } from "../lib/html";
import { detectInstallPlatform, getInstallPageUrl, type InstallPlatform } from "../lib/install";
import type { BackgroundState, BackgroundToUiMessage } from "../lib/internalMessages";
import { loginManaged, managedSignupUrl } from "../lib/managedClient";

const app = document.getElementById("app")!;
const TOTAL_STEPS = 4;
let step = 1;
let settings: NotetakerSettings = DEFAULT_SETTINGS;
let consentAcknowledged = false;
let audioStatus: AudioStatus | null = null;
let audioProbe: AudioProbeResult | null = null;
let providerTestsPassed = false;
let onboardingMode: "local_byok" | "managed" = "local_byok";
type MeetingApp = "slack" | "teams" | "zoom" | "google-meet" | "other";
const DESKTOP_ONBOARDING_INTENT_KEY = "notetaker.desktopOnboardingIntentAt";
const DESKTOP_ONBOARDING_INTENT_TTL_MS = 30_000;
// Google Meet is the product's primary first-run experience. Do not honor a
// stale `?mode=desktop` URL from an older extension build: desktop-call users
// can select their app in step 1, and old tabs/bookmarks must not reopen the
// helper installer unexpectedly.
async function launchMeetingApp(): Promise<MeetingApp> {
  const params = new URLSearchParams(window.location.search);
  // Only the popup's deliberate "Set up desktop capture" action opts into
  // helper-first setup. A copied or restored `?mode=desktop&source=desktop`
  // URL is not enough: it must be paired with a short-lived session marker
  // created by the explicit desktop button. This prevents old tabs and
  // bookmarks from reopening the helper installer unexpectedly.
  if (params.get("mode") !== "desktop" || params.get("source") !== "desktop") return "google-meet";
  const session = chrome.storage.session;
  if (!session?.get) return "google-meet";
  try {
    const items = await new Promise<Record<string, unknown>>((resolve) => session.get<Record<string, unknown>>(DESKTOP_ONBOARDING_INTENT_KEY, resolve));
    const intentAt = items[DESKTOP_ONBOARDING_INTENT_KEY];
    await new Promise<void>((resolve) => session.remove(DESKTOP_ONBOARDING_INTENT_KEY, () => resolve()));
    return typeof intentAt === "number" && Number.isFinite(intentAt) && Date.now() - intentAt <= DESKTOP_ONBOARDING_INTENT_TTL_MS ? "other" : "google-meet";
  } catch {
    return "google-meet";
  }
}

let meetingApp: MeetingApp = "google-meet";
type OnboardingTier = "default" | "budget";
let onboardingTier: OnboardingTier = "default";
let onboardingSummarizer: "gemini" | "deepseek" = "gemini";

function detectPlatform(): InstallPlatform {
  return detectInstallPlatform();
}

function platformLabel(platform: InstallPlatform): string {
  return platform === "macos" ? "macOS" : platform === "windows" ? "Windows" : platform === "linux" ? "Linux" : "your OS";
}

function renderStepIndicator(): string {
  let dots = "";
  for (let i = 1; i <= TOTAL_STEPS; i++) {
    const state = i === step ? "current" : i < step ? "complete" : "upcoming";
    dots += `<li class="dot ${state}" ${i === step ? 'aria-current="step"' : ""}><span class="sr-only">Step ${i} of ${TOTAL_STEPS}${i === step ? ", current" : i < step ? ", complete" : ""}</span></li>`;
  }
  return `<ol class="step-indicator" aria-label="Setup progress">${dots}</ol>`;
}

function renderStep1(): string {
  const platform = detectPlatform();
  const downloadLabel =
    platform === "macos" ? "Install on macOS" : platform === "windows" ? "Install on Windows" : platform === "linux" ? "Install on Linux" : "Choose your OS";
  const meetSelected = meetingApp === "google-meet";
  return `
    <h1 tabindex="-1" data-view-heading>1. Choose where you'll record</h1>
    <p>Start with a Google Meet tab in Chrome, or set up desktop audio for Zoom, Teams, Slack, and other call apps.</p>
    <div class="field">
      <label for="meeting-app"><strong>What will you record first?</strong></label>
      <select id="meeting-app" autocomplete="off">
        <option value="google-meet" ${meetSelected ? "selected" : ""}>Google Meet in Chrome — browser capture</option>
        <option value="other" ${meetingApp === "other" ? "selected" : ""}>Another meeting app</option>
        <option value="slack" ${meetingApp === "slack" ? "selected" : ""}>Slack huddles</option>
        <option value="teams" ${meetingApp === "teams" ? "selected" : ""}>Microsoft Teams</option>
        <option value="zoom" ${meetingApp === "zoom" ? "selected" : ""}>Zoom</option>
      </select>
    </div>
    ${meetSelected
      ? `<div class="callout">
          <strong>Google Meet uses the browser path.</strong>
          <p>Keep Meet's normal microphone and speaker selected. When you start from a Meet tab, Chrome will ask once for microphone and tab-audio permission.</p>
          <p class="text-secondary">Meet capture is owned by this extension. Your mic and tab audio are saved locally first, then processed with your BYOK keys or Hosted AI. The desktop helper is only needed for Zoom, Teams, Slack, and other desktop-call apps.</p>
        </div>`
      : `<p>The desktop helper captures your microphone and meeting audio locally, survives the popup closing, and completes processing after you stop.</p>
        <button class="primary" id="download-helper">${downloadLabel}</button>
        <button type="button" class="secondary" id="check-helper">Check desktop helper</button>
        <p id="helper-install-status" class="text-secondary" role="status">${helperStatusCopy()}</p>
        <div class="callout warning">
          <strong>Heads up:</strong> after installing, you may need to reboot or
          log out and back in before the device shows up in your meeting app's
          audio settings. This is normal — it's how audio devices work on
          ${platformLabel(platform)}, not a sign that
          something went wrong.
        </div>`}
  `;
}

let helperStatus: BackgroundState["helperStatus"] = "connecting";
let helperInfo: BackgroundState["helperInfo"] = null;
function helperStatusCopy(): string {
  if (helperStatus === "connected") {
    return `Desktop helper ${helperInfo?.helperVersion ? `v${helperInfo.helperVersion} ` : ""}is connected. Continue to audio setup.`;
  }
  if (helperStatus === "incompatible") {
    return `This helper (v${helperInfo?.helperVersion ?? "unknown"}) is incompatible. Install the current version.`;
  }
  if (helperStatus === "helper_not_found") return "Desktop helper not detected yet. Install it, launch it, then check again.";
  if (helperStatus === "disconnected") return "Desktop helper is not responding. Launch it, then check again.";
  return "Checking for the desktop helper…";
}

function renderStep2(): string {
  if (meetingApp === "google-meet") {
    return `
      <h1 tabindex="-1" data-view-heading>2. Get Google Meet ready</h1>
      <p>There is no virtual audio routing to configure for browser capture. Leave Google Meet on its normal microphone and speaker.</p>
      <div class="callout audio-routing">
        <h2>In your Meet tab</h2>
        <ol>
          <li>Open or join the Google Meet call in Chrome.</li>
          <li>Click the AI Notetaker extension from the Chrome toolbar while that Meet tab is active.</li>
          <li>Choose <strong>Google Meet — capture this tab</strong>, then start taking notes.</li>
        </ol>
        <p class="text-secondary">Chrome may show a one-time microphone or tab-audio permission prompt. Keep the tab audio connected so you can continue hearing the call normally.</p>
      </div>
      <div class="callout">
        <strong>Privacy and consent</strong>
        <p>Only the active Meet tab's audio and your microphone are captured. Tell participants about recording and follow the law where everyone is located.</p>
      </div>
    `;
  }
  return `
    <h1 tabindex="-1" data-view-heading>2. Check your audio</h1>
    <p>
      Set the devices in the meeting app you will use, then run the checks
      below. Helper capture uses both channels; Google Meet can instead use
      the popup's browser-capture mode with Meet's normal audio devices.
    </p>
    <div class="callout audio-routing">
      <h2>Use this normal setup</h2>
      <p>Change the devices in the meeting app, not globally, so music, videos, and other calls keep working normally.</p>
      <div class="audio-route-grid">
        <section>
          <h3>Input / Microphone</h3>
          <p>Choose your normal physical microphone. The helper captures the system's default microphone.</p>
        </section>
        <section>
          <h3>Output / Speaker</h3>
          <p>Keep your normal speaker selected when the audio check reports native loopback. If it reports a virtual-device fallback, choose the output shown in the OS card below; the helper will keep the call audible when that fallback is configured correctly.</p>
        </section>
      </div>
      <p class="text-secondary setup-note">Keep your operating system's normal input and output devices unchanged unless your meeting app cannot choose devices separately.</p>
    </div>
    <div class="device-guide" aria-label="Audio device setup by operating system">
      <section class="platform-card">
        <h2>macOS</h2>
        <p><strong>Native path (macOS 13+):</strong> keep your physical microphone and normal speakers or headphones selected, then grant AI Notetaker Screen Recording permission when macOS prompts. <strong>Fallback:</strong> if the helper reports BlackHole, create a Multi-Output Device containing BlackHole and your normal speakers or headphones, and choose it as the meeting speaker. Do not choose BlackHole alone or you will not hear the meeting.</p>
      </section>
      <section class="platform-card">
        <h2>Windows</h2>
        <p><strong>Native path:</strong> keep your physical microphone and normal speaker/headphone selected; the helper captures the default output through WASAPI loopback. <strong>Fallback:</strong> choose CABLE Input as the meeting speaker and enable <strong>Listen to this device</strong> for CABLE Output in Windows Sound settings.</p>
      </section>
      <section class="platform-card">
        <h2>Linux</h2>
        <p><strong>Meeting app microphone:</strong> your physical/default microphone. <strong>Meeting app speaker:</strong> <strong>AI Notetaker</strong>. Keep your normal headphones or speakers as the system output. Do not choose <code>notetaker_mic</code> as the meeting microphone.</p>
      </section>
      <section class="meeting-app-card">
        <label for="meeting-app"><strong>Which meeting app are you setting up?</strong></label>
        <select id="meeting-app">
          <option value="other" ${meetingApp === "other" ? "selected" : ""}>Another meeting app</option>
          <option value="slack" ${meetingApp === "slack" ? "selected" : ""}>Slack huddles</option>
          <option value="teams" ${meetingApp === "teams" ? "selected" : ""}>Microsoft Teams</option>
          <option value="zoom" ${meetingApp === "zoom" ? "selected" : ""}>Zoom</option>
        </select>
        <div id="meeting-app-directions" class="meeting-app-directions">${renderMeetingAppDirections()}</div>
      </section>
      <p class="text-secondary setup-note">Device names vary by OS and meeting app. See the helper packaging guide for troubleshooting and uninstall steps.</p>
      <a class="setup-link" href="https://github.com/apercallc/ai-notetaker/blob/main/docs/helper-packaging.md" target="_blank" rel="noreferrer">Open the full setup and uninstall guide</a>
    </div>
    <div class="audio-preflight" aria-live="polite">
      <p id="audio-preflight-result" class="${audioStatus?.ready ? "valid" : "text-secondary"}">${renderAudioStatusCopy()}</p>
      <div class="audio-preflight-actions">
        <button type="button" class="secondary" id="check-audio-setup">${audioStatus?.ready ? "Refresh device check" : "Check devices"}</button>
        <button type="button" class="secondary" id="probe-audio-setup" ${audioStatus?.ready ? "" : "disabled"}>Run 2-second test</button>
      </div>
    </div>
  `;
}

function renderMeetingAppDirections(): string {
  switch (meetingApp) {
    case "slack":
      return `<h3>Slack huddles</h3><ol><li>Click your profile picture, then <strong>Preferences → Audio & video</strong>.</li><li>Set <strong>Microphone</strong> to your physical microphone.</li><li>Keep your normal speaker selected when the audio check reports native loopback; otherwise choose the fallback output named in the OS card above.</li></ol><p>While in a huddle, use the three-dots menu and <strong>Select a speaker</strong> if Slack switches back to another output.</p><a class="setup-link" href="https://slack.com/help/articles/1500002037922-Adjust-your-huddles-preferences" target="_blank" rel="noreferrer">Slack's audio and video settings guide</a>`;
    case "teams":
      return `<h3>Microsoft Teams</h3><ol><li>Open <strong>Settings and more (…) → Settings → Devices</strong>.</li><li>Under <strong>Audio settings</strong>, set <strong>Microphone</strong> to your physical microphone.</li><li>Keep your normal speaker selected when the audio check reports native loopback; otherwise choose the fallback output named in the OS card above.</li></ol><p>For a meeting already in progress, open <strong>More (…) → Settings → Device settings</strong> and choose the same devices.</p><a class="setup-link" href="https://support.microsoft.com/en-US/Teams/calls-devices/manage-your-call-settings-in-microsoft-teams" target="_blank" rel="noreferrer">Microsoft's Teams device settings guide</a>`;
    case "zoom":
      return `<h3>Zoom</h3><ol><li>Open <strong>Settings → Audio</strong> before joining, or use the arrow beside the microphone in a meeting.</li><li>Set <strong>Microphone</strong> to your physical microphone.</li><li>Keep your normal speaker selected when the audio check reports native loopback; otherwise choose the fallback output named in the OS card above.</li></ol>`;
    case "google-meet":
      return `<h3>Google Meet — easiest path</h3><ol><li>Leave Meet's normal microphone and speaker selected.</li><li>Join your call. A small <strong>Notetaker</strong> pill appears in the corner of the page; drag it wherever you like.</li><li>Open it and choose <strong>Start taking notes</strong>. The first time, Chrome asks you to allow the microphone once, and to click the <strong>Notetaker icon in the toolbar</strong> once on the Meet tab so it may capture that tab's audio. The pill tells you when either is needed.</li></ol><p>You do not need to route Meet through the virtual output for browser capture. Use the helper device instructions above when recording Zoom, Teams, or Slack Huddles.</p>`;
    default:
      return `<h3>In your meeting app</h3><p>Open its audio or device settings. Set <strong>Microphone/Input</strong> to your physical microphone and keep your normal speaker selected when the audio check reports native loopback. If it reports a fallback, use the virtual output named in the OS card above.</p>`;
  }
}

function renderAudioStatusCopy(): string {
  if (!audioStatus) return "Check the devices after selecting them in your meeting app.";
  const microphone = audioStatus.microphone === "default" ? "your default physical microphone" : audioStatus.microphone ?? "microphone missing";
  const speaker = audioStatus.speaker === "notetaker_sink.monitor" ? "AI Notetaker virtual output" : audioStatus.speaker ?? "meeting audio missing";
  const devices = `Input: ${microphone} · Meeting output: ${speaker}`;
  const capturePath = audioStatus.nativeLoopback ? "Native system-audio capture." : audioStatus.virtualDeviceFallback ? "Virtual-device fallback active." : "System-audio capture unavailable.";
  const probe = audioProbe ? ` ${audioProbe.message}` : "";
  const readiness = !audioStatus.driverInstalled
    ? "Audio driver missing."
    : audioStatus.ready
      ? "Devices ready."
      : "Audio routing incomplete.";
  return `${readiness} ${devices} ${capturePath} ${audioStatus.guidance}${probe}`;
}

function renderStep3(): string {
  if (onboardingMode === "managed") {
    const managed = settings.processingMode.kind === "managed" && settings.managedService;
    return `
      <h1 tabindex="-1" data-view-heading>3. Choose hosted AI</h1>
      <p>
        Hosted AI keeps the free extension and helper workflow, but uses your
        authenticated workspace's managed transcription and summarization
        service. Provider keys never enter the extension.
      </p>
      ${managed
        ? `<div class="callout"><strong>Hosted AI is connected.</strong><p class="text-secondary">Workspace ${escapeHtml(managed.workspaceId)} · plan ${escapeHtml(managed.plan)}</p></div><p class="text-secondary">Your recording is still saved locally first before it is uploaded for processing.</p>`
        : `<div class="field"><label for="onboarding-managed-url">Hosted service URL</label><input type="url" id="onboarding-managed-url" placeholder="https://notes.example.com" autocomplete="url" /></div>
          <div class="field"><label for="onboarding-managed-email">Account email</label><input type="email" id="onboarding-managed-email" autocomplete="username" /></div>
          <div class="field"><label for="onboarding-managed-password">Account password</label><input type="password" id="onboarding-managed-password" autocomplete="current-password" /></div>
          <button type="button" class="secondary" id="onboarding-managed-sign-in">Sign in to hosted AI</button>
          <button type="button" class="secondary" id="onboarding-managed-signup" disabled>Create hosted account</button>
          <p class="field-hint text-secondary">Enter the service URL, then create an account if you do not have a hosted workspace yet.</p>
          <p class="test-result" id="onboarding-managed-result" role="status" aria-live="polite"></p>`}
      <p class="field-hint text-secondary">Prefer no account? Choose <strong>Free local BYOK</strong> and add your own provider keys instead.</p>
      <div class="tier-toggle" role="group" aria-label="Processing mode">
        <button type="button" class="secondary" id="onboarding-mode-local">Free local BYOK</button>
        <button type="button" class="primary active" id="onboarding-mode-managed">Hosted AI</button>
      </div>
    `;
  }
  const budget = onboardingTier === "budget";
  const summarizer = onboardingSummarizer === "deepseek" ? "DeepSeek" : "Gemini";
  return `
    <h1 tabindex="-1" data-view-heading>3. Choose your AI mode</h1>
    <p>
      Use the free local path with your own provider keys, or sign in to
      Hosted AI so the service handles provider credentials and usage for you.
    </p>
    <div class="tier-toggle" role="group" aria-label="Processing mode">
      <button type="button" class="primary active" id="onboarding-mode-local">Free local BYOK</button>
      <button type="button" class="secondary" id="onboarding-mode-managed">Hosted AI</button>
    </div>
    <p class="field-hint"><strong>Local BYOK setup:</strong> AI Notetaker needs exactly <strong>two keys</strong>: one service turns
      audio into a transcript, and a second service turns that transcript into
      a summary and action items. No single key does both jobs.
    </p>
    <div class="tier-toggle" role="group" aria-label="Provider tier">
      <button type="button" id="onboarding-tier-default" class="${!budget ? "primary active" : "secondary"}" aria-pressed="${!budget}">Default: Deepgram + Claude</button>
      <button type="button" id="onboarding-tier-budget" class="${budget ? "primary active" : "secondary"}" aria-pressed="${budget}">Budget: Groq + Gemini/DeepSeek</button>
    </div>
    <div class="callout provider-plan">
      <h2>${budget ? "Budget setup" : "Recommended setup"}</h2>
      <p><strong>${budget ? "Groq" : "Deepgram"}</strong> for transcription + <strong>${budget ? summarizer : "Claude"}</strong> for summarization.</p>
      <p class="text-secondary">${budget ? "Lower cost, but transcription is batch-based so live partials are less immediate." : "Best-quality default with live transcript updates before the summary is created."}</p>
    </div>
    ${budget ? renderOnboardingKeyField("groq", "Groq", "transcription", "Batch transcription; live partials are less immediate.", "https://console.groq.com/keys") : renderOnboardingKeyField("deepgram", "Deepgram", "transcription", "Live transcript updates while you record.", "https://console.deepgram.com/")}
    ${budget ? `
      <div class="field">
        <label for="onboarding-summarizer"><strong>Key 2 of 2:</strong> Summarization provider</label>
        <select id="onboarding-summarizer">
          <option value="gemini" ${onboardingSummarizer === "gemini" ? "selected" : ""}>Gemini</option>
          <option value="deepseek" ${onboardingSummarizer === "deepseek" ? "selected" : ""}>DeepSeek</option>
        </select>
      </div>
      ${renderOnboardingKeyField(onboardingSummarizer, summarizer, "summarization", "Creates the summary and action items after you stop.", onboardingSummarizer === "deepseek" ? "https://platform.deepseek.com/api_keys" : "https://aistudio.google.com/app/apikey")}
    ` : renderOnboardingKeyField("claude", "Claude", "summarization", "Creates the summary and action items after you stop.", "https://console.anthropic.com/settings/keys")}
    <button type="button" class="secondary" id="test-onboarding-keys">Test keys</button>
    <p class="test-result" id="onboarding-key-result"></p>
    <p class="text-secondary">Enter both keys for the selected tier, then click <strong>Test keys</strong>. They stay in this browser's local extension storage. Meet sends audio directly to the selected providers; desktop calls send it through the native helper.</p>
  `;
}

function renderOnboardingKeyField(provider: ProviderKind, name: string, role: string, detail: string, keyUrl: string): string {
  return `
    <div class="field">
      <label for="onboarding-${provider}-key"><strong>${role === "transcription" ? "Key 1 of 2:" : "Key 2 of 2:"}</strong> ${name} API key <span class="text-secondary">(${role})</span></label>
      <input type="password" id="onboarding-${provider}-key" data-onboarding-provider="${provider}" autocomplete="off" spellcheck="false" required value="${escapeHtml(settings.apiKeys[provider] ?? "")}" />
      <p class="field-hint text-secondary">${detail} <a href="${keyUrl}" target="_blank" rel="noreferrer">Get a ${name} key</a></p>
    </div>
  `;
}

function onboardingProviders(): { transcription: ProviderKind; summarization: ProviderKind } {
  return onboardingTier === "budget"
    ? { transcription: "groq", summarization: onboardingSummarizer }
    : { transcription: "deepgram", summarization: "claude" };
}

function readOnboardingProviderFields(): { transcription: ProviderKind; summarization: ProviderKind; transcriptionKey: string; summarizationKey: string } {
  const providers = onboardingProviders();
  const transcriptionKey = (document.getElementById(`onboarding-${providers.transcription}-key`) as HTMLInputElement | null)?.value ?? "";
  const summarizationKey = (document.getElementById(`onboarding-${providers.summarization}-key`) as HTMLInputElement | null)?.value ?? "";
  settings.transcriptionProvider = providers.transcription as NotetakerSettings["transcriptionProvider"];
  settings.summarizationProvider = providers.summarization as NotetakerSettings["summarizationProvider"];
  settings.apiKeys[providers.transcription] = transcriptionKey;
  settings.apiKeys[providers.summarization] = summarizationKey;
  return { ...providers, transcriptionKey, summarizationKey };
}

function renderStep4(): string {
  return `
    <h1 tabindex="-1" data-view-heading>4. You're set up</h1>
    <p>
      Meetings are saved locally on this device by default — no account
      needed. If you'd like persistent history across devices, you can
      deploy your own free history webapp later from Settings.
    </p>
    <div class="callout">
      <label class="checkbox-row">
        <input type="checkbox" id="consent-ack" ${consentAcknowledged ? "checked" : ""} />
        <span>
          I understand that some places require every participant's consent
          before a conversation is recorded ("two-party consent"), while
          others only require mine ("one-party consent") — the rule depends
          on where I and the other participants are located, not on this
          app. This notice is general information, not legal advice, and
          it's my responsibility to check and follow the law that applies
          to my recording.
        </span>
      </label>
    </div>
  `;
}

function renderStep(): string {
  switch (step) {
    case 1:
      return renderStep1();
    case 2:
      return renderStep2();
    case 3:
      return renderStep3();
    case 4:
      return renderStep4();
    default:
      return "";
  }
}

function canAdvance(): boolean {
  if (step === 1) return meetingApp === "google-meet" || helperStatus === "connected";
  if (step === 2) return meetingApp === "google-meet" || (!!audioStatus?.ready && !!audioProbe?.passed);
  if (step === 3) {
    if (onboardingMode === "managed") return settings.processingMode.kind === "managed" && !!settings.managedService?.accessToken;
    if (meetingApp === "google-meet") {
      const providers = readOnboardingProviderFields();
      return providers.transcriptionKey.trim().length > 0 && providers.summarizationKey.trim().length > 0;
    }
    return providerTestsPassed;
  }
  if (step === 4) return !!(document.getElementById("consent-ack") as HTMLInputElement)?.checked;
  return true;
}

function render(): void {
  app.innerHTML = `
    ${renderStepIndicator()}
    <div class="step-content">${renderStep()}</div>
    <div class="step-nav">
      <button type="button" class="secondary" id="back-button" ${step === 1 ? "disabled" : ""}>Back</button>
      <button type="button" class="primary" id="next-button">${step === TOTAL_STEPS ? "Finish" : "Continue"}</button>
    </div>
    <p id="step-error" class="test-result invalid" role="alert"></p>
  `;
  wireEvents();
  // Each render replaces the entire step. Move focus to the new step's
  // heading instead of leaving keyboard users at document.body — this
  // wizard is mandatory, so every Back/Continue click matters.
  app.querySelector<HTMLElement>("[data-view-heading]")?.focus({ preventScroll: true });
}

function wireEvents(): void {
  document.getElementById("back-button")?.addEventListener("click", () => {
    if (step > 1) step -= 1;
    render();
  });

  document.getElementById("next-button")?.addEventListener("click", async () => {
    const nextButton = document.getElementById("next-button") as HTMLButtonElement;
    if (nextButton.disabled) return;
    if (step === 3 && onboardingMode === "local_byok") readOnboardingProviderFields();
    if (step === 4) {
      consentAcknowledged = (document.getElementById("consent-ack") as HTMLInputElement).checked;
    }
    if (!canAdvance()) {
      const error = document.getElementById("step-error");
      if (error) {
        error.textContent = step === 1
          ? meetingApp === "google-meet"
            ? "Choose Continue to move on to Google Meet browser capture setup."
            : helperStatus === "helper_not_found"
              ? "The helper is not registered with this browser. Install the desktop package, launch it, then click Check desktop helper."
              : helperStatus === "incompatible"
                ? "This helper version is incompatible with the extension. Install the current desktop package."
                : "The helper is not connected yet. Launch AI Notetaker, wait a moment, then click Check desktop helper."
          : step === 2
            ? "Check both devices and complete the 2-second audio test before continuing."
            : step === 3
              ? onboardingMode === "managed" ? "Sign in to Hosted AI before continuing." : meetingApp === "google-meet" ? "Enter both provider keys before continuing." : "Test both provider keys before continuing."
              : "Acknowledge the recording consent notice before finishing setup.";
      }
      return;
    }

    if (step === TOTAL_STEPS) {
      nextButton.disabled = true;
      nextButton.textContent = "Saving…";
      settings.onboardingComplete = true;
      settings.consentDisclosureAcknowledged = consentAcknowledged;
      try {
        await chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings });
        window.close();
      } catch {
        nextButton.disabled = false;
        nextButton.textContent = "Finish";
        const status = document.getElementById("step-error");
        if (status) {
          status.textContent = "Could not save setup. Check that the extension is running, then try again.";
          status.className = "test-result invalid";
        }
      }
      return;
    }
    step += 1;
    render();
  });

  document.getElementById("download-helper")?.addEventListener("click", () => {
    // This button only exists after the user deliberately chose a desktop
    // call. Keep the ordinary onboarding path Meet-first.
    chrome.tabs.create({ url: getInstallPageUrl("desktop") });
  });

  document.getElementById("check-helper")?.addEventListener("click", async () => {
    const button = document.getElementById("check-helper") as HTMLButtonElement;
    const status = document.getElementById("helper-install-status");
    button.disabled = true;
    if (status) status.textContent = "Checking for the desktop helper…";
    try {
      const state = await chrome.runtime.sendMessage({ type: "CHECK_HELPER" }) as BackgroundState;
      helperStatus = state.helperStatus;
      helperInfo = state.helperInfo;
      render();
    } catch {
      if (status) status.textContent = "Could not check the helper. Launch it, then try again.";
    } finally {
      button.disabled = false;
    }
  });

  document.getElementById("meeting-app")?.addEventListener("change", (event) => {
    meetingApp = (event.target as HTMLSelectElement).value as MeetingApp;
    render();
  });

  document.getElementById("onboarding-tier-default")?.addEventListener("click", () => {
    if (step === 3) readOnboardingProviderFields();
    onboardingTier = "default";
    providerTestsPassed = false;
    render();
  });

  document.getElementById("onboarding-tier-budget")?.addEventListener("click", () => {
    if (step === 3) readOnboardingProviderFields();
    onboardingTier = "budget";
    providerTestsPassed = false;
    render();
  });

  document.getElementById("onboarding-mode-local")?.addEventListener("click", () => {
    if (onboardingMode === "local_byok") return;
    onboardingMode = "local_byok";
    settings.processingMode = { kind: "local_byok" };
    settings.managedService = null;
    providerTestsPassed = false;
    render();
  });
  document.getElementById("onboarding-mode-managed")?.addEventListener("click", () => {
    if (onboardingMode === "managed") return;
    onboardingMode = "managed";
    providerTestsPassed = false;
    render();
    document.getElementById("onboarding-managed-url")?.focus();
  });
  document.getElementById("onboarding-managed-sign-in")?.addEventListener("click", async () => {
    const button = document.getElementById("onboarding-managed-sign-in") as HTMLButtonElement;
    const resultEl = document.getElementById("onboarding-managed-result");
    const baseUrl = (document.getElementById("onboarding-managed-url") as HTMLInputElement | null)?.value.trim() ?? "";
    const email = (document.getElementById("onboarding-managed-email") as HTMLInputElement | null)?.value.trim() ?? "";
    const password = (document.getElementById("onboarding-managed-password") as HTMLInputElement | null)?.value ?? "";
    button.disabled = true;
    if (resultEl) resultEl.textContent = "Signing in…";
    try {
      const result = await loginManaged(baseUrl, email, password);
      settings.managedService = result.config;
      settings.processingMode = { kind: "managed", accountId: result.config.accountId, workspaceId: result.config.workspaceId, plan: result.config.plan };
      await chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings });
      render();
    } catch (error) {
      if (resultEl) {
        resultEl.textContent = error instanceof Error ? error.message : "Hosted sign-in failed.";
        resultEl.className = "test-result invalid";
      }
    } finally {
      button.disabled = false;
    }
  });
  const managedUrlInput = document.getElementById("onboarding-managed-url") as HTMLInputElement | null;
  const managedSignupButton = document.getElementById("onboarding-managed-signup") as HTMLButtonElement | null;
  const updateManagedSignupState = (): void => {
    if (!managedSignupButton) return;
    try {
      managedSignupUrl(managedUrlInput?.value.trim() ?? "");
      managedSignupButton.disabled = false;
    } catch {
      managedSignupButton.disabled = true;
    }
  };
  managedUrlInput?.addEventListener("input", updateManagedSignupState);
  updateManagedSignupState();
  managedSignupButton?.addEventListener("click", () => {
    try {
      chrome.tabs.create({ url: managedSignupUrl(managedUrlInput?.value.trim() ?? "") });
    } catch (error) {
      const resultEl = document.getElementById("onboarding-managed-result");
      if (resultEl) {
        resultEl.textContent = error instanceof Error ? error.message : "Enter a valid hosted service URL first.";
        resultEl.className = "test-result invalid";
      }
    }
  });

  document.getElementById("onboarding-summarizer")?.addEventListener("change", (event) => {
    if (step === 3) readOnboardingProviderFields();
    onboardingSummarizer = (event.target as HTMLSelectElement).value as typeof onboardingSummarizer;
    providerTestsPassed = false;
    render();
  });

  document.getElementById("check-audio-setup")?.addEventListener("click", async () => {
    const button = document.getElementById("check-audio-setup") as HTMLButtonElement;
    const status = document.getElementById("audio-preflight-result");
    button.disabled = true;
    if (status) status.textContent = "Checking audio devices…";
    try {
      const result = (await chrome.runtime.sendMessage({ type: "GET_AUDIO_PREFLIGHT" })) as { status: AudioStatus };
      audioStatus = result.status;
      audioProbe = null;
      render();
    } catch {
      if (status) {
        status.textContent = "Could not check audio. Confirm the desktop helper is running, then try again.";
        status.className = "invalid";
      }
    } finally {
      button.disabled = false;
    }
  });

  document.getElementById("probe-audio-setup")?.addEventListener("click", async () => {
    const button = document.getElementById("probe-audio-setup") as HTMLButtonElement;
    const status = document.getElementById("audio-preflight-result");
    button.disabled = true;
    if (status) status.textContent = "Listening for microphone and meeting audio for 2 seconds…";
    try {
      const result = (await chrome.runtime.sendMessage({ type: "RUN_AUDIO_PROBE" })) as { result: AudioProbeResult };
      audioProbe = result.result;
      render();
    } catch {
      if (status) {
        status.textContent = "Audio test failed. Confirm the desktop helper is running, then try again.";
        status.className = "invalid";
      }
    } finally {
      button.disabled = false;
    }
  });

  document.getElementById("test-onboarding-keys")?.addEventListener("click", async () => {
    if (onboardingMode !== "local_byok") return;
    const button = document.getElementById("test-onboarding-keys") as HTMLButtonElement;
    const resultEl = document.getElementById("onboarding-key-result")!;
    const providers = readOnboardingProviderFields();
    if (!providers.transcriptionKey.trim() || !providers.summarizationKey.trim()) {
      providerTestsPassed = false;
      resultEl.textContent = "Enter both keys for the selected tier before testing.";
      resultEl.className = "test-result invalid";
      return;
    }
    if (meetingApp === "google-meet") {
      providerTestsPassed = true;
      resultEl.textContent = "Keys saved for browser Meet capture. They will be used from this extension after you finish setup.";
      resultEl.className = "test-result valid";
      return;
    }
    button.disabled = true;
    resultEl.textContent = "Checking…";
    try {
      const [transcriptionResult, summarizationResult] = await Promise.all([
        testApiKey(providers.transcription, providers.transcriptionKey),
        testApiKey(providers.summarization, providers.summarizationKey),
      ]);
      const bothValid = transcriptionResult.valid && summarizationResult.valid;
      providerTestsPassed = bothValid;
      resultEl.textContent = `Transcription: ${transcriptionResult.message} Summarization: ${summarizationResult.message}`;
      resultEl.className = `test-result ${bothValid ? "valid" : "invalid"}`;
    } catch {
      providerTestsPassed = false;
      resultEl.textContent = "The helper could not test the keys. Check that it is running and try again.";
      resultEl.className = "test-result invalid";
    } finally {
      button.disabled = false;
    }
  });

  for (const input of document.querySelectorAll<HTMLInputElement>("[data-onboarding-provider]")) {
    input.addEventListener("input", () => {
      providerTestsPassed = false;
    });
  }
}

async function init(): Promise<void> {
  settings = await getSettings();
  // Always reset the first step to Meet. Only a deliberate change in this
  // wizard can switch to a desktop-call setup.
  meetingApp = await launchMeetingApp();
  onboardingMode = settings.processingMode.kind === "managed" ? "managed" : "local_byok";
  onboardingTier = settings.transcriptionProvider === "groq" ? "budget" : "default";
  onboardingSummarizer = settings.summarizationProvider === "deepseek" ? "deepseek" : "gemini";
  const state = await chrome.runtime.sendMessage({ type: "GET_STATE" }) as BackgroundState;
  helperStatus = state.helperStatus;
  helperInfo = state.helperInfo;
  render();
}

chrome.runtime.onMessage.addListener((raw: unknown) => {
  const message = raw as Partial<BackgroundToUiMessage>;
  if (message.type !== "HELPER_STATUS" || !message.status) return;
  helperStatus = message.status;
  if (step === 1) render();
});

function renderFailure(): void {
  app.innerHTML = `
    <h1>AI Notetaker setup</h1>
    <div class="empty-state" role="alert">
      <p>Setup could not be loaded.</p>
      <button type="button" class="primary" id="retry-onboarding">Try again</button>
    </div>
  `;
  document.getElementById("retry-onboarding")?.addEventListener("click", () => void init().catch(renderFailure));
}

void init().catch(renderFailure);
