import { getSettings } from "../lib/storage";
import { testWebappHealth } from "../lib/providerTest";
import { testProviderKey as testApiKey } from "../lib/testProviderKey";
import { escapeHtml } from "../lib/html";
import { estimateMeetingCost } from "../lib/costEstimate";
import { connectCalendar } from "../lib/calendar";
import { connectGoogleDrive } from "../lib/drive";
import { readShortcuts, shortcutKeys } from "../lib/shortcuts";
import { DEFAULT_SETTINGS, type NotetakerSettings, type ProviderKind, type SummarizationProvider } from "../types";
import { loginManaged, managedBillingUrl, managedSignupUrl } from "../lib/managedClient";
import {
  MODE_LABEL_HOSTED,
  MODE_LABEL_OWN_KEYS,
  applyModeChoice,
  hasHostedSession,
  isHostedActive,
  signOutOfHosted,
  validateWebappInputs,
} from "./settingsModel";

const app = document.getElementById("app")!;
let settings: NotetakerSettings = structuredClone(DEFAULT_SETTINGS);
/** Which mode the page is showing (not necessarily saved yet). Set from the loaded settings in init(). */
let managedSetupVisible = isHostedActive(settings);

/**
 * Text the user has typed but which is not part of `settings` yet (or, like
 * the hosted email, never will be). render() replaces the whole page, so every
 * field that can hold in-progress input is captured here first and restored
 * into the new markup. Passwords are deliberately not kept.
 */
interface Drafts {
  managedUrl: string;
  managedEmail: string;
  webappUrl: string;
  webappToken: string;
  calendarClientId: string;
  calendarClientSecret: string;
  driveClientId: string;
  driveClientSecret: string;
  meetingMinutes: string;
}
let drafts: Drafts = emptyDrafts();

function emptyDrafts(): Drafts {
  return {
    managedUrl: "",
    managedEmail: "",
    webappUrl: "",
    webappToken: "",
    calendarClientId: "",
    calendarClientSecret: "",
    driveClientId: "",
    driveClientSecret: "",
    meetingMinutes: "45",
  };
}

// Disclosure state survives re-renders so toggling a provider never collapses what the user was editing.
let integrationsOpen = false;
let calendarAdvancedOpen = false;
let driveAdvancedOpen = false;
let signedOutNotice = "";

// Only held while the user is filling in a new connection — cleared once
// `settings.calendar` is set (or the user picks "None").
let pendingCalendarProvider: "none" | "google" | "outlook" = "none";

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

function inputValue(id: string): string | undefined {
  return (document.getElementById(id) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null)?.value;
}

function captureDrafts(): void {
  const pick = (id: string, current: string): string => inputValue(id) ?? current;
  drafts = {
    managedUrl: pick("managed-url", drafts.managedUrl),
    managedEmail: pick("managed-email", drafts.managedEmail),
    webappUrl: pick("webapp-url", drafts.webappUrl),
    webappToken: pick("webapp-token", drafts.webappToken),
    calendarClientId: pick("calendar-client-id", drafts.calendarClientId),
    calendarClientSecret: pick("calendar-client-secret", drafts.calendarClientSecret),
    driveClientId: pick("drive-client-id", drafts.driveClientId),
    driveClientSecret: pick("drive-client-secret", drafts.driveClientSecret),
    meetingMinutes: pick("meeting-minutes", drafts.meetingMinutes),
  };
}

/**
 * Reads whatever the current markup holds into `settings`/`drafts`. Driven by
 * which elements exist, not by which tier is selected, so it is safe to call
 * before AND after a state change without wiping a value whose input is gone.
 */
function readFormIntoSettings(includeProviderChoice = true): void {
  for (const input of document.querySelectorAll<HTMLInputElement>("input[data-provider]")) {
    const provider = input.dataset.provider as keyof NotetakerSettings["apiKeys"];
    settings.apiKeys[provider] = input.value;
  }
  // render() passes false: by then a tier click may already have changed the
  // provider, and the outgoing (stale) select must not overwrite that choice.
  const summarizer = inputValue("budget-summarizer") as SummarizationProvider | undefined;
  if (includeProviderChoice && summarizer) settings.summarizationProvider = summarizer;

  captureDrafts();

  const reminders = document.getElementById("calendar-reminders") as HTMLInputElement | null;
  if (reminders) settings.calendarReminders = reminders.checked;
  const widget = document.getElementById("show-meet-widget") as HTMLInputElement | null;
  if (widget) settings.showMeetWidget = widget.checked;
  const meetingMode = inputValue("default-meeting-mode") as NotetakerSettings["defaultMeetingMode"] | undefined;
  if (meetingMode) settings.defaultMeetingMode = meetingMode;
  const vocabulary = inputValue("custom-vocabulary");
  if (vocabulary !== undefined) {
    settings.customVocabulary = vocabulary
      .split(/\r?\n/)
      .map((term) => term.trim())
      .filter(Boolean)
      .slice(0, 100);
  }
  const instructions = inputValue("custom-summary-instructions");
  if (instructions !== undefined) settings.customSummaryInstructions = instructions.trim().slice(0, 4000);
}

