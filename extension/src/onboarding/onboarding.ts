import { getSettings } from "../lib/storage";
import { testProviderKey as testApiKey } from "../lib/testProviderKey";
import { DEFAULT_SETTINGS, type AudioProbeResult, type AudioStatus, type NotetakerSettings } from "../types";
import { escapeHtml } from "../lib/html";

const app = document.getElementById("app")!;
const TOTAL_STEPS = 4;
let step = 1;
let settings: NotetakerSettings = DEFAULT_SETTINGS;
let consentAcknowledged = false;
let audioStatus: AudioStatus | null = null;
let audioProbe: AudioProbeResult | null = null;
let providerTestsPassed = false;

function detectPlatform(): "mac" | "windows" | "linux" | "unknown" {
  const platform = navigator.userAgent.toLowerCase();
  if (platform.includes("mac")) return "mac";
  if (platform.includes("win")) return "windows";
  if (platform.includes("linux")) return "linux";
  return "unknown";
}

function renderStepIndicator(): string {
  let dots = "";
  for (let i = 1; i <= TOTAL_STEPS; i++) {
    dots += `<div class="dot ${i === step ? "active" : i < step ? "complete" : ""}"></div>`;
  }
  return `<div class="step-indicator">${dots}</div>`;
}

function renderStep1(): string {
  const platform = detectPlatform();
  const downloadLabel =
    platform === "mac" ? "Download for macOS" : platform === "windows" ? "Download for Windows" : "Download for Linux";
  return `
    <h1>1. Install the helper</h1>
    <p>
      The helper is a small background app that creates a virtual
      microphone/speaker so it can capture your meetings, whichever app
      you're using.
    </p>
    <button class="primary" id="download-helper">${downloadLabel}</button>
    <div class="callout warning">
      <strong>Heads up:</strong> after installing, you may need to reboot or
      log out and back in before the device shows up in your meeting app's
      audio settings. This is normal — it's how audio devices work on
      ${platform === "mac" ? "macOS" : platform === "windows" ? "Windows" : "Linux"}, not a sign that
      something went wrong.
    </div>
    <label class="checkbox-row">
      <input type="checkbox" id="helper-installed" />
      I've installed the helper
    </label>
  `;
}

