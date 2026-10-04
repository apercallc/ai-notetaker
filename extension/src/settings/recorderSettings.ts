import { getSettings, listMeetings } from "../lib/storage";
import { saveDesktopAudioArchive } from "../lib/desktopMigration";
import { escapeHtml } from "../lib/html";
import { sendToBackground } from "../lib/sendToBackground";

const app = document.getElementById("app")!;

async function render(): Promise<void> {
  const settings = await getSettings();
  app.innerHTML = `
    <header class="settings-header"><h1>Google Meet recorder</h1><p>Record Meet audio in Chrome. Your microphone and the call stay on separate local tracks.</p></header>
    <section class="settings-section">
      <h2>Recording</h2>
      <label><input id="show-widget" type="checkbox" ${settings.showMeetWidget ? "checked" : ""} /> Show the recording control in Google Meet</label>
      <label><input id="auto-record" type="checkbox" ${settings.autoRecordOnMeetJoin ? "checked" : ""} /> Start recording when I join a Meet call</label>
      <p class="field-hint">Tell everyone before recording. Chrome may ask for microphone access when capture starts.</p>
      <button class="primary" id="save-settings">Save recording settings</button>
      <p id="save-status" role="status" aria-live="polite"></p>
    </section>
    <section class="settings-section">
      <h2>Move recordings to the desktop app</h2>
      <p>Export your saved Meet audio and older notes as one archive. The source remains in Chrome. In the desktop app, open Settings → Import from the extension.</p>
      <button class="primary" id="export-archive">Save full archive</button>
      <p id="archive-status" role="status" aria-live="polite"></p>
    </section>
    <section class="settings-section">
      <h2>Earlier extension data</h2>
      <p>Older notes, provider settings, and recovery controls remain available while you move to the desktop app.</p>
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
      const result = await saveDesktopAudioArchive(await getSettings(), listMeetings);
      status.textContent = `Saved ${result.meetingCount} meeting records and ${(result.audioBytes / 1024 / 1024).toFixed(1)} MB of audio. Chrome data is unchanged.`;
    } catch (error) {
      status.innerHTML = `Archive was not saved: ${escapeHtml(String(error))}`;
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