interface RenderOptions {
  /** Element to focus after rendering. Defaults to the page heading only on first load. */
  focus?: string;
}

function render(options: RenderOptions = {}): void {
  // Keep unsaved input: every toggle, provider switch and connect flow lands
  // here, so capture the outgoing form before it is replaced.
  if (app.querySelector("#save-settings")) readFormIntoSettings(false);
  const scrollY = window.scrollY;

  app.innerHTML = `
    <h1 tabindex="-1" data-view-heading>Settings</h1>
    <p class="page-intro text-secondary">Choose how meetings are processed, then tailor the notes you get back.</p>

    ${renderModeSection()}

    <fieldset>
      <legend>Notes preferences</legend>
      <div class="field">
        <label for="default-meeting-mode">Default meeting type</label>
        <select id="default-meeting-mode">
          ${meetingModeOptions(settings.defaultMeetingMode)}
        </select>
      </div>
      <div class="field">
        <label for="custom-vocabulary">Custom vocabulary</label>
        <textarea id="custom-vocabulary" rows="4" placeholder="One name, product, or acronym per line">${escapeHtml(settings.customVocabulary.join("\n"))}</textarea>
        <p class="field-hint text-secondary">Names and terms the transcript and summary should spell correctly.</p>
      </div>
      <div class="field">
        <label for="custom-summary-instructions">Custom summary instructions</label>
        <textarea id="custom-summary-instructions" rows="4" placeholder="For example: always call out launch risks and unanswered questions.">${escapeHtml(settings.customSummaryInstructions)}</textarea>
      </div>
    </fieldset>

    <fieldset>
      <legend>Shortcuts and Meet widget</legend>
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

    <details class="integrations" id="integrations" ${integrationsOpen ? "open" : ""}>
      <summary>Integrations (optional)</summary>
      <p class="text-secondary field-hint">Calendar, Google Drive${managedSetupVisible ? "" : " and your own history webapp"}. Meetings are always saved on this device first, so none of these are required.</p>

      <section class="integration" aria-labelledby="calendar-heading">
        <h2 id="calendar-heading">Calendar</h2>
        <p class="text-secondary field-hint">
          Fill in a meeting's title and attendees from your calendar when you start recording.
          Uses your own Google or Microsoft app, so nothing here goes through a project-run server.
        </p>
        ${renderCalendarFields()}
      </section>

      ${managedSetupVisible ? "" : `
      <section class="integration" aria-labelledby="webapp-heading">
        <h2 id="webapp-heading">Self-hosted history webapp</h2>
        <p class="text-secondary field-hint">
          Deploy your own instance for cross-device history. Enter both the URL and the access token.
        </p>
        <div class="field">
          <label for="webapp-url">Webapp URL</label>
          <input type="url" id="webapp-url" placeholder="https://your-app.up.railway.app" value="${escapeHtml(drafts.webappUrl)}" aria-describedby="webapp-url-error" />
          <p class="test-result invalid" id="webapp-url-error" role="alert"></p>
        </div>
        <div class="field">
          <label for="webapp-token">Access token</label>
          <div class="key-row">
            <input type="password" id="webapp-token" autocomplete="off" value="${escapeHtml(drafts.webappToken)}" aria-describedby="webapp-token-error" />
            <button type="button" class="secondary" id="test-webapp">Test connection</button>
          </div>
          <p class="test-result invalid" id="webapp-token-error" role="alert"></p>
          <p class="test-result" id="webapp-test-result" role="status" aria-live="polite"></p>
        </div>
      </section>`}

      <section class="integration" aria-labelledby="drive-heading">
        <h2 id="drive-heading">Google Drive notes</h2>
        <p class="text-secondary field-hint">
          After a summary is ready, create a Google Doc in <code>My Drive/ai-notetaker</code>.
          Drive errors never delete or block your local meeting.
        </p>
        ${renderDriveFields()}
      </section>
    </details>

    <div class="save-bar">
      <button type="button" class="primary" id="save-settings">Save settings</button>
      <span class="test-result text-secondary" id="save-status" role="status" aria-live="polite"></span>
    </div>
  `;

  wireEvents();
  if (scrollY > 0) window.scrollTo(0, scrollY);
  const focusTarget = options.focus ? document.getElementById(options.focus) : null;
  // First load: put keyboard users on the heading rather than <body>. Later
  // renders keep focus on (or return it to) the control that caused them.
  (focusTarget ?? (options.focus === undefined ? app.querySelector<HTMLElement>("[data-view-heading]") : null))?.focus({ preventScroll: true });
}

