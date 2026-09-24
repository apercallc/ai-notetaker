import { getSettings } from "../lib/storage";
import { normalizeWebappUrl, testWebappHealth } from "../lib/providerTest";
import { testProviderKey as testApiKey } from "../lib/testProviderKey";
import { escapeHtml } from "../lib/html";
import { estimateMeetingCost } from "../lib/costEstimate";
import { connectCalendar } from "../lib/calendar";
import { connectGoogleDrive } from "../lib/drive";
import { readShortcuts, shortcutKeys } from "../lib/shortcuts";
import { DEFAULT_SETTINGS, type NotetakerSettings, type ProviderKind, type SummarizationProvider } from "../types";
import { loginManaged, managedBillingUrl, managedSignupUrl } from "../lib/managedClient";

const app = document.getElementById("app")!;
let settings: NotetakerSettings = DEFAULT_SETTINGS;
let managedSetupVisible = settings.processingMode.kind === "managed";

function isBudgetTier(s: NotetakerSettings): boolean {
  return s.transcriptionProvider === "groq";
}

function safeManagedBillingUrl(baseUrl: string): string {
  try {
    return managedBillingUrl(baseUrl);
  } catch {
    return "";
  }
}

function render(): void {
  const budget = isBudgetTier(settings);
  const managedView = managedSetupVisible;
  app.innerHTML = `
    <h1 tabindex="-1" data-view-heading>Settings</h1>
    <p class="page-intro text-secondary">Choose how meetings are processed, then tailor the notes you get back.</p>

    ${renderModeFields()}

    <fieldset>
      <legend>AI provider</legend>
      <p class="text-secondary field-hint">
        ${managedView
          ? "Hosted AI uses platform-managed provider credentials. They never enter this extension."
          : "Every local recording uses exactly two provider keys: one transcription key and one summarization key. They stay on this device; Meet uses the browser path and desktop calls use the helper."}
      </p>
      ${managedView ? `<div class="callout"><strong>${settings.processingMode.kind === "managed" ? "Managed mode is active." : "Hosted mode setup"}</strong><p class="text-secondary">Local-first recordings are uploaded only to your authenticated workspace for processing.</p></div>` : `
        <div class="tier-toggle" role="group" aria-label="Provider tier">
          <button type="button" id="tier-default" class="${!budget ? "primary active" : "secondary"}" aria-pressed="${!budget}">Default: Deepgram + Claude</button>
          <button type="button" id="tier-budget" class="${budget ? "primary active" : "secondary"}" aria-pressed="${budget}">Budget: Groq + Gemini/DeepSeek</button>
        </div>
        <div class="cost-estimator">
          <label for="meeting-minutes">Estimated meeting length (minutes)</label>
          <input type="number" id="meeting-minutes" min="1" max="480" step="1" value="45" />
          <p class="field-hint text-secondary" id="cost-estimate" aria-live="polite"></p>
        </div>
        ${!budget ? renderDefaultTierFields() : renderBudgetTierFields()}
      `}
    </fieldset>

    <fieldset>
      <legend>Google Meet</legend>
      <div class="field checkbox-field">
        <label for="show-meet-widget">
          <input type="checkbox" id="show-meet-widget" ${settings.showMeetWidget ? "checked" : ""} />
          Show the notes widget during Google Meet calls
        </label>
        <p class="field-hint text-secondary">
          A small movable pill on the call page with one-click recording, the live transcript,
          and a way to flag moments. Turn it off to use only the toolbar popup and shortcuts.
        </p>
      </div>
      <p class="field-hint text-secondary" id="shortcut-summary" aria-live="polite">Checking your keyboard shortcuts…</p>
      <button type="button" class="secondary" id="change-shortcuts">Change shortcuts</button>
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

    <fieldset>
      <legend>Google Drive notes (optional)</legend>
      <p class="text-secondary field-hint">
        After a summary is ready, create a Google Doc in <code>My Drive/ai-notetaker</code>.
        Meetings are always kept locally first; Drive errors never delete or block them.
      </p>
      ${renderDriveFields()}
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

function renderModeFields(): string {
  const managed = managedSetupVisible;
  const billingLink = settings.managedService ? safeManagedBillingUrl(settings.managedService.baseUrl) : "";
  return `
    <fieldset>
      <legend>Processing mode</legend>
      <div class="tier-toggle" role="group" aria-label="Processing mode">
        <button type="button" id="mode-local" class="${managed ? "secondary" : "primary active"}" aria-pressed="${!managed}">Free local BYOK</button>
        <button type="button" id="mode-managed" class="${managed ? "primary active" : "secondary"}" aria-pressed="${managed}">Hosted AI</button>
      </div>
      ${managed ? settings.processingMode.kind === "managed" ? `<p class="field-hint text-secondary">Hosted account <strong>${escapeHtml(settings.managedService?.accountId ?? "unknown")}</strong> · plan <strong>${escapeHtml(settings.managedService?.plan ?? "unknown")}</strong></p>${billingLink ? `<p class="field-hint"><a href="${escapeHtml(billingLink)}" target="_blank" rel="noreferrer">Manage hosted billing</a></p>` : ""}<button type="button" class="secondary" id="managed-sign-out">Use local BYOK instead</button>` : `<p class="field-hint text-secondary">Sign in to a hosted workspace to enable managed AI. You can also keep the free local BYOK mode with no account.</p><div class="field"><label for="managed-url">Hosted service URL (optional)</label><input type="url" id="managed-url" placeholder="https://notes.example.com" /></div><div class="field"><label for="managed-email">Account email</label><input type="email" id="managed-email" autocomplete="username" /></div><div class="field"><label for="managed-password">Account password</label><input type="password" id="managed-password" autocomplete="current-password" /></div><button type="button" class="secondary" id="managed-sign-in">Sign in to hosted AI</button><button type="button" class="secondary" id="managed-signup" disabled>Create hosted account</button><p class="test-result" id="managed-sign-in-result" role="status" aria-live="polite"></p>` : `
        <p class="field-hint text-secondary">No account or subscription is required. Google Meet uses the browser path; desktop calls use the helper. Both use the provider keys stored locally.</p>
        <div class="field"><label for="managed-url">Hosted service URL (optional)</label><input type="url" id="managed-url" placeholder="https://notes.example.com" /></div>
        <div class="field"><label for="managed-email">Account email</label><input type="email" id="managed-email" autocomplete="username" /></div>
        <div class="field"><label for="managed-password">Account password</label><input type="password" id="managed-password" autocomplete="current-password" /></div>
        <button type="button" class="secondary" id="managed-sign-in">Sign in to hosted AI</button>
        <button type="button" class="secondary" id="managed-signup" disabled>Create hosted account</button>
        <p class="test-result" id="managed-sign-in-result" role="status" aria-live="polite"></p>
      `}
    </fieldset>
  `;
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
    <p class="field-hint"><strong>Two keys required for this tier:</strong> one for each role below.</p>
    ${renderKeyField("deepgram", "1. Deepgram API key", "Transcription — live transcript updates")}
    ${renderKeyField("claude", "2. Claude API key", "Summarization — summary and action items after you stop")}
  `;
}