function renderStep2(): string {
  return `
    <h1>2. Check your audio</h1>
    <p>
      First select the AI Notetaker device in your meeting app, then use the
      checks below. Recording stays disabled until both microphone and meeting
      audio are visible.
    </p>
    <div class="device-guide" aria-label="Audio device setup by operating system">
      <section class="platform-card">
        <h2>macOS</h2>
        <p>In Audio MIDI Setup, create a Multi-Output Device containing BlackHole and your headphones or speakers. Choose it as Speaker and keep your physical microphone as Microphone.</p>
      </section>
      <section class="platform-card">
        <h2>Windows</h2>
        <p>Enable “Listen to this device” for CABLE Output and choose your normal headphones as playback. Choose CABLE Input as Speaker and keep your physical microphone as Microphone in the meeting app.</p>
      </section>
      <section class="platform-card">
        <h2>Linux</h2>
        <p>Choose “AI Notetaker” (the PulseAudio/PipeWire virtual device) as Speaker and keep your physical microphone as Microphone. Keep your normal speakers as system output so loopback remains audible.</p>
      </section>
      <p class="text-secondary setup-note">Device names vary by OS and meeting app. See the helper packaging guide for troubleshooting and uninstall steps.</p>
      <a class="setup-link" href="https://github.com/ai-notetaker/ai-notetaker/blob/main/docs/helper-packaging.md" target="_blank" rel="noreferrer">Open the full setup and uninstall guide</a>
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

function renderAudioStatusCopy(): string {
  if (!audioStatus) return "Check the devices after selecting them in your meeting app.";
  const devices = `${audioStatus.microphone ?? "microphone missing"} · ${audioStatus.speaker ?? "meeting audio missing"}`;
  const probe = audioProbe ? ` ${audioProbe.message}` : "";
  return `${audioStatus.ready ? "Devices ready." : "Devices need attention."} ${devices} ${audioStatus.guidance}${probe}`;
}

function renderStep3(): string {
  return `
    <h1>3. Add your AI provider key</h1>
    <p class="text-secondary">
      AI Notetaker never bills you — this key is yours, used directly with
      the provider, at cost (a few cents per meeting with the defaults
      below). You can change providers any time in Settings.
    </p>
    <div class="field">
      <label for="onboarding-deepgram-key">Deepgram API key (transcription)</label>
      <input type="password" id="onboarding-deepgram-key" value="${escapeHtml(settings.apiKeys.deepgram ?? "")}" />
    </div>
    <div class="field">
      <label for="onboarding-claude-key">Claude API key (summarization)</label>
      <input type="password" id="onboarding-claude-key" value="${escapeHtml(settings.apiKeys.claude ?? "")}" />
    </div>
    <button type="button" class="secondary" id="test-onboarding-keys">Test keys</button>
    <p class="test-result" id="onboarding-key-result"></p>
    <p class="text-secondary">Want the near-zero-cost option instead? You can switch to the budget tier (Groq + Gemini/DeepSeek) any time in Settings.</p>
  `;
}

function renderStep4(): string {
  return `
    <h1>4. You're set up</h1>
    <p>
      Meetings are saved locally on this device by default — no account
      needed. If you'd like persistent history across devices, you can
      deploy your own free history webapp later from Settings.
    </p>
    <div class="callout">
      <label class="checkbox-row">
        <input type="checkbox" id="consent-ack" ${consentAcknowledged ? "checked" : ""} />
        <span>
          I understand that recording conversations may require the consent
          of other participants depending on my location, and it's my
          responsibility to follow the law where I record.
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
  if (step === 1) return !!(document.getElementById("helper-installed") as HTMLInputElement)?.checked;
  if (step === 2) return !!audioStatus?.ready && !!audioProbe?.passed;
  if (step === 3) return providerTestsPassed;
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
  `;
  wireEvents();
}

function wireEvents(): void {
  document.getElementById("back-button")?.addEventListener("click", () => {
    if (step > 1) step -= 1;
    render();
  });

  document.getElementById("next-button")?.addEventListener("click", async () => {
    if (step === 3) {
      settings.apiKeys.deepgram = (document.getElementById("onboarding-deepgram-key") as HTMLInputElement).value;
      settings.apiKeys.claude = (document.getElementById("onboarding-claude-key") as HTMLInputElement).value;
    }
    if (step === 4) {
      consentAcknowledged = (document.getElementById("consent-ack") as HTMLInputElement).checked;
    }
    if (!canAdvance()) return;

    if (step === TOTAL_STEPS) {
      settings.onboardingComplete = true;
      settings.consentDisclosureAcknowledged = consentAcknowledged;
      await chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings });
      window.close();
      return;
    }
    step += 1;
    render();
  });

  document.getElementById("download-helper")?.addEventListener("click", () => {
    // Points at the repo's releases page — the actual per-OS installer
    // artifacts are built by sub-project 1's helper/ package.
    chrome.tabs.create({ url: "https://github.com/ai-notetaker/ai-notetaker/releases" });
  });

  document.getElementById("check-audio-setup")?.addEventListener("click", async () => {
    const result = (await chrome.runtime.sendMessage({ type: "GET_AUDIO_PREFLIGHT" })) as { status: AudioStatus };
    audioStatus = result.status;
    audioProbe = null;
    render();
  });

  document.getElementById("probe-audio-setup")?.addEventListener("click", async () => {
    const result = (await chrome.runtime.sendMessage({ type: "RUN_AUDIO_PROBE" })) as { result: AudioProbeResult };
    audioProbe = result.result;
    render();
  });

  document.getElementById("test-onboarding-keys")?.addEventListener("click", async () => {
    const deepgramKey = (document.getElementById("onboarding-deepgram-key") as HTMLInputElement).value;
    const claudeKey = (document.getElementById("onboarding-claude-key") as HTMLInputElement).value;
    const resultEl = document.getElementById("onboarding-key-result")!;
    resultEl.textContent = "Checking…";
    const [deepgramResult, claudeResult] = await Promise.all([
      testApiKey("deepgram", deepgramKey),
      testApiKey("claude", claudeKey),
    ]);
    const bothValid = deepgramResult.valid && claudeResult.valid;
    providerTestsPassed = bothValid;
    resultEl.textContent = `${deepgramResult.message} ${claudeResult.message}`;
    resultEl.className = `test-result ${bothValid ? "valid" : "invalid"}`;
  });

  for (const id of ["onboarding-deepgram-key", "onboarding-claude-key"]) {
    document.getElementById(id)?.addEventListener("input", () => {
      providerTestsPassed = false;
    });
  }
}

async function init(): Promise<void> {
  settings = await getSettings();
  render();
}

void init();