function renderModeSection(): string {
  const hosted = managedSetupVisible;
  return `
    <fieldset>
      <legend>How meetings are processed</legend>
      <div class="tier-toggle" role="group" aria-label="Processing mode">
        <button type="button" id="mode-local" class="${hosted ? "secondary" : "primary active"}" aria-pressed="${!hosted}">${MODE_LABEL_OWN_KEYS}</button>
        <button type="button" id="mode-managed" class="${hosted ? "primary active" : "secondary"}" aria-pressed="${hosted}">${MODE_LABEL_HOSTED}</button>
      </div>
      ${hosted ? renderHostedSection() : renderOwnKeysSection()}
    </fieldset>
  `;
}

function renderOwnKeysSection(): string {
  const budget = isBudgetTier(settings);
  return `
    <p class="text-secondary field-hint">
      Free, and no account needed. You use one transcription key and one summary key from providers you choose.
      They stay on this device; Google Meet uses the browser and desktop calls use the helper.
    </p>
    <div class="tier-toggle" role="group" aria-label="Provider set">
      <button type="button" id="tier-default" class="${!budget ? "primary active" : "secondary"}" aria-pressed="${!budget}">Deepgram + Claude</button>
      <button type="button" id="tier-budget" class="${budget ? "primary active" : "secondary"}" aria-pressed="${budget}">Groq + Gemini or DeepSeek (lower cost)</button>
    </div>
    ${!budget ? renderDefaultTierFields() : renderBudgetTierFields()}
    <div class="cost-estimator">
      <label for="meeting-minutes">Estimate provider cost for a meeting of (minutes)</label>
      <input type="number" id="meeting-minutes" min="1" max="480" step="1" value="${escapeHtml(drafts.meetingMinutes)}" />
      <p class="field-hint text-secondary" id="cost-estimate" aria-live="polite"></p>
    </div>
  `;
}

function renderHostedSection(): string {
  if (hasHostedSession(settings) && settings.managedService) {
    const service = settings.managedService;
    const billingLink = safeManagedBillingUrl(service.baseUrl);
    const active = isHostedActive(settings);
    return `
      <div class="callout ${active ? "" : "warning"}">
        <p><strong>${active ? "Hosted is on for this device." : "You are signed in, but Hosted is not saved as your mode yet."}</strong></p>
        <p class="text-secondary">
          Account <strong>${escapeHtml(service.accountId || "unknown")}</strong> · plan <strong>${escapeHtml(service.plan || "unknown")}</strong>.
          Recordings are saved on this device first, then uploaded only to your signed-in workspace. Provider credentials stay on the hosted service.
        </p>
        ${active ? "" : `<p class="text-secondary">Press <strong>Save settings</strong> to use Hosted.</p>`}
      </div>
      <div class="account-actions">
        ${billingLink ? `<a class="button-link" href="${escapeHtml(billingLink)}" target="_blank" rel="noreferrer">Manage billing</a>` : ""}
        <button type="button" class="secondary" id="managed-sign-out">Sign out of Hosted</button>
      </div>
      <p class="test-result" id="managed-sign-in-result" role="status" aria-live="polite"></p>
    `;
  }
  return `
    <p class="text-secondary field-hint">
      Paid. We transcribe and summarize for you, so you do not need provider keys. Sign in to your hosted workspace to turn it on.
      ${signedOutNotice ? `<br /><strong>${escapeHtml(signedOutNotice)}</strong>` : "Until then, your own API keys are used."}
    </p>
    <div class="field"><label for="managed-url">Hosted service URL</label><input type="url" id="managed-url" placeholder="https://notes.example.com" value="${escapeHtml(drafts.managedUrl)}" /></div>
    <div class="field"><label for="managed-email">Account email</label><input type="email" id="managed-email" autocomplete="username" value="${escapeHtml(drafts.managedEmail)}" /></div>
    <div class="field"><label for="managed-password">Account password</label><input type="password" id="managed-password" autocomplete="current-password" /></div>
    <div class="account-actions">
      <button type="button" class="primary" id="managed-sign-in">Sign in</button>
      <button type="button" class="secondary" id="managed-signup" disabled>Create an account</button>
    </div>
    <p class="test-result" id="managed-sign-in-result" role="status" aria-live="polite"></p>
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
    ${renderKeyField("deepgram", "Deepgram API key", "Transcription: live transcript updates")}
    ${renderKeyField("claude", "Claude API key", "Summary and action items after you stop")}
  `;
}

