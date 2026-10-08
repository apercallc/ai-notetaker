import { getSettings, listMeetings } from "../lib/storage";
import { saveDesktopAudioArchive } from "../lib/desktopMigration";
import { escapeHtml } from "../lib/html";
import { sendToBackground } from "../lib/sendToBackground";

const app = document.getElementById("app")!;

async function render(): Promise<void> {
  const settings = await getSettings();
  app.innerHTML = `
    <header class="settings-header"><h1>Browser meeting recorder</h1><p>Capture a meeting playing in the current Chrome tab, including Google Meet, Zoom, Teams, Slack, and Discord web. Your microphone and tab audio stay on separate local tracks.</p></header>
    <section class="settings-section">
      <h2>Recording</h2>
      <label><input id="show-widget" type="checkbox" ${settings.showMeetWidget ? "checked" : ""} /> Show recording controls in Meet, Teams, Zoom, Discord, and Slack</label>
      <label><input id="auto-record" type="checkbox" ${settings.autoRecordOnMeetJoin ? "checked" : ""} /> Start recording when I join a Google Meet call</label>
      <p class="field-hint">Use the floating control on supported meeting sites. If Chrome asks, click the toolbar icon or use the recording shortcut to enable tab audio. Other secure tabs use the popup or shortcut.</p>
      <p class="field-hint">Tell everyone before recording. Chrome may ask for microphone access when capture starts.</p>
      <button class="primary" id="save-settings">Save recording settings</button>
      <p id="save-status" role="status" aria-live="polite"></p>
    </section>
    <section class="settings-section">
      <h2>Make notes in the desktop app</h2>
      <p>Export saved browser audio and older notes as one archive. In the desktop app, open Settings → Import from the extension to transcribe new recordings. The archive is copied; your original stays in Chrome.</p>
      <button class="primary" id="export-archive">Save full archive</button>
      <p id="archive-status" role="status" aria-live="polite"></p>
    </section>
    <section class="settings-section">
      <h2>Earlier extension data</h2>
      <p>Earlier notes, provider settings, and recovery controls remain available here. Desktop provider settings and cloud sync (sign in) are managed in the desktop app.</p>
      <button class="secondary" id="open-previous-settings">Open previous settings</button>
    </section>`;

  document.getElementById("save-settings")?.addEventListener("click", async () => {
    const status = document.getElementById("save-status")!;
    try {
      const latest = await getSettings();
      latest.showMeetWidget = (document.getElementById("show-widget") as HTMLInputElement).checked;
      latest.autoRecordOnMeetJoin = (document.getElementById("auto-record") as HTMLInputElement).checked;
      await sendToBackground({ type: "SAVE_SETTINGS", settings: latest });
      status.textContent = "Recording settings saved.";
    } catch (error) {
      status.textContent = `Could not save settings: ${String(error)}`;
    }
  });
  document.getElementById("export-archive")?.addEventListener("click", async () => {
    const button = document.getElementById("export-archive") as HTMLButtonElement;
    const status = document.getElementById("archive-status")!;
    button.disabled = true;
    status.textContent = "Choose where to save the archive…";
    try {
      // Settings load is passed as a pending promise so the save picker opens
      // within the click's user activation.
      const result = await saveDesktopAudioArchive(getSettings(), listMeetings);
      status.textContent = `Saved ${result.meetingCount} meeting records and ${(result.audioBytes / 1024 / 1024).toFixed(1)} MB of audio. Chrome data is unchanged.${result.adjustments?.length ? ` Note: ${result.adjustments.join(" ")}` : ""}`;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        status.textContent = "Archive export cancelled. Your extension data is unchanged.";
      } else {
        status.innerHTML = `Archive was not saved: ${escapeHtml(error instanceof Error ? error.message : String(error))}`;
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
  app.textContent = `Settings could not open: ${String(error)}`;
});