function renderBudgetTierFields(): string {
  return `
    <p class="field-hint"><strong>Two keys required for this tier:</strong> Groq for transcription, plus one summarization provider.</p>
    ${renderKeyField("groq", "1. Groq API key", "Transcription — batch mode, so live partials are less immediate")}
    <div class="field">
      <label for="budget-summarizer">2. Summarization provider</label>
      <select id="budget-summarizer">
        <option value="gemini" ${settings.summarizationProvider === "gemini" ? "selected" : ""}>Gemini Flash</option>
        <option value="deepseek" ${settings.summarizationProvider === "deepseek" ? "selected" : ""}>DeepSeek V4 Flash</option>
      </select>
    </div>
    ${renderKeyField(settings.summarizationProvider === "deepseek" ? "deepseek" : "gemini", `${settings.summarizationProvider === "deepseek" ? "DeepSeek" : "Gemini"} API key`, "Summarization — summary and action items after you stop")}
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
      ${
        settings.calendar.provider === "google"
          ? `<div class="field checkbox-field">
        <label for="calendar-reminders">
          <input type="checkbox" id="calendar-reminders" ${settings.calendarReminders ? "checked" : ""} />
          Remind me when a call with a Google Meet link is about to start
        </label>
        <p class="field-hint text-secondary">A desktop notification a minute before the call. Click it to open the call, then start notes from the pill. Uses your calendar connection only; nothing leaves this device.</p>
      </div>`
          : ""
      }
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

function renderDriveFields(): string {
  if (settings.drive) {
    return `
      <div class="field">
        <p>Google Drive is connected. Notes will be created in <code>My Drive/ai-notetaker</code>.</p>
        <button type="button" class="secondary" id="disconnect-drive">Disconnect Google Drive</button>
      </div>
    `;
  }
  return `
    <p class="field-hint text-secondary">
      Create your own OAuth client in <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">Google Cloud Console → Credentials</a>, enable the Google Drive API, and choose “Chrome extension”.
      This extension requests only the <code>drive.file</code> permission for files it creates.
    </p>
    <div class="field">
      <label for="drive-client-id">Google OAuth Client ID</label>
      <input type="text" id="drive-client-id" autocomplete="off" />
    </div>
    <div class="field">
      <label for="drive-client-secret">Client secret (if your OAuth client has one)</label>
      <input type="password" id="drive-client-secret" autocomplete="off" />
    </div>
    <div class="field">
      <p class="field-hint text-secondary">Redirect URI: <code>${escapeHtml(chrome.identity.getRedirectURL())}</code></p>
      <button type="button" class="secondary" id="connect-drive">Connect Google Drive</button>
      <p class="test-result" id="drive-test-result" role="status" aria-live="polite"></p>
    </div>
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
  if (!managedSetupVisible && !budget) {
    settings.apiKeys.deepgram = (document.getElementById("key-deepgram") as HTMLInputElement)?.value;
    settings.apiKeys.claude = (document.getElementById("key-claude") as HTMLInputElement)?.value;
    settings.summarizationProvider = "claude";
  } else if (!managedSetupVisible) {
    settings.apiKeys.groq = (document.getElementById("key-groq") as HTMLInputElement)?.value;
    const summarizer = (document.getElementById("budget-summarizer") as HTMLSelectElement)?.value as SummarizationProvider;
    settings.summarizationProvider = summarizer;
    const keyInput = document.getElementById(`key-${summarizer}`) as HTMLInputElement | null;
    if (keyInput) settings.apiKeys[summarizer] = keyInput.value;
  }

  const webappUrl = (document.getElementById("webapp-url") as HTMLInputElement)?.value.trim();
  const webappToken = (document.getElementById("webapp-token") as HTMLInputElement)?.value.trim();
  settings.webapp = webappUrl && webappToken ? { url: webappUrl, token: webappToken } : null;
  settings.calendarReminders = (document.getElementById("calendar-reminders") as HTMLInputElement | null)?.checked ?? settings.calendarReminders;
  settings.showMeetWidget = (document.getElementById("show-meet-widget") as HTMLInputElement | null)?.checked ?? settings.showMeetWidget;
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
  if (minutesInput) updateCostEstimate();

  document.getElementById("mode-local")?.addEventListener("click", () => {
    readFormIntoSettings();
    settings.processingMode = { kind: "local_byok" };
    settings.managedService = null;
    managedSetupVisible = false;
    render();
  });
  document.getElementById("managed-sign-out")?.addEventListener("click", () => {
    settings.processingMode = { kind: "local_byok" };
    settings.managedService = null;
    managedSetupVisible = false;
    render();
  });
  document.getElementById("mode-managed")?.addEventListener("click", () => {
    managedSetupVisible = true;
    render();
    document.getElementById("managed-url")?.focus();
  });
  document.getElementById("managed-sign-in")?.addEventListener("click", async () => {
    const resultEl = document.getElementById("managed-sign-in-result")!;
    const button = document.getElementById("managed-sign-in") as HTMLButtonElement;
    const baseUrl = (document.getElementById("managed-url") as HTMLInputElement).value.trim();
    const email = (document.getElementById("managed-email") as HTMLInputElement).value.trim();
    const password = (document.getElementById("managed-password") as HTMLInputElement).value;
    button.disabled = true;
    resultEl.textContent = "Signing in…";
    resultEl.className = "test-result text-secondary";
    try {
      const result = await loginManaged(baseUrl, email, password);
      settings.managedService = result.config;
      settings.processingMode = { kind: "managed", accountId: result.config.accountId, workspaceId: result.config.workspaceId, plan: result.config.plan };
      managedSetupVisible = true;
      await chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings });
      render();
    } catch (error) {
      resultEl.textContent = error instanceof Error ? error.message : "Hosted sign-in failed.";
      resultEl.className = "test-result invalid";
    } finally {
      button.disabled = false;
    }
  });
  const managedUrlInput = document.getElementById("managed-url") as HTMLInputElement | null;
  const managedSignupButton = document.getElementById("managed-signup") as HTMLButtonElement | null;
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
      const resultEl = document.getElementById("managed-sign-in-result");
      if (resultEl) {
        resultEl.textContent = error instanceof Error ? error.message : "Enter a valid hosted service URL first.";
        resultEl.className = "test-result invalid";
      }
    }
  });

  void readShortcuts().then((shortcuts) => {
    const summary = document.getElementById("shortcut-summary");
    if (!summary) return;
    const keys = (shortcut: string): string => shortcutKeys(shortcut).map((key) => `<kbd>${escapeHtml(key)}</kbd>`).join("");
    summary.innerHTML = [
      shortcuts.toggle ? `${keys(shortcuts.toggle)} starts or stops notes.` : "No shortcut is set to start or stop notes.",
      shortcuts.bookmark ? `${keys(shortcuts.bookmark)} flags a moment.` : "No shortcut is set to flag a moment.",
      "Chrome only assigns a suggested shortcut when it is free, so set your own below if needed.",
    ].join(" ");
  });

  document.getElementById("change-shortcuts")?.addEventListener("click", () => {
    void chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  });

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

  document.getElementById("connect-drive")?.addEventListener("click", async () => {
    const button = document.getElementById("connect-drive") as HTMLButtonElement;
    const resultEl = document.getElementById("drive-test-result")!;
    const clientId = (document.getElementById("drive-client-id") as HTMLInputElement)?.value.trim();
    const clientSecret = (document.getElementById("drive-client-secret") as HTMLInputElement)?.value.trim();
    if (!clientId) {
      resultEl.textContent = "Enter a Google OAuth Client ID first.";
      resultEl.className = "test-result invalid";
      return;
    }
    button.disabled = true;
    resultEl.textContent = "Opening Google sign-in…";
    resultEl.className = "test-result text-secondary";
    try {
      settings.drive = await connectGoogleDrive(clientId, clientSecret || undefined);
      await chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings });
      render();
    } catch (error) {
      resultEl.textContent = error instanceof Error ? error.message : "Could not connect Google Drive. Check the OAuth client and redirect URI.";
      resultEl.className = "test-result invalid";
      button.disabled = false;
    }
  });

  document.getElementById("disconnect-drive")?.addEventListener("click", async () => {
    settings.drive = null;
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