function renderBudgetTierFields(): string {
  return `
    ${renderKeyField("groq", "Groq API key", "Transcription in batches, so live updates are less immediate")}
    <div class="field">
      <label for="budget-summarizer">Summary provider</label>
      <select id="budget-summarizer">
        <option value="gemini" ${settings.summarizationProvider === "gemini" ? "selected" : ""}>Gemini Flash</option>
        <option value="deepseek" ${settings.summarizationProvider === "deepseek" ? "selected" : ""}>DeepSeek V4 Flash</option>
      </select>
    </div>
    ${renderKeyField(settings.summarizationProvider === "deepseek" ? "deepseek" : "gemini", `${settings.summarizationProvider === "deepseek" ? "DeepSeek" : "Gemini"} API key`, "Summary and action items after you stop")}
  `;
}

function advancedDetails(id: string, open: boolean, body: string): string {
  return `<details class="advanced" id="${id}" ${open ? "open" : ""}><summary>Advanced: your OAuth client</summary>${body}</details>`;
}

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
        <p class="field-hint text-secondary">A desktop notification around the start of the call. Choose Open call, then start notes from the Notetaker pill. Uses your calendar connection only; nothing leaves this device.</p>
      </div>`
          : ""
      }
    `;
  }

  const provider = pendingCalendarProvider;
  return `
    <div class="field">
      <label for="calendar-provider">Calendar</label>
      <select id="calendar-provider">
        <option value="none" ${provider === "none" ? "selected" : ""}>None</option>
        <option value="google" ${provider === "google" ? "selected" : ""}>Google Calendar</option>
        <option value="outlook" ${provider === "outlook" ? "selected" : ""}>Outlook Calendar</option>
      </select>
    </div>
    ${
      provider === "none"
        ? ""
        : `
      ${advancedDetails(
        "calendar-advanced",
        calendarAdvancedOpen,
        `
        <p class="field-hint text-secondary">
          Create the app once in
          ${
            provider === "google"
              ? `<a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">Google Cloud Console → Credentials</a> (enable the Calendar API, create an OAuth client, choose "Chrome extension" as the application type)`
              : `<a href="https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noreferrer">Azure Portal → App registrations</a> (add the Calendars.Read Microsoft Graph permission)`
          }.
        </p>
        <div class="field">
          <label for="calendar-client-id">Client ID</label>
          <input type="text" id="calendar-client-id" autocomplete="off" value="${escapeHtml(drafts.calendarClientId)}" />
        </div>
        ${
          provider === "google"
            ? `<div class="field">
          <label for="calendar-client-secret">Client secret</label>
          <input type="password" id="calendar-client-secret" autocomplete="off" value="${escapeHtml(drafts.calendarClientSecret)}" />
        </div>`
            : ""
        }
        <p class="field-hint text-secondary">Redirect URI to register: <code>${escapeHtml(chrome.identity.getRedirectURL())}</code></p>
      `,
      )}
      <div class="field">
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
    ${advancedDetails(
      "drive-advanced",
      driveAdvancedOpen,
      `
      <p class="field-hint text-secondary">
        Create your own OAuth client in <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">Google Cloud Console → Credentials</a>, enable the Google Drive API, and choose “Chrome extension”.
        This extension requests only the <code>drive.file</code> permission for files it creates.
      </p>
      <div class="field">
        <label for="drive-client-id">Google OAuth Client ID</label>
        <input type="text" id="drive-client-id" autocomplete="off" value="${escapeHtml(drafts.driveClientId)}" />
      </div>
      <div class="field">
        <label for="drive-client-secret">Client secret (if your OAuth client has one)</label>
        <input type="password" id="drive-client-secret" autocomplete="off" value="${escapeHtml(drafts.driveClientSecret)}" />
      </div>
      <p class="field-hint text-secondary">Redirect URI: <code>${escapeHtml(chrome.identity.getRedirectURL())}</code></p>
    `,
    )}
    <div class="field">
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
        <input type="password" id="key-${provider}" data-provider="${provider}" autocomplete="off" value="${escapeHtml(settings.apiKeys[provider] ?? "")}" aria-describedby="hint-${provider}" />
        <button type="button" class="secondary test-key" data-provider="${provider}">Test</button>
      </div>
      <p class="field-hint text-secondary" id="hint-${provider}">${hint}</p>
      <p class="test-result" id="test-result-${provider}" role="status" aria-live="polite"></p>
    </div>
  `;
}

