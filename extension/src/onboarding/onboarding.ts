import { getSettings } from "../lib/storage";
import { testProviderKey as testApiKey } from "../lib/testProviderKey";
import { DEFAULT_SETTINGS, type AudioProbeResult, type AudioStatus, type NotetakerSettings, type ProviderKind } from "../types";
import { escapeHtml } from "../lib/html";
import { detectInstallPlatform, getInstallPageUrl, type InstallPlatform } from "../lib/install";
import type { BackgroundState, BackgroundToUiMessage } from "../lib/internalMessages";
import { loginManaged, managedSignupUrl } from "../lib/managedClient";
import { readShortcuts, shortcutKeys } from "../lib/shortcuts";
import { MEET_AUTO_RECORD_GUIDANCE } from "../lib/autoRecord";
import { microphoneAlreadyAllowed, requestMicrophone, type MicOutcome } from "../meet/micPermission";

/**
 * First-run setup. The Google Meet path is one screen and a finish screen:
 *   setup  – how notes are written (own API keys or Hosted AI), the microphone,
 *            and a one-line recording notice
 *   done   – open Google Meet
 * Recording a desktop call (Zoom, Teams, Slack) is an opt-in detour that puts
 * the helper install and audio check in front of `setup`.
 */
type StepId = "helper" | "audio" | "setup" | "done";
type MeetingApp = "slack" | "teams" | "zoom" | "other";

const app = document.getElementById("app")!;
const MEET_HOME = "https://meet.google.com/";
const DESKTOP_ONBOARDING_INTENT_KEY = "notetaker.desktopOnboardingIntentAt";
const DESKTOP_ONBOARDING_INTENT_TTL_MS = 30_000;

let desktop = false;
let step: StepId = "setup";
let renderedStep: StepId | null = null;
let settings: NotetakerSettings = structuredClone(DEFAULT_SETTINGS);
let consentAcknowledged = false;
let consentOpen = false;
let audioStatus: AudioStatus | null = null;
let audioProbe: AudioProbeResult | null = null;
let providerTestsPassed = false;
let keyResult: { ok: boolean; text: string } | null = null;
let micState: MicOutcome | "unknown" | "asking" = "unknown";
let onboardingMode: "local_byok" | "managed" = "local_byok";
let meetingApp: MeetingApp = "other";
let onboardingTier: "default" | "budget" = "default";
let onboardingSummarizer: "gemini" | "deepseek" = "gemini";
let managedDraft = { url: "", email: "" };
let helperStatus: BackgroundState["helperStatus"] = "connecting";
let helperInfo: BackgroundState["helperInfo"] = null;
let toggleShortcut = "";
let busy = false;

// Google Meet is the product's primary first-run experience. Only the popup's
// deliberate "Set up desktop capture" action opts into helper-first setup, and
// it must be paired with a short-lived session marker it creates. A copied or
// restored `?mode=desktop&source=desktop` URL (an old tab, a bookmark) must not
// reopen the helper installer unexpectedly.
async function launchWantsDesktop(): Promise<boolean> {
  const params = new URLSearchParams(window.location.search);
  if (params.get("mode") !== "desktop" || params.get("source") !== "desktop") return false;
  const session = chrome.storage.session;
  if (!session?.get) return false;
  try {
    const items = await new Promise<Record<string, unknown>>((resolve) => session.get<Record<string, unknown>>(DESKTOP_ONBOARDING_INTENT_KEY, resolve));
    const intentAt = items[DESKTOP_ONBOARDING_INTENT_KEY];
    await new Promise<void>((resolve) => session.remove(DESKTOP_ONBOARDING_INTENT_KEY, () => resolve()));
    return typeof intentAt === "number" && Number.isFinite(intentAt) && Date.now() - intentAt <= DESKTOP_ONBOARDING_INTENT_TTL_MS;
  } catch {
    return false;
  }
}

function steps(): StepId[] {
  return desktop ? ["helper", "audio", "setup", "done"] : ["setup", "done"];
}

function platformLabel(platform: InstallPlatform): string {
  return platform === "macos" ? "macOS" : platform === "windows" ? "Windows" : platform === "linux" ? "Linux" : "your OS";
}

