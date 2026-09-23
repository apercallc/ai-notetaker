import { getSettings } from "../lib/storage";
import { normalizeWebappUrl, testWebappHealth } from "../lib/providerTest";
import { testProviderKey as testApiKey } from "../lib/testProviderKey";
import { escapeHtml } from "../lib/html";
import { estimateMeetingCost } from "../lib/costEstimate";
import { connectCalendar } from "../lib/calendar";
import { DEFAULT_SETTINGS, type NotetakerSettings, type ProviderKind, type SummarizationProvider } from "../types";

const app = document.getElementById("app")!;
let settings: NotetakerSettings = DEFAULT_SETTINGS;

function isBudgetTier(s: NotetakerSettings): boolean {
  return s.transcriptionProvider === "groq";
}

function render(): void {
  const budget = isBudgetTier(settings);
  app.innerHTML = `
    <h1 tabindex="-1" data-view-heading>Settings</h1>

    <fieldset>
      <legend>AI provider</legend>
      <p class="text-secondary field-hint">
        AI Notetaker never bills you — you bring your own API key(s) and pay
        the provider directly, at cost. See the cost table in the README for
        current per-meeting estimates.
      </p>
      <div class="tier-toggle" role="group" aria-label="Provider tier">
        <button type="button" id="tier-default" class="${!budget ? "primary active" : "secondary"}" aria-pressed="${!budget}">Default (best quality)</button>
        <button type="button" id="tier-budget" class="${budget ? "primary active" : "secondary"}" aria-pressed="${budget}">Budget (lowest cost)</button>
      </div>

      <div class="cost-estimator">
        <label for="meeting-minutes">Estimated meeting length (minutes)</label>
        <input type="number" id="meeting-minutes" min="1" max="480" step="1" value="45" />
        <p class="field-hint text-secondary" id="cost-estimate" aria-live="polite"></p>
      </div>

      ${!budget ? renderDefaultTierFields() : renderBudgetTierFields()}
    </fieldset>

    <fieldset>
      <legend>Meeting intelligence</legend>
      <p class="text-secondary field-hint">
        Pick the summary shape you use most. These preferences stay on this
        device and are sent to your chosen provider only through the helper.
      </p>
      <div class="field">
        <label for="default-meeting-mode">Default meeting mode</label>
        <select id="default-meeting-mode">
          ${meetingModeOptions(settings.defaultMeetingMode)}
        </select>
      </div>
      <div class="field">
        <label for="custom-vocabulary">Custom vocabulary</label>
        <textarea id="custom-vocabulary" rows="4" placeholder="One name, product, or acronym per line">${escapeHtml(settings.customVocabulary.join("\n"))}</textarea>
        <p class="field-hint text-secondary">Names and terms the transcript or summary should spell correctly.</p>
      </div>
      <div class="field">
        <label for="custom-summary-instructions">Custom summary instructions</label>
        <textarea id="custom-summary-instructions" rows="4" placeholder="For example: always call out launch risks and unanswered questions.">${escapeHtml(settings.customSummaryInstructions)}</textarea>
      </div>
    </fieldset>

    <fieldset>
      <legend>Calendar (optional)</legend>
      <p class="text-secondary field-hint">
        Auto-label a meeting's title and attendees from your calendar when you
        start recording. Uses your own OAuth app (like an API key) — never a
        shared one — so nothing here goes through a project-run server.
      </p>
      ${renderCalendarFields()}
    </fieldset>

    <fieldset>
      <legend>Self-hosted history webapp (optional)</legend>
      <p class="text-secondary field-hint">
        Deploy your own instance for persistent, cross-device history. Not
        required — meetings are always saved locally regardless.
      </p>
      <div class="field">
        <label for="webapp-url">Webapp URL</label>
        <input type="url" id="webapp-url" placeholder="https://your-app.up.railway.app" value="${escapeHtml(settings.webapp?.url ?? "")}" />
      </div>
      <div class="field">
        <label for="webapp-token">Access token</label>
        <div class="key-row">
          <input type="password" id="webapp-token" autocomplete="off" value="${escapeHtml(settings.webapp?.token ?? "")}" />
          <button type="button" class="secondary" id="test-webapp">Test connection</button>
        </div>
        <p class="test-result" id="webapp-test-result" role="status" aria-live="polite"></p>
      </div>
    </fieldset>

    <div class="save-bar">
      <button type="button" class="primary" id="save-settings">Save settings</button>
      <span class="test-result text-secondary" id="save-status" role="status" aria-live="polite"></span>
    </div>
  `;

  wireEvents();
  // Each render replaces the entire page. Move focus to the heading
  // instead of leaving keyboard users at document.body — render() only
  // fires from discrete clicks/changes (tier toggle, calendar
  // connect/disconnect), never from continuous typing, so this can't
  // steal focus mid-input.
  app.querySelector<HTMLElement>("[data-view-heading]")?.focus({ preventScroll: true });
}