function setResult(el: HTMLElement | null, message: string, kind: "valid" | "invalid" | "pending"): void {
  if (!el) return;
  el.textContent = message;
  el.className = kind === "pending" ? "test-result text-secondary" : `test-result ${kind}`;
}

function showWebappErrors(urlError?: string, tokenError?: string): void {
  for (const [inputId, errorId, message] of [
    ["webapp-url", "webapp-url-error", urlError],
    ["webapp-token", "webapp-token-error", tokenError],
  ] as const) {
    const input = document.getElementById(inputId);
    const error = document.getElementById(errorId);
    if (error) error.textContent = message ?? "";
    if (input) {
      if (message) input.setAttribute("aria-invalid", "true");
      else input.removeAttribute("aria-invalid");
    }
  }
}

function wireEvents(): void {
  const minutesInput = document.getElementById("meeting-minutes") as HTMLInputElement | null;
  const costEstimate = document.getElementById("cost-estimate");
  const updateCostEstimate = () => {
    if (!minutesInput || !costEstimate) return;
    const estimate = estimateMeetingCost(isBudgetTier(settings) ? "budget" : "default", Number(minutesInput.value));
    costEstimate.textContent = `About $${estimate.toFixed(2)} in provider fees. Your providers bill you directly; check current pricing before relying on this.`;
  };
  minutesInput?.addEventListener("input", updateCostEstimate);
  if (minutesInput) updateCostEstimate();

  for (const [id, setter] of [
    ["integrations", (open: boolean) => (integrationsOpen = open)],
    ["calendar-advanced", (open: boolean) => (calendarAdvancedOpen = open)],
    ["drive-advanced", (open: boolean) => (driveAdvancedOpen = open)],
  ] as const) {
    document.getElementById(id)?.addEventListener("toggle", (event) => setter((event.currentTarget as HTMLDetailsElement).open));
  }

  document.getElementById("mode-local")?.addEventListener("click", () => {
    readFormIntoSettings();
    settings = applyModeChoice(settings, false);
    managedSetupVisible = false;
    render({ focus: "mode-local" });
  });
  document.getElementById("mode-managed")?.addEventListener("click", () => {
    readFormIntoSettings();
    settings = applyModeChoice(settings, true);
    managedSetupVisible = true;
    render({ focus: "mode-managed" });
  });
  document.getElementById("managed-sign-out")?.addEventListener("click", async () => {
    const resultEl = document.getElementById("managed-sign-in-result");
    readFormIntoSettings();
    const previousUrl = settings.managedService?.baseUrl ?? "";
    settings = signOutOfHosted(settings);
    drafts.managedUrl = previousUrl;
    signedOutNotice = "Signed out. Your own API keys are used until you sign in again.";
    try {
      await chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings });
    } catch {
      setResult(resultEl, "Signed out here, but the change could not be saved. Press Save settings to finish.", "invalid");
      return;
    }
    render({ focus: "managed-url" });
  });
  document.getElementById("managed-sign-in")?.addEventListener("click", async () => {
    const resultEl = document.getElementById("managed-sign-in-result");
    const button = document.getElementById("managed-sign-in") as HTMLButtonElement;
    readFormIntoSettings();
    const baseUrl = drafts.managedUrl.trim();
    const email = drafts.managedEmail.trim();
    const password = inputValue("managed-password") ?? "";
    button.disabled = true;
    setResult(resultEl, "Signing in…", "pending");
    try {
      const result = await loginManaged(baseUrl, email, password);
      settings.managedService = result.config;
      settings = applyModeChoice(settings, true);
      managedSetupVisible = true;
      signedOutNotice = "";
      await chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings });
      render({ focus: "managed-sign-out" });
    } catch (error) {
      setResult(resultEl, error instanceof Error ? error.message : "Sign-in failed.", "invalid");
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
      void chrome.tabs.create({ url: managedSignupUrl(managedUrlInput?.value.trim() ?? "") });
    } catch (error) {
      setResult(document.getElementById("managed-sign-in-result"), error instanceof Error ? error.message : "Enter a valid service URL first.", "invalid");
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
    render({ focus: "tier-default" });
  });
  document.getElementById("tier-budget")?.addEventListener("click", () => {
    readFormIntoSettings();
    settings.transcriptionProvider = "groq";
    settings.summarizationProvider = settings.summarizationProvider === "claude" ? "gemini" : settings.summarizationProvider;
    render({ focus: "tier-budget" });
  });
  document.getElementById("budget-summarizer")?.addEventListener("change", () => {
    readFormIntoSettings();
    render({ focus: "budget-summarizer" });
  });

  for (const button of document.querySelectorAll<HTMLButtonElement>(".test-key")) {
    button.addEventListener("click", async () => {
      const provider = button.dataset.provider as ProviderKind;
      const input = document.getElementById(`key-${provider}`) as HTMLInputElement;
      const resultEl = document.getElementById(`test-result-${provider}`);
      button.disabled = true;
      setResult(resultEl, "Checking…", "pending");
      try {
        const result = await testApiKey(provider, input.value);
        setResult(resultEl, result.message, result.valid ? "valid" : "invalid");
      } catch {
        setResult(resultEl, "The helper could not test this key. Check that it is running and try again.", "invalid");
      } finally {
        button.disabled = false;
      }
    });
  }

  document.getElementById("calendar-provider")?.addEventListener("change", () => {
    readFormIntoSettings();
    pendingCalendarProvider = inputValue("calendar-provider") as typeof pendingCalendarProvider;
    render({ focus: "calendar-provider" });
  });

  document.getElementById("connect-calendar")?.addEventListener("click", async () => {
    const connectButton = document.getElementById("connect-calendar") as HTMLButtonElement;
    const resultEl = document.getElementById("calendar-test-result");
    captureDrafts();
    const clientId = drafts.calendarClientId.trim();
    const clientSecret = drafts.calendarClientSecret.trim();
    if (!clientId || pendingCalendarProvider === "none") {
      const advanced = document.getElementById("calendar-advanced") as HTMLDetailsElement | null;
      if (advanced) advanced.open = true;
      calendarAdvancedOpen = true;
      setResult(resultEl, "Enter your OAuth Client ID under Advanced first.", "invalid");
      document.getElementById("calendar-client-id")?.focus();
      return;
    }
    connectButton.disabled = true;
    setResult(resultEl, "Opening the sign-in window…", "pending");
    try {
      const provider = pendingCalendarProvider as "google" | "outlook";
      settings.calendar = await connectCalendar(provider, clientId, clientSecret || undefined);
      drafts.calendarClientId = "";
      drafts.calendarClientSecret = "";
      await chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings });
      render({ focus: "disconnect-calendar" });
    } catch {
      setResult(resultEl, "Could not connect. Check your Client ID/secret and redirect URI, then try again.", "invalid");
      connectButton.disabled = false;
    }
  });

  document.getElementById("disconnect-calendar")?.addEventListener("click", async () => {
    readFormIntoSettings();
    settings.calendar = null;
    pendingCalendarProvider = "none";
    await chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings });
    render({ focus: "calendar-provider" });
  });

  document.getElementById("connect-drive")?.addEventListener("click", async () => {
    const button = document.getElementById("connect-drive") as HTMLButtonElement;
    const resultEl = document.getElementById("drive-test-result");
    captureDrafts();
    const clientId = drafts.driveClientId.trim();
    const clientSecret = drafts.driveClientSecret.trim();
    if (!clientId) {
      const advanced = document.getElementById("drive-advanced") as HTMLDetailsElement | null;
      if (advanced) advanced.open = true;
      driveAdvancedOpen = true;
      setResult(resultEl, "Enter your Google OAuth Client ID under Advanced first.", "invalid");
      document.getElementById("drive-client-id")?.focus();
      return;
    }
    button.disabled = true;
    setResult(resultEl, "Opening Google sign-in…", "pending");
    try {
      settings.drive = await connectGoogleDrive(clientId, clientSecret || undefined);
      drafts.driveClientId = "";
      drafts.driveClientSecret = "";
      await chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings });
      render({ focus: "disconnect-drive" });
    } catch (error) {
      setResult(resultEl, error instanceof Error ? error.message : "Could not connect Google Drive. Check the OAuth client and redirect URI.", "invalid");
      button.disabled = false;
    }
  });

  document.getElementById("disconnect-drive")?.addEventListener("click", async () => {
    readFormIntoSettings();
    settings.drive = null;
    await chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings });
    render({ focus: "connect-drive" });
  });

  for (const id of ["webapp-url", "webapp-token"]) {
    document.getElementById(id)?.addEventListener("input", () => showWebappErrors());
  }

  document.getElementById("test-webapp")?.addEventListener("click", async () => {
    const testButton = document.getElementById("test-webapp") as HTMLButtonElement;
    const url = (inputValue("webapp-url") ?? "").trim();
    const resultEl = document.getElementById("webapp-test-result");
    if (!url) {
      showWebappErrors("Enter the webapp URL first.");
      document.getElementById("webapp-url")?.focus();
      return;
    }
    testButton.disabled = true;
    setResult(resultEl, "Checking…", "pending");
    try {
      const result = await testWebappHealth(url);
      setResult(resultEl, result.message, result.healthy ? "valid" : "invalid");
    } catch {
      setResult(resultEl, "The connection test failed unexpectedly. Check the URL and try again.", "invalid");
    } finally {
      testButton.disabled = false;
    }
  });

  document.getElementById("save-settings")?.addEventListener("click", async () => {
    const saveButton = document.getElementById("save-settings") as HTMLButtonElement;
    const statusEl = document.getElementById("save-status");
    readFormIntoSettings();
    // The webapp fields only exist in your-own-keys mode; in Hosted mode the
    // saved connection is left exactly as it was.
    if (!managedSetupVisible) {
      const check = validateWebappInputs(drafts.webappUrl, drafts.webappToken);
      showWebappErrors(check.urlError, check.tokenError);
      if (!check.ok) {
        const integrations = document.getElementById("integrations") as HTMLDetailsElement | null;
        if (integrations) integrations.open = true;
        integrationsOpen = true;
        setResult(statusEl, "Fix the highlighted webapp fields, then save again.", "invalid");
        document.getElementById(check.urlError ? "webapp-url" : "webapp-token")?.focus();
        return;
      }
      settings.webapp = check.webapp;
    }
    settings = applyModeChoice(settings, managedSetupVisible);
    saveButton.disabled = true;
    setResult(statusEl, "Saving…", "pending");
    try {
      await chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings });
      setResult(statusEl, "Saved.", "valid");
      setTimeout(() => {
        if (statusEl?.textContent === "Saved.") setResult(statusEl, "", "pending");
      }, 2000);
    } catch {
      setResult(statusEl, "Could not save settings. Reopen the extension and try again.", "invalid");
    } finally {
      saveButton.disabled = false;
    }
  });
}

async function init(): Promise<void> {
  // getSettings() can hand back the shared DEFAULT_SETTINGS object; this page
  // mutates `settings` as the user types, so it must work on its own copy.
  settings = structuredClone(await getSettings());
  managedSetupVisible = isHostedActive(settings);
  pendingCalendarProvider = settings.calendar?.provider ?? "none";
  drafts = emptyDrafts();
  drafts.webappUrl = settings.webapp?.url ?? "";
  drafts.webappToken = settings.webapp?.token ?? "";
  drafts.managedUrl = settings.managedService?.baseUrl ?? "";
  render();
}

function renderFailure(): void {
  app.innerHTML = `
    <h1 tabindex="-1" data-view-heading>Settings</h1>
    <div class="empty-state error-state" role="alert">
      <p>Settings could not be loaded.</p>
      <button type="button" class="primary" id="retry-settings">Try again</button>
    </div>
  `;
  document.getElementById("retry-settings")?.addEventListener("click", () => void init().catch(renderFailure));
}

void init().catch(renderFailure);
