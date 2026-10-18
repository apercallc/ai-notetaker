import { getSettings, listMeetings } from "../lib/storage";
import { saveDesktopAudioArchive } from "../lib/desktopMigration";
import { escapeHtml } from "../lib/html";
import { sendToBackground } from "../lib/sendToBackground";

const app = document.getElementById("app")!;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Status lines carry a glyph and color (see theme.css), so success and failure never rely on color alone. */
function setStatus(element: HTMLElement, text: string, tone: "valid" | "invalid" | "neutral" = "neutral"): void {
  element.className = tone === "neutral" ? "test-result" : `test-result ${tone}`;
  element.textContent = text;
}

async function render(): Promise<void> {
  const settings = await getSettings();
  app.innerHTML = `
    <header class="settings-header"><h1>Browser meeting recorder</h1><p>Capture a meeting playing in the current Chrome tab, including Google Meet, Zoom, Teams, Slack, and Discord web. Your microphone and tab audio stay on separate local tracks.</p></header>
    <section class="settings-section">
      <h2>Recording</h2>
      <label><input id="show-widget" type="checkbox" ${settings.showMeetWidget ? "checked" : ""} /> Show recording controls in Meet, Teams, Zoom, Discord, and Slack</label>
      <label><input id="auto-record" type="checkbox" ${settings.autoRecordOnMeetJoin ? "checked" : ""} /> Start recording when I join a Google Meet call</label>
      <p class="field-hint">On other secure meeting tabs, start from the toolbar popup or your keyboard shortcut. If Chrome asks, click the extension’s toolbar icon to allow the tab’s audio.</p>
      <p class="field-hint">Tell everyone before you record. Chrome may ask for microphone access the first time.</p>
      <button type="button" class="primary" id="save-settings">Save recording settings</button>
      <p class="test-result" id="save-status" role="status" aria-live="polite"></p>
    </section>
    <section class="settings-section">
      <h2>Make notes in the desktop app</h2>
      <p>Export saved browser audio and older notes as one archive. In the desktop app, open Settings → Import from the extension to transcribe new recordings. The archive is copied; your original stays in Chrome.</p>
      <button type="button" class="primary" id="export-archive">Save full archive</button>
      <p class="test-result" id="archive-status" role="status" aria-live="polite"></p>
    </section>
    <section class="settings-section">
      <h2>Earlier extension data</h2>
      <p>Earlier notes, provider settings, and recovery controls remain available here. Desktop provider settings and cloud sync (sign in) are managed in the desktop app.</p>
      <button type="button" class="secondary" id="open-previous-settings">Open previous settings</button>
    </section>`;

  document.getElementById("save-settings")?.addEventListener("click", async () => {
    const status = document.getElementById("save-status")!;
    const button = document.getElementById("save-settings") as HTMLButtonElement;
    button.disabled = true;
    setStatus(status, "");
    try {
      const latest = await getSettings();
      latest.showMeetWidget = (document.getElementById("show-widget") as HTMLInputElement).checked;
      latest.autoRecordOnMeetJoin = (document.getElementById("auto-record") as HTMLInputElement).checked;
      await sendToBackground({ type: "SAVE_SETTINGS", settings: latest });
      setStatus(status, "Recording settings saved.", "valid");
    } catch (error) {
      setStatus(status, `Settings weren’t saved: ${errorText(error)}`, "invalid");
    } finally {
      button.disabled = false;
    }
  });
  document.getElementById("export-archive")?.addEventListener("click", async () => {
    const button = document.getElementById("export-archive") as HTMLButtonElement;
    const status = document.getElementById("archive-status")!;
    button.disabled = true;
    setStatus(status, "Choose where to save the archive…");
    try {
      // Settings load is passed as a pending promise so the save picker opens
      // within the click's user activation.
      const result = await saveDesktopAudioArchive(getSettings(), listMeetings, undefined, {
        // A large archive takes minutes to write; never leave "Choose where to save" on screen meanwhile.
        onProgress: (written, total) => {
          status.textContent = `Saving archive… ${(written / 1024 / 1024).toFixed(1)} of ${(total / 1024 / 1024).toFixed(1)} MB of audio. Keep this tab open.`;
        },
      });
      setStatus(status, `Saved ${result.meetingCount} meeting records and ${(result.audioBytes / 1024 / 1024).toFixed(1)} MB of audio. Chrome data is unchanged.${result.adjustments?.length ? ` Note: ${result.adjustments.join(" ")}` : ""}`, "valid");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setStatus(status, "Archive export cancelled. Your extension data is unchanged.");
      } else {
        setStatus(status, `Archive was not saved: ${errorText(error)}`, "invalid");
      }
    } finally {
      button.disabled = false;
    }
  });
  document.getElementById("open-previous-settings")?.addEventListener("click", () => {
    void chrome.tabs.create({ url: chrome.runtime.getURL("settings/legacy.html") });
  });
}

void render().catch((error) => {
  app.innerHTML = `<p class="error-state" role="alert">Settings couldn’t open: ${escapeHtml(errorText(error))}. Reload this page to try again.</p>`;
});