function renderStepIndicator(): string {
  const all = steps();
  const current = all.indexOf(step);
  const dots = all
    .map((_, index) => {
      const state = index === current ? "current" : index < current ? "complete" : "upcoming";
      const label = `Step ${index + 1} of ${all.length}${index === current ? ", current" : index < current ? ", complete" : ""}`;
      return `<li class="dot ${state}" ${index === current ? 'aria-current="step"' : ""}><span class="sr-only">${label}</span></li>`;
    })
    .join("");
  return `<ol class="step-indicator" aria-label="Setup progress">${dots}</ol>`;
}

// ---------- desktop detour: helper, audio ----------

function helperStatusCopy(): string {
  if (helperStatus === "connected") {
    return `Desktop helper ${helperInfo?.helperVersion ? `v${helperInfo.helperVersion} ` : ""}is connected. Continue to the audio check.`;
  }
  if (helperStatus === "incompatible") {
    return `This helper (v${helperInfo?.helperVersion ?? "unknown"}) is incompatible. Install the current version.`;
  }
  if (helperStatus === "helper_not_found") return "Desktop helper not detected yet. Install it, launch it, then check again.";
  if (helperStatus === "needs_pairing") return "The helper is paired with a different browser. Open the helper's tray menu and choose 'Pair New Browser', then check again.";
  if (helperStatus === "disconnected") return "Desktop helper is not responding. Launch it, then check again.";
  return "Checking for the desktop helper…";
}

