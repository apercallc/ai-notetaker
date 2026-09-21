import { getSettings } from "../lib/storage";
import { testWebappHealth } from "../lib/providerTest";
import { testProviderKey as testApiKey } from "../lib/testProviderKey";
import { DEFAULT_SETTINGS, type NotetakerSettings, type ProviderKind, type SummarizationProvider } from "../types";

const app = document.getElementById("app")!;
let settings: NotetakerSettings = DEFAULT_SETTINGS;

function isBudgetTier(s: NotetakerSettings): boolean {
  return s.transcriptionProvider === "groq";
}

function render(): void {
  const budget = isBudgetTier(settings);
  app.innerHTML = `
    <h1>Settings</h1>

    <fieldset>
      <legend>AI provider</legend>
      <p class="text-secondary field-hint">
        AI Notetaker never bills you — you bring your own API key(s) and pay
        the provider directly, at cost. See the cost table in the README for
        current per-meeting estimates.
      </p>
      <div class="tier-toggle" role="group" aria-label="Provider tier">
        <button type="button" id="tier-default" class="${!budget ? "primary active" : "secondary"}">Default (best quality)</button>
        <button type="button" id="tier-budget" class="${budget ? "primary active" : "secondary"}">Budget (lowest cost)</button>
      </div>

      ${!budget ? renderDefaultTierFields() : renderBudgetTierFields()}
    </fieldset>

    <fieldset>
      <legend>Self-hosted history webapp (optional)</legend>
      <p class="text-secondary field-hint">
        Deploy your own instance for persistent, cross-device history. Not
        required — meetings are always saved locally regardless.
      </p>
      <div class="field">
        <label for="webapp-url">Webapp URL</label>
        <input type="url" id="webapp-url" placeholder="https://your-app.up.railway.app" value="${settings.webapp?.url ?? ""}" />
      </div>
      <div class="field">
        <label for="webapp-token">Access token</label>
        <div class="key-row">
          <input type="password" id="webapp-token" value="${settings.webapp?.token ?? ""}" />
          <button type="button" class="secondary" id="test-webapp">Test connection</button>
        </div>
        <p class="test-result" id="webapp-test-result"></p>
      </div>
    </fieldset>

    <div class="save-bar">
      <button type="button" class="primary" id="save-settings">Save settings</button>
      <span class="test-result text-secondary" id="save-status"></span>
    </div>
  `;

  wireEvents();
}

function renderDefaultTierFields(): string {
  return `
    ${renderKeyField("deepgram", "Deepgram API key", "Transcription")}
    ${renderKeyField("claude", "Claude API key", "Summarization")}
  `;
}

function renderBudgetTierFields(): string {
  return `
    ${renderKeyField("groq", "Groq API key", "Transcription (batch — live partials will be choppier than the default tier)")}
    <div class="field">
      <label for="budget-summarizer">Summarization provider</label>
      <select id="budget-summarizer">
        <option value="gemini" ${settings.summarizationProvider === "gemini" ? "selected" : ""}>Gemini Flash</option>
        <option value="deepseek" ${settings.summarizationProvider === "deepseek" ? "selected" : ""}>DeepSeek V4 Flash</option>
      </select>
    </div>
    ${renderKeyField(settings.summarizationProvider === "deepseek" ? "deepseek" : "gemini", `${settings.summarizationProvider === "deepseek" ? "DeepSeek" : "Gemini"} API key`, "Summarization")}
  `;
}

function renderKeyField(provider: keyof NotetakerSettings["apiKeys"], label: string, hint: string): string {
  return `
    <div class="field">
      <label for="key-${provider}">${label}</label>
      <div class="key-row">
        <input type="password" id="key-${provider}" data-provider="${provider}" value="${settings.apiKeys[provider] ?? ""}" />
        <button type="button" class="secondary test-key" data-provider="${provider}">Test</button>
      </div>
      <p class="field-hint text-secondary">${hint}</p>
      <p class="test-result" id="test-result-${provider}"></p>
    </div>
  `;
}

function readFormIntoSettings(): void {
  const budget = isBudgetTier(settings);
  if (!budget) {
    settings.apiKeys.deepgram = (document.getElementById("key-deepgram") as HTMLInputElement)?.value;
    settings.apiKeys.claude = (document.getElementById("key-claude") as HTMLInputElement)?.value;
    settings.summarizationProvider = "claude";
  } else {
    settings.apiKeys.groq = (document.getElementById("key-groq") as HTMLInputElement)?.value;
    const summarizer = (document.getElementById("budget-summarizer") as HTMLSelectElement)?.value as SummarizationProvider;
    settings.summarizationProvider = summarizer;
    const keyInput = document.getElementById(`key-${summarizer}`) as HTMLInputElement | null;
    if (keyInput) settings.apiKeys[summarizer] = keyInput.value;
  }

  const webappUrl = (document.getElementById("webapp-url") as HTMLInputElement)?.value.trim();
  const webappToken = (document.getElementById("webapp-token") as HTMLInputElement)?.value.trim();
  settings.webapp = webappUrl && webappToken ? { url: webappUrl, token: webappToken } : null;
}

function wireEvents(): void {
  document.getElementById("tier-default")?.addEventListener("click", () => {
    readFormIntoSettings();
    settings.transcriptionProvider = "deepgram";
    settings.summarizationProvider = "claude";
    render();
  });
  document.getElementById("tier-budget")?.addEventListener("click", () => {
    readFormIntoSettings();
    settings.transcriptionProvider = "groq";
    settings.summarizationProvider = settings.summarizationProvider === "claude" ? "gemini" : settings.summarizationProvider;
    render();
  });
  document.getElementById("budget-summarizer")?.addEventListener("change", () => {
    readFormIntoSettings();
    render();
  });

  for (const button of document.querySelectorAll<HTMLButtonElement>(".test-key")) {
    button.addEventListener("click", async () => {
      const provider = button.dataset.provider as ProviderKind;
      const input = document.getElementById(`key-${provider}`) as HTMLInputElement;
      const resultEl = document.getElementById(`test-result-${provider}`)!;
      resultEl.textContent = "Checking…";
      resultEl.className = "test-result text-secondary";
      const result = await testApiKey(provider, input.value);
      resultEl.textContent = result.message;
      resultEl.className = `test-result ${result.valid ? "valid" : "invalid"}`;
    });
  }

  document.getElementById("test-webapp")?.addEventListener("click", async () => {
    const url = (document.getElementById("webapp-url") as HTMLInputElement).value.trim();
    const resultEl = document.getElementById("webapp-test-result")!;
    if (!url) {
      resultEl.textContent = "Enter a webapp URL first.";
      resultEl.className = "test-result invalid";
      return;
    }
    resultEl.textContent = "Checking…";
    resultEl.className = "test-result text-secondary";
    const result = await testWebappHealth(url);
    resultEl.textContent = result.message;
    resultEl.className = `test-result ${result.healthy ? "valid" : "invalid"}`;
  });

  document.getElementById("save-settings")?.addEventListener("click", async () => {
    readFormIntoSettings();
    const statusEl = document.getElementById("save-status")!;
    await chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings });
    statusEl.textContent = "Saved.";
    setTimeout(() => {
      statusEl.textContent = "";
    }, 2000);
  });
}

async function init(): Promise<void> {
  settings = await getSettings();
  render();
}

void init();
