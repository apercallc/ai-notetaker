import { getSettings } from "../lib/storage";
import { testProviderKey as testApiKey } from "../lib/testProviderKey";
import { DEFAULT_SETTINGS, type NotetakerSettings } from "../types";

const app = document.getElementById("app")!;
const TOTAL_STEPS = 4;
let step = 1;
let settings: NotetakerSettings = DEFAULT_SETTINGS;
let consentAcknowledged = false;

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
    <h1>2. Select it as your mic and speaker</h1>
    <p>
      In your meeting app's audio settings (Zoom, Google Meet, Teams, Slack
      Huddles — any of them), choose <strong>"AI Notetaker"</strong> as both
      your microphone and your speaker.
    </p>
    <div class="screenshot-placeholder">
      <p><strong>macOS:</strong> open your meeting app's Preferences/Settings
      → Audio, and set both Microphone and Speaker to "AI Notetaker."</p>
      <p><strong>Windows:</strong> open your meeting app's audio settings and
      choose "AI Notetaker (VB-Cable)" for both Microphone and Speaker.</p>
      <p><strong>Linux:</strong> in your system sound settings or your
      meeting app's audio settings, select the "AI Notetaker" input and
      output device.</p>
    </div>
    <label class="checkbox-row">
      <input type="checkbox" id="device-selected" />
      I've selected it in my meeting app
    </label>
  `;
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
      <input type="password" id="onboarding-deepgram-key" value="${settings.apiKeys.deepgram ?? ""}" />
    </div>
    <div class="field">
      <label for="onboarding-claude-key">Claude API key (summarization)</label>
      <input type="password" id="onboarding-claude-key" value="${settings.apiKeys.claude ?? ""}" />
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
  if (step === 2) return !!(document.getElementById("device-selected") as HTMLInputElement)?.checked;
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
    resultEl.textContent = `${deepgramResult.message} ${claudeResult.message}`;
    resultEl.className = `test-result ${bothValid ? "valid" : "invalid"}`;
  });
}

async function init(): Promise<void> {
  settings = await getSettings();
  render();
}

void init();