function renderHelperStep(): string {
  const platform = detectInstallPlatform();
  const downloadLabel =
    platform === "macos" ? "Install on macOS" : platform === "windows" ? "Install on Windows" : platform === "linux" ? "Install on Linux" : "Choose your OS";
  return `
    <h1 tabindex="-1" data-view-heading>Set up desktop calls</h1>
    <p>The desktop helper captures your microphone and the meeting audio for Zoom, Teams, Slack, and other call apps. It keeps recording if this browser closes and finishes your notes after you stop.</p>
    <p><button type="button" class="primary" id="download-helper">${downloadLabel}</button>
    <button type="button" class="secondary" id="check-helper">Check desktop helper</button></p>
    <p id="helper-install-status" class="text-secondary" role="status">${helperStatusCopy()}</p>
    <div class="callout warning">
      <strong>Heads up:</strong> after installing, you may need to reboot or
      log out and back in before the device shows up in your meeting app's
      audio settings. This is normal — it's how audio devices work on
      ${platformLabel(platform)}, not a sign that something went wrong.
    </div>
    <p><button type="button" class="text-link" id="use-meet">Recording Google Meet instead?</button></p>
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

function renderAudioStep(): string {
  return `
    <h1 tabindex="-1" data-view-heading>Check your audio</h1>
    <p>Set the devices in the meeting app you will use, then run the checks below.</p>
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
      <a class="setup-link" href="https://github.com/apercallc/ai-notetaker/blob/main/docs/helper-packaging.md" target="_blank" rel="noreferrer">Open the full setup and uninstall guide</a>
    </div>
    <div class="audio-preflight" aria-live="polite">
      <p id="audio-preflight-result" class="${audioStatus?.ready ? "result ok" : "text-secondary"}">${renderAudioStatusCopy()}</p>
      <div class="audio-preflight-actions">
        <button type="button" class="secondary" id="check-audio-setup">${audioStatus?.ready ? "Refresh device check" : "Check devices"}</button>
        <button type="button" class="secondary" id="probe-audio-setup" ${audioStatus?.ready ? "" : "disabled"}>Run 2-second test</button>
      </div>
    </div>
  `;
}

// ---------- setup: AI, microphone, notice ----------

function renderModeToggle(): string {
  const managed = onboardingMode === "managed";
  return `
    <div class="tier-toggle" role="group" aria-label="How notes are written">
      <button type="button" id="onboarding-mode-local" class="${managed ? "secondary" : "primary active"}" aria-pressed="${!managed}">Use my own API keys</button>
      <button type="button" id="onboarding-mode-managed" class="${managed ? "primary active" : "secondary"}" aria-pressed="${managed}">Hosted AI</button>
    </div>`;
}

function renderManagedSection(): string {
  const managed = settings.processingMode.kind === "managed" && settings.managedService;
  if (managed) {
    return `<div class="callout"><strong>Hosted AI is connected.</strong><p class="text-secondary">Workspace ${escapeHtml(managed.workspaceId)} · plan ${escapeHtml(managed.plan)}</p></div>
      <p class="text-secondary">Your recording is still saved on this device first, then uploaded when you stop.</p>`;
  }
  return `
    <p class="text-secondary">Hosted AI writes your notes on the service, so you do not need provider keys. Your recording is saved on this device first, then uploaded when you stop.</p>
    <div class="field"><label for="onboarding-managed-url">Hosted service URL</label><input type="url" id="onboarding-managed-url" placeholder="https://notes.example.com" autocomplete="url" value="${escapeHtml(managedDraft.url)}" /></div>
    <div class="field"><label for="onboarding-managed-email">Account email</label><input type="email" id="onboarding-managed-email" autocomplete="username" value="${escapeHtml(managedDraft.email)}" /></div>
    <div class="field"><label for="onboarding-managed-password">Account password</label><input type="password" id="onboarding-managed-password" autocomplete="current-password" /></div>
    <p><button type="button" class="secondary" id="onboarding-managed-sign-in">Sign in to Hosted AI</button>
    <button type="button" class="secondary" id="onboarding-managed-signup" disabled>Create hosted account</button></p>
    <p class="result" id="onboarding-managed-result" role="status" aria-live="polite"></p>`;
}

function renderKeysSection(): string {
  const budget = onboardingTier === "budget";
  const summarizer = onboardingSummarizer === "deepseek" ? "DeepSeek" : "Gemini";
  const sends = desktop
    ? "Your keys stay in this browser's local extension storage. Desktop calls send audio to these providers through the native helper."
    : "Your keys stay in this browser's local extension storage. When you stop, Notetaker sends your saved call audio straight to these providers.";
  return `
    <p class="text-secondary">Two keys: one service turns audio into a transcript, another writes the summary and action items.</p>
    <div class="tier-toggle" role="group" aria-label="Provider tier">
      <button type="button" id="onboarding-tier-default" class="${!budget ? "primary active" : "secondary"}" aria-pressed="${!budget}">Deepgram + Claude</button>
      <button type="button" id="onboarding-tier-budget" class="${budget ? "primary active" : "secondary"}" aria-pressed="${budget}">Budget: Groq + ${summarizer}</button>
    </div>
    ${budget ? renderKeyField("groq", "Groq", "transcription", "Turns your call audio into text, at lower cost.", "https://console.groq.com/keys") : renderKeyField("deepgram", "Deepgram", "transcription", "Turns your call audio into text.", "https://console.deepgram.com/")}
    ${budget ? `
      <div class="field">
        <label for="onboarding-summarizer">Summary provider</label>
        <select id="onboarding-summarizer">
          <option value="gemini" ${onboardingSummarizer === "gemini" ? "selected" : ""}>Gemini</option>
          <option value="deepseek" ${onboardingSummarizer === "deepseek" ? "selected" : ""}>DeepSeek</option>
        </select>
      </div>
      ${renderKeyField(onboardingSummarizer, summarizer, "summarization", "Writes the summary and action items after you stop.", onboardingSummarizer === "deepseek" ? "https://platform.deepseek.com/api_keys" : "https://aistudio.google.com/app/apikey")}
    ` : renderKeyField("claude", "Claude", "summarization", "Writes the summary and action items after you stop.", "https://console.anthropic.com/settings/keys")}
    <p><button type="button" class="secondary" id="test-onboarding-keys">Test keys</button></p>
    <p class="result${keyResult ? (keyResult.ok ? " ok" : " error") : ""}" id="onboarding-key-result" role="status" aria-live="polite">${keyResult ? escapeHtml(keyResult.text) : ""}</p>
    <p class="text-secondary">${sends}</p>`;
}

function renderKeyField(provider: ProviderKind, name: string, role: string, detail: string, keyUrl: string): string {
  return `
    <div class="field">
      <label for="onboarding-${provider}-key">${name} API key <span class="text-secondary">(${role === "transcription" ? "transcript" : "summary"})</span></label>
      <input type="password" id="onboarding-${provider}-key" data-onboarding-provider="${provider}" autocomplete="off" spellcheck="false" required value="${escapeHtml(settings.apiKeys[provider] ?? "")}" />
      <p class="field-hint text-secondary">${detail} <a href="${keyUrl}" target="_blank" rel="noreferrer">Get a ${name} key</a></p>
    </div>
  `;
}

function micCopy(): { text: string; ok: boolean; error: boolean } {
  switch (micState) {
    case "granted":
      return { text: "Microphone allowed. You will not be asked again.", ok: true, error: false };
    case "asking":
      return { text: "Chrome is asking. Choose Allow.", ok: false, error: false };
    case "blocked":
      return { text: "Chrome blocked the microphone. Click the site-settings icon at the left of the address bar, set Microphone to Allow, then try again.", ok: false, error: true };
    case "no-device":
      return { text: "No microphone found. Connect or enable one, then try again.", ok: false, error: true };
    default:
      return { text: "", ok: false, error: false };
  }
}

function renderMicSection(): string {
  const mic = micCopy();
  return `
    <section class="setup-section">
      <h2>Microphone</h2>
      <p class="text-secondary">So your side of the call is heard. Chrome asks once.</p>
      <p><button type="button" class="secondary" id="allow-microphone"${micState === "granted" || micState === "asking" ? " disabled" : ""}>${micState === "granted" ? "Microphone allowed" : "Allow microphone"}</button></p>
      <p class="result${mic.ok ? " ok" : mic.error ? " error" : ""}" id="mic-status" role="status" aria-live="polite">${escapeHtml(mic.text)}</p>
    </section>`;
}

function renderSetupStep(): string {
  return `
    <h1 tabindex="-1" data-view-heading>Set up Notetaker</h1>
    <p>${desktop ? "Last step: how notes are written, and a one-line notice." : "One screen, about a minute. Notes are written when you stop the recording."}</p>
    <section class="setup-section">
      <h2>How should notes be written?</h2>
      ${renderModeToggle()}
      ${onboardingMode === "managed" ? renderManagedSection() : renderKeysSection()}
    </section>
    ${desktop ? "" : renderMicSection()}
    <section class="setup-section">
      <label class="checkbox-row">
        <input type="checkbox" id="consent-ack" ${consentAcknowledged ? "checked" : ""} />
        <span>I'll tell everyone on the call that I'm recording, and follow the recording laws where we are.</span>
      </label>
      <button type="button" class="text-link" id="consent-toggle" aria-expanded="${consentOpen}" aria-controls="consent-details">Read the full notice</button>
      <div id="consent-details" class="callout"${consentOpen ? "" : " hidden"}>
        Some places require every participant's consent before a conversation is
        recorded ("two-party consent"), while others only require yours
        ("one-party consent"). The rule depends on where you and the other
        participants are located, not on this app. This notice is general
        information, not legal advice, and it's your responsibility to check
        and follow the law that applies to your recording.
      </div>
    </section>
    ${desktop ? "" : `<p><button type="button" class="text-link" id="use-desktop">Recording Zoom, Teams, or Slack instead?</button></p>`}
  `;
}

function renderDoneStep(): string {
  const keys = toggleShortcut ? shortcutKeys(toggleShortcut).map((key) => `<kbd>${escapeHtml(key)}</kbd>`).join("") : "";
  const startLine = settings.autoRecordOnMeetJoin
    ? MEET_AUTO_RECORD_GUIDANCE
    : keys
      ? `In a call, press ${keys} or click the toolbar icon to start notes.`
      : "In a call, click the Notetaker toolbar icon to start notes.";
  const transcriptLine = settings.processingMode.kind === "local_byok" && settings.transcriptionProvider === "deepgram"
    ? "With your Deepgram key, the transcript appears live when the connection is available; otherwise it is ready after you stop."
    : "Your full transcript is ready after you stop recording.";
  return `
    <h1 tabindex="-1" data-view-heading>You're all set</h1>
    <p>${startLine}</p>
    <p class="text-secondary">${transcriptLine}</p>
    <p class="text-secondary">Tip: pin Notetaker from Chrome's puzzle-piece menu so the icon is always one click away. Your notes are written when you stop, and Chrome shows a notification when they are ready.</p>
    ${desktop ? `<p class="text-secondary">For Zoom, Teams, or Slack, click the toolbar icon during your call and choose Start notes.</p>` : ""}
    <p><button type="button" class="primary" id="open-meet">Open Google Meet</button></p>
  `;
}

function renderStep(): string {
  switch (step) {
    case "helper":
      return renderHelperStep();
    case "audio":
      return renderAudioStep();
    case "setup":
      return renderSetupStep();
    case "done":
      return renderDoneStep();
  }
}

// ---------- provider fields ----------

function onboardingProviders(): { transcription: ProviderKind; summarization: ProviderKind } {
  return onboardingTier === "budget"
    ? { transcription: "groq", summarization: onboardingSummarizer }
    : { transcription: "deepgram", summarization: "claude" };
}

/** Copies what is typed in the key fields into `settings`. A no-op when they are not on screen. */
function readOnboardingProviderFields(): { transcription: ProviderKind; summarization: ProviderKind; transcriptionKey: string; summarizationKey: string } {
  const providers = onboardingProviders();
  const transcriptionField = document.getElementById(`onboarding-${providers.transcription}-key`) as HTMLInputElement | null;
  const summarizationField = document.getElementById(`onboarding-${providers.summarization}-key`) as HTMLInputElement | null;
  const transcriptionKey = transcriptionField?.value ?? settings.apiKeys[providers.transcription] ?? "";
  const summarizationKey = summarizationField?.value ?? settings.apiKeys[providers.summarization] ?? "";
  settings.transcriptionProvider = providers.transcription as NotetakerSettings["transcriptionProvider"];
  settings.summarizationProvider = providers.summarization as NotetakerSettings["summarizationProvider"];
  settings.apiKeys[providers.transcription] = transcriptionKey;
  settings.apiKeys[providers.summarization] = summarizationKey;
  return { ...providers, transcriptionKey, summarizationKey };
}

function resetKeyTest(): void {
  providerTestsPassed = false;
  keyResult = null;
}

/**
 * Typed keys used to live only in the DOM until "Finish setup" — abandoning
 * the tab lost them. Persist debounced, straight into chrome.storage.local
 * (via the background, which also pushes them to the helper when one is
 * connected). Saving here does NOT mark onboarding complete, so returning
 * to setup resumes with the keys intact and the finish gate unchanged.
 */
let keyAutosaveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleKeyAutosave(): void {
  if (keyAutosaveTimer !== null) clearTimeout(keyAutosaveTimer);
  keyAutosaveTimer = setTimeout(() => {
    keyAutosaveTimer = null;
    readOnboardingProviderFields();
    chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings }).catch(() => undefined);
  }, 800);
}

// ---------- rendering ----------

function navButtons(): string {
  if (step === "done") return "";
  const canGoBack = step === "audio" || (step === "setup" && desktop);
  const label = step === "setup" ? "Finish setup" : "Continue";
  return `
    <div class="step-nav">
      ${canGoBack ? `<button type="button" class="secondary" id="back-button">Back</button>` : "<span></span>"}
      <button type="submit" class="primary" id="next-button">${label}</button>
    </div>
    <p id="step-error" class="result error" role="alert"></p>`;
}

/**
 * Re-renders the whole screen. A step change moves focus to the new heading; any
 * other re-render (a toggle, a status update) hands focus back to the control
 * that had it, so keyboard and screen-reader users are not thrown to the top.
 */
function render(options: { focus?: string } = {}): void {
  const active = document.activeElement as HTMLElement | null;
  const previousFocusId = active && app.contains(active) && active.id ? active.id : null;
  const stepChanged = renderedStep !== step;
  renderedStep = step;
  app.innerHTML = `
    ${renderStepIndicator()}
    <form id="onboarding-form" novalidate>
      <div class="step-content">${renderStep()}</div>
      ${navButtons()}
    </form>
  `;
  wireEvents();
  if (stepChanged && !options.focus) {
    app.querySelector<HTMLElement>("[data-view-heading]")?.focus({ preventScroll: true });
    return;
  }
  const target = options.focus ?? previousFocusId;
  if (target) document.getElementById(target)?.focus({ preventScroll: true });
}

function showStepError(message: string): void {
  const error = document.getElementById("step-error");
  if (error) error.textContent = message;
}

function goTo(next: StepId): void {
  step = next;
  render();
}

function goNext(): void {
  const all = steps();
  const next = all[all.indexOf(step) + 1];
  if (next) goTo(next);
}

// ---------- actions ----------

async function runKeyTest(): Promise<boolean> {
  const button = document.getElementById("test-onboarding-keys") as HTMLButtonElement | null;
  const resultEl = document.getElementById("onboarding-key-result");
  const providers = readOnboardingProviderFields();
  const show = (ok: boolean | null, text: string): void => {
    keyResult = ok === null ? null : { ok, text };
    if (!resultEl) return;
    resultEl.textContent = text;
    resultEl.className = `result${ok === null ? "" : ok ? " ok" : " error"}`;
  };
  if (!providers.transcriptionKey.trim() || !providers.summarizationKey.trim()) {
    providerTestsPassed = false;
    show(false, "Enter both keys before testing.");
    return false;
  }
  if (button) button.disabled = true;
  if (resultEl) {
    resultEl.textContent = "Checking with each provider…";
    resultEl.className = "result";
  }
  try {
    // Keys are checked straight from the extension for both capture paths; a
    // missing helper can no longer block this test.
    const [transcriptionResult, summarizationResult] = await Promise.all([
      testApiKey(providers.transcription, providers.transcriptionKey),
      testApiKey(providers.summarization, providers.summarizationKey),
    ]);
    const bothValid = transcriptionResult.valid && summarizationResult.valid;
    providerTestsPassed = bothValid;
    show(bothValid, `Transcript: ${transcriptionResult.message} Summary: ${summarizationResult.message}`);
    return bothValid;
  } catch {
    providerTestsPassed = false;
    show(false, "The keys could not be tested. Check your connection and try again.");
    return false;
  } finally {
    if (button) button.disabled = false;
  }
}

async function allowMicrophone(): Promise<void> {
  micState = "asking";
  updateMicUi();
  micState = await requestMicrophone();
  updateMicUi();
}

/** Updates the microphone section in place, so nothing else on the screen is disturbed. */
function updateMicUi(): void {
  const mic = micCopy();
  const status = document.getElementById("mic-status");
  const button = document.getElementById("allow-microphone") as HTMLButtonElement | null;
  if (status) {
    status.textContent = mic.text;
    status.className = `result${mic.ok ? " ok" : mic.error ? " error" : ""}`;
  }
  if (button) {
    button.disabled = micState === "granted" || micState === "asking";
    button.textContent = micState === "granted" ? "Microphone allowed" : "Allow microphone";
  }
}

async function signInManaged(): Promise<void> {
  const button = document.getElementById("onboarding-managed-sign-in") as HTMLButtonElement | null;
  const resultEl = document.getElementById("onboarding-managed-result");
  const baseUrl = (document.getElementById("onboarding-managed-url") as HTMLInputElement | null)?.value.trim() ?? "";
  const email = (document.getElementById("onboarding-managed-email") as HTMLInputElement | null)?.value.trim() ?? "";
  const password = (document.getElementById("onboarding-managed-password") as HTMLInputElement | null)?.value ?? "";
  if (button) button.disabled = true;
  if (resultEl) {
    resultEl.textContent = "Signing in…";
    resultEl.className = "result";
  }
  try {
    const result = await loginManaged(baseUrl, email, password);
    settings.managedService = result.config;
    settings.processingMode = { kind: "managed", accountId: result.config.accountId, workspaceId: result.config.workspaceId, plan: result.config.plan };
    await chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings });
    render();
  } catch (error) {
    if (resultEl) {
      resultEl.textContent = error instanceof Error ? error.message : "Hosted sign-in failed.";
      resultEl.className = "result error";
    }
  } finally {
    if (button) button.disabled = false;
  }
}

async function finishSetup(): Promise<void> {
  if (onboardingMode === "managed") {
    if (!(settings.processingMode.kind === "managed" && settings.managedService?.accessToken)) {
      showStepError("Sign in to Hosted AI, or switch to your own API keys.");
      return;
    }
  } else {
    readOnboardingProviderFields();
    // A real pass is required: the keys are checked now if they have not been yet.
    if (!providerTestsPassed && !(await runKeyTest())) {
      showStepError("Those keys did not pass. Fix them and try again.");
      return;
    }
    settings.processingMode = { kind: "local_byok" };
    settings.managedService = null;
  }
  if (!desktop && micState !== "granted") {
    showStepError("Allow the microphone so your side of the call is heard.");
    document.getElementById("allow-microphone")?.focus();
    return;
  }
  consentAcknowledged = (document.getElementById("consent-ack") as HTMLInputElement | null)?.checked ?? consentAcknowledged;
  if (!consentAcknowledged) {
    showStepError("Tick the recording notice to finish.");
    document.getElementById("consent-ack")?.focus();
    return;
  }
  settings.onboardingComplete = true;
  settings.consentDisclosureAcknowledged = true;
  try {
    await chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings });
  } catch {
    showStepError("Could not save setup. Check that the extension is running, then try again.");
    return;
  }
  toggleShortcut = (await readShortcuts()).toggle;
  goTo("done");
}

async function advance(): Promise<void> {
  if (busy) return;
  busy = true;
  const nextButton = document.getElementById("next-button") as HTMLButtonElement | null;
  if (nextButton) nextButton.disabled = true;
  showStepError("");
  try {
    switch (step) {
      case "helper":
        if (helperStatus === "connected") goNext();
        else
          showStepError(
            helperStatus === "helper_not_found"
              ? "The helper is not registered with this browser. Install the desktop package, launch it, then click Check desktop helper."
              : helperStatus === "incompatible"
                ? "This helper version is incompatible with the extension. Install the current desktop package."
                : "The helper is not connected yet. Launch AI Notetaker, wait a moment, then click Check desktop helper.",
          );
        break;
      case "audio":
        if (audioStatus?.ready && audioProbe?.passed) goNext();
        else showStepError("Check both devices and complete the 2-second audio test before continuing.");
        break;
      case "setup":
        await finishSetup();
        break;
      default:
        break;
    }
  } finally {
    busy = false;
    const button = document.getElementById("next-button") as HTMLButtonElement | null;
    if (button) button.disabled = false;
  }
}

// ---------- events ----------

function wireEvents(): void {
  const form = document.getElementById("onboarding-form") as HTMLFormElement;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void advance();
  });
  document.getElementById("back-button")?.addEventListener("click", () => {
    const all = steps();
    const previous = all[all.indexOf(step) - 1];
    if (previous) goTo(previous);
  });

  document.getElementById("use-desktop")?.addEventListener("click", () => {
    if (onboardingMode === "local_byok") readOnboardingProviderFields();
    desktop = true;
    resetKeyTest();
    goTo("helper");
  });
  document.getElementById("use-meet")?.addEventListener("click", () => {
    desktop = false;
    goTo("setup");
  });

  document.getElementById("download-helper")?.addEventListener("click", () => {
    // This button only exists after the user deliberately chose desktop calls.
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
      render({ focus: "check-helper" });
    } catch {
      if (status) status.textContent = "Could not check the helper. Launch it, then try again.";
      button.disabled = false;
    }
  });

  document.getElementById("meeting-app")?.addEventListener("change", (event) => {
    meetingApp = (event.target as HTMLSelectElement).value as MeetingApp;
    render({ focus: "meeting-app" });
  });

  const rerenderSetup = (focus: string): void => {
    if (onboardingMode === "local_byok") readOnboardingProviderFields();
    render({ focus });
  };
  document.getElementById("onboarding-tier-default")?.addEventListener("click", () => {
    readOnboardingProviderFields();
    onboardingTier = "default";
    resetKeyTest();
    rerenderSetup("onboarding-tier-default");
  });
  document.getElementById("onboarding-tier-budget")?.addEventListener("click", () => {
    readOnboardingProviderFields();
    onboardingTier = "budget";
    resetKeyTest();
    rerenderSetup("onboarding-tier-budget");
  });
  document.getElementById("onboarding-summarizer")?.addEventListener("change", (event) => {
    readOnboardingProviderFields();
    onboardingSummarizer = (event.target as HTMLSelectElement).value as typeof onboardingSummarizer;
    resetKeyTest();
    rerenderSetup("onboarding-summarizer");
  });
  document.getElementById("onboarding-mode-local")?.addEventListener("click", () => {
    if (onboardingMode === "local_byok") return;
    onboardingMode = "local_byok";
    settings.processingMode = { kind: "local_byok" };
    settings.managedService = null;
    resetKeyTest();
    render({ focus: "onboarding-mode-local" });
  });
  document.getElementById("onboarding-mode-managed")?.addEventListener("click", () => {
    if (onboardingMode === "managed") return;
    readOnboardingProviderFields();
    onboardingMode = "managed";
    resetKeyTest();
    render({ focus: "onboarding-managed-url" });
  });

  document.getElementById("onboarding-managed-sign-in")?.addEventListener("click", () => void signInManaged());
  // Pressing Enter in a sign-in field means "sign in", not "finish setup".
  for (const id of ["onboarding-managed-url", "onboarding-managed-email", "onboarding-managed-password"]) {
    document.getElementById(id)?.addEventListener("keydown", (event) => {
      if ((event as KeyboardEvent).key !== "Enter") return;
      event.preventDefault();
      void signInManaged();
    });
  }
  const managedUrlInput = document.getElementById("onboarding-managed-url") as HTMLInputElement | null;
  const managedEmailInput = document.getElementById("onboarding-managed-email") as HTMLInputElement | null;
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
  managedUrlInput?.addEventListener("input", () => {
    managedDraft.url = managedUrlInput.value;
    updateManagedSignupState();
  });
  managedEmailInput?.addEventListener("input", () => {
    managedDraft.email = managedEmailInput.value;
  });
  updateManagedSignupState();
  managedSignupButton?.addEventListener("click", () => {
    try {
      chrome.tabs.create({ url: managedSignupUrl(managedUrlInput?.value.trim() ?? "") });
    } catch (error) {
      const resultEl = document.getElementById("onboarding-managed-result");
      if (resultEl) {
        resultEl.textContent = error instanceof Error ? error.message : "Enter a valid hosted service URL first.";
        resultEl.className = "result error";
      }
    }
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
      render({ focus: "check-audio-setup" });
    } catch {
      if (status) {
        status.textContent = "Could not check audio. Confirm the desktop helper is running, then try again.";
        status.className = "result error";
      }
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
      render({ focus: "probe-audio-setup" });
    } catch {
      if (status) {
        status.textContent = "Audio test failed. Confirm the desktop helper is running, then try again.";
        status.className = "result error";
      }
      button.disabled = false;
    }
  });

  document.getElementById("test-onboarding-keys")?.addEventListener("click", () => void runKeyTest());
  for (const input of document.querySelectorAll<HTMLInputElement>("[data-onboarding-provider]")) {
    input.addEventListener("input", () => {
      providerTestsPassed = false;
      keyResult = null;
      const resultEl = document.getElementById("onboarding-key-result");
      if (resultEl) {
        resultEl.textContent = "";
        resultEl.className = "result";
      }
      scheduleKeyAutosave();
    });
  }

  document.getElementById("allow-microphone")?.addEventListener("click", () => void allowMicrophone());
  document.getElementById("consent-ack")?.addEventListener("change", (event) => {
    consentAcknowledged = (event.target as HTMLInputElement).checked;
  });
  document.getElementById("consent-toggle")?.addEventListener("click", () => {
    consentOpen = !consentOpen;
    const details = document.getElementById("consent-details");
    if (details) details.hidden = !consentOpen;
    document.getElementById("consent-toggle")?.setAttribute("aria-expanded", String(consentOpen));
  });

  document.getElementById("open-meet")?.addEventListener("click", () => {
    chrome.tabs.create({ url: MEET_HOME });
    window.close();
  });
}

async function init(): Promise<void> {
  settings = await getSettings();
  desktop = await launchWantsDesktop();
  step = desktop ? "helper" : "setup";
  renderedStep = null;
  onboardingMode = settings.processingMode.kind === "managed" ? "managed" : "local_byok";
  onboardingTier = settings.transcriptionProvider === "groq" ? "budget" : "default";
  onboardingSummarizer = settings.summarizationProvider === "deepseek" ? "deepseek" : "gemini";
  consentAcknowledged = settings.consentDisclosureAcknowledged;
  if (await microphoneAlreadyAllowed()) micState = "granted";
  const state = await chrome.runtime.sendMessage({ type: "GET_STATE" }) as BackgroundState;
  helperStatus = state.helperStatus;
  helperInfo = state.helperInfo;
  render();
}

chrome.runtime.onMessage.addListener((raw: unknown) => {
  const message = raw as Partial<BackgroundToUiMessage>;
  if (message.type !== "HELPER_STATUS" || !message.status) return;
  helperStatus = message.status;
  if (step === "helper") render();
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