function meetingModeOptions(selected: NotetakerSettings["defaultMeetingMode"]): string {
  const options = [
    ["general", "General"],
    ["standup", "Standup"],
    ["sales", "Sales call"],
    ["one_on_one", "1:1"],
    ["interview", "Interview"],
    ["custom", "Custom template"],
  ] as const;
  return options.map(([value, label]) => `<option value="${value}" ${selected === value ? "selected" : ""}>${label}</option>`).join("");
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

// Only held while the user is filling in a new connection — cleared once
// `settings.calendar` is set (or the user picks "None"). Not part of
// NotetakerSettings since it's meaningless once saved/connected.
let pendingCalendarProvider: "none" | "google" | "outlook" = settings.calendar?.provider ?? "none";

function renderCalendarFields(): string {
  if (settings.calendar) {
    const label = settings.calendar.provider === "google" ? "Google Calendar" : "Outlook Calendar";
    return `
      <div class="field">
        <p>Connected to ${label}.</p>
        <button type="button" class="secondary" id="disconnect-calendar">Disconnect</button>
      </div>
    `;
  }

  return `
    <div class="field">
      <label for="calendar-provider">Provider</label>
      <select id="calendar-provider">
        <option value="none" ${pendingCalendarProvider === "none" ? "selected" : ""}>None</option>
        <option value="google" ${pendingCalendarProvider === "google" ? "selected" : ""}>Google Calendar</option>
        <option value="outlook" ${pendingCalendarProvider === "outlook" ? "selected" : ""}>Outlook Calendar</option>
      </select>
    </div>
    ${
      pendingCalendarProvider === "none"
        ? ""
        : `
      <p class="field-hint text-secondary">
        This is your own OAuth app, created once in
        ${
          pendingCalendarProvider === "google"
            ? `<a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">Google Cloud Console → Credentials</a> (enable the Calendar API, create an OAuth client, choose "Chrome extension" as the application type)`
            : `<a href="https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noreferrer">Azure Portal → App registrations</a> (add the Calendars.Read Microsoft Graph permission)`
        } — never a shared one this extension provides for you.
      </p>
      <div class="field">
        <label for="calendar-client-id">Client ID</label>
        <input type="text" id="calendar-client-id" autocomplete="off" />
      </div>
      ${
        pendingCalendarProvider === "google"
          ? `
        <div class="field">
          <label for="calendar-client-secret">Client secret</label>
          <input type="password" id="calendar-client-secret" autocomplete="off" />
        </div>
      `
          : ""
      }
      <div class="field">
        <p class="field-hint text-secondary">
          Redirect URI to register with your OAuth app: <code>${escapeHtml(chrome.identity.getRedirectURL())}</code>
        </p>
        <button type="button" class="secondary" id="connect-calendar">Connect</button>
        <p class="test-result" id="calendar-test-result" role="status" aria-live="polite"></p>
      </div>
    `
    }
  `;
}

function renderKeyField(provider: keyof NotetakerSettings["apiKeys"], label: string, hint: string): string {
  return `
    <div class="field">
      <label for="key-${provider}">${label}</label>
      <div class="key-row">
        <input type="password" id="key-${provider}" data-provider="${provider}" autocomplete="off" value="${escapeHtml(settings.apiKeys[provider] ?? "")}" />
        <button type="button" class="secondary test-key" data-provider="${provider}">Test</button>
      </div>
      <p class="field-hint text-secondary">${hint}</p>
      <p class="test-result" id="test-result-${provider}" role="status" aria-live="polite"></p>
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
  settings.defaultMeetingMode = (document.getElementById("default-meeting-mode") as HTMLSelectElement)?.value as NotetakerSettings["defaultMeetingMode"];
  settings.customVocabulary = (document.getElementById("custom-vocabulary") as HTMLTextAreaElement)?.value
    .split(/\r?\n/)
    .map((term) => term.trim())
    .filter(Boolean)
    .slice(0, 100);
  settings.customSummaryInstructions = (document.getElementById("custom-summary-instructions") as HTMLTextAreaElement)?.value.trim().slice(0, 4000) ?? "";
}

function wireEvents(): void {
  const minutesInput = document.getElementById("meeting-minutes") as HTMLInputElement | null;
  const costEstimate = document.getElementById("cost-estimate");
  const updateCostEstimate = () => {
    if (!minutesInput || !costEstimate) return;
    const minutes = Number(minutesInput.value);
    const estimate = estimateMeetingCost(budgetTier(), minutes);
    costEstimate.textContent = `Approx. $${estimate.toFixed(2)} in provider fees. Your providers bill you directly; verify current pricing before relying on this estimate.`;
  };
  const budgetTier = () => (isBudgetTier(settings) ? "budget" : "default") as "budget" | "default";
  minutesInput?.addEventListener("input", updateCostEstimate);
  updateCostEstimate();

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
      button.disabled = true;
      resultEl.textContent = "Checking…";
      resultEl.className = "test-result text-secondary";
      try {
        const result = await testApiKey(provider, input.value);
        resultEl.textContent = result.message;
        resultEl.className = `test-result ${result.valid ? "valid" : "invalid"}`;
      } catch {
        resultEl.textContent = "The helper could not test this key. Check that it is running and try again.";
        resultEl.className = "test-result invalid";
      } finally {
        button.disabled = false;
      }
    });
  }

  document.getElementById("calendar-provider")?.addEventListener("change", () => {
    pendingCalendarProvider = (document.getElementById("calendar-provider") as HTMLSelectElement).value as typeof pendingCalendarProvider;
    render();
  });

  document.getElementById("connect-calendar")?.addEventListener("click", async () => {
    const connectButton = document.getElementById("connect-calendar") as HTMLButtonElement;
    const resultEl = document.getElementById("calendar-test-result")!;
    const clientId = (document.getElementById("calendar-client-id") as HTMLInputElement)?.value.trim();
    const clientSecret = (document.getElementById("calendar-client-secret") as HTMLInputElement | null)?.value.trim();
    if (!clientId || (pendingCalendarProvider === "none")) {
      resultEl.textContent = "Enter a Client ID first.";
      resultEl.className = "test-result invalid";
      return;
    }
    connectButton.disabled = true;
    resultEl.textContent = "Opening the sign-in window…";
    resultEl.className = "test-result text-secondary";
    try {
      const provider = pendingCalendarProvider as "google" | "outlook";
      settings.calendar = await connectCalendar(provider, clientId, clientSecret || undefined);
      await chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings });
      render();
    } catch {
      resultEl.textContent = "Could not connect. Check your Client ID/secret and redirect URI, then try again.";
      resultEl.className = "test-result invalid";
      connectButton.disabled = false;
    }
  });

  document.getElementById("disconnect-calendar")?.addEventListener("click", async () => {
    settings.calendar = null;
    pendingCalendarProvider = "none";
    await chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings });
    render();
  });

  document.getElementById("test-webapp")?.addEventListener("click", async () => {
    const testButton = document.getElementById("test-webapp") as HTMLButtonElement;
    const url = (document.getElementById("webapp-url") as HTMLInputElement).value.trim();
    const resultEl = document.getElementById("webapp-test-result")!;
    if (!url) {
      resultEl.textContent = "Enter a webapp URL first.";
      resultEl.className = "test-result invalid";
      return;
    }
    testButton.disabled = true;
    resultEl.textContent = "Checking…";
    resultEl.className = "test-result text-secondary";
    try {
      const result = await testWebappHealth(url);
      resultEl.textContent = result.message;
      resultEl.className = `test-result ${result.healthy ? "valid" : "invalid"}`;
    } catch {
      resultEl.textContent = "The connection test failed unexpectedly. Check the URL and try again.";
      resultEl.className = "test-result invalid";
    } finally {
      testButton.disabled = false;
    }
  });

  document.getElementById("save-settings")?.addEventListener("click", async () => {
    const saveButton = document.getElementById("save-settings") as HTMLButtonElement;
    readFormIntoSettings();
    const statusEl = document.getElementById("save-status")!;
    if (settings.webapp && !normalizeWebappUrl(settings.webapp.url)) {
      statusEl.textContent = "Use an HTTPS webapp URL (HTTP is allowed only for localhost).";
      statusEl.className = "test-result invalid";
      return;
    }
    saveButton.disabled = true;
    statusEl.textContent = "Saving…";
    statusEl.className = "test-result text-secondary";
    try {
      await chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings });
      statusEl.textContent = "Saved.";
      setTimeout(() => {
        statusEl.textContent = "";
      }, 2000);
    } catch {
      statusEl.textContent = "Could not save settings. Reopen the extension and try again.";
      statusEl.className = "test-result invalid";
    } finally {
      saveButton.disabled = false;
    }
  });
}

async function init(): Promise<void> {
  settings = await getSettings();
  pendingCalendarProvider = settings.calendar?.provider ?? "none";
  render();
}

function renderFailure(): void {
  app.innerHTML = `
    <h1 tabindex="-1" data-view-heading>Settings</h1>
    <div class="empty-state" role="alert">
      <p>Settings could not be loaded.</p>
      <button type="button" class="primary" id="retry-settings">Try again</button>
    </div>
  `;
  document.getElementById("retry-settings")?.addEventListener("click", () => void init().catch(renderFailure));
}

void init().catch(renderFailure);
