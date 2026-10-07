import { getSettings } from "../lib/storage";
import { sendToBackground } from "../lib/sendToBackground";
import { microphoneAlreadyAllowed, requestMicrophone } from "../meet/micPermission";
import { escapeHtml } from "../lib/html";
import { getInstallPageUrl } from "../lib/install";

const app = document.getElementById("app")!;
let microphoneReady = false;
let consent = false;
let message = "";
let busy = false;

function render(): void {
  app.removeAttribute("aria-busy");
  app.innerHTML = `
    <div class="brand-lockup"><img src="../icons/icon48.png" alt="" aria-hidden="true" /><span>AI Notetaker</span></div>
    <h1>Set up browser meeting recording</h1>
    <p>The extension saves your microphone and meeting-tab audio as separate tracks in Chrome. Use the desktop app to turn an exported archive into notes.</p>
    <section class="step-content">
      <h2>1. Allow microphone access</h2>
      <p>Chrome will ask for access. Meeting audio is captured from the active browser tab.</p>
      <button class="secondary" id="allow-microphone" ${busy ? "disabled" : ""}>${microphoneReady ? "Microphone ready" : "Allow microphone"}</button>
      <h2>2. Confirm recording consent</h2>
      <label class="consent"><input type="checkbox" id="recording-consent" ${consent ? "checked" : ""} /> I will tell everyone on the call before recording.</label>
      <p class="text-secondary">Recording is visible in the extension popup. A floating control is available in Meet, Teams, Zoom web, Discord, and Slack. Use this for Meet, Zoom, Teams, Slack, Discord, and other meetings playing in Chrome. Audio stays on this device until you export it.</p>
      <button class="primary" id="finish-setup" ${microphoneReady && consent && !busy ? "" : "disabled"}>Finish setup</button>
      <p id="setup-status" role="status" aria-live="polite">${escapeHtml(message)}</p>
    </section>`;
  document.getElementById("recording-consent")?.addEventListener("change", (event) => {
    consent = (event.currentTarget as HTMLInputElement).checked;
    (document.getElementById("finish-setup") as HTMLButtonElement).disabled = !microphoneReady || !consent || busy;
  });
  document.getElementById("allow-microphone")?.addEventListener("click", async () => {
    busy = true;
    render();
    const outcome = await requestMicrophone();
    microphoneReady = outcome === "granted";
    message = outcome === "granted" ? "Microphone ready." : outcome === "no-device" ? "Connect a microphone and try again." : outcome === "in-use" ? "Close the app using your microphone and try again." : "Allow microphone access in Chrome and try again.";
    busy = false;
    render();
  });
  document.getElementById("finish-setup")?.addEventListener("click", async () => {
    if (!microphoneReady || !consent || busy) return;
    busy = true;
    render();
    try {
      const settings = await getSettings();
      await sendToBackground({ type: "SAVE_SETTINGS", settings: { ...settings, onboardingComplete: true, consentDisclosureAcknowledged: true, processingMode: { kind: "local_byok" } } });
      app.innerHTML = '<div class="brand-lockup"><img src="../icons/icon48.png" alt="" aria-hidden="true" /><span>AI Notetaker</span></div><h1>Ready to record</h1><p>Open a meeting in Chrome, tell everyone, then choose Start recording in the extension popup or use the shortcut. Meet, Zoom, Teams, Slack, Discord web, and other meeting tabs are supported. Use the floating control on supported meeting sites. If Chrome asks, click the extension toolbar icon to allow this tab’s audio.</p><p>After the call, export the saved audio from extension Settings and import it in the desktop app to make notes.</p><div class="setup-actions"><button class="primary" id="done-setup">Done</button><button class="secondary" id="open-meet">Open Google Meet</button><button class="secondary" id="get-desktop">Get the desktop app</button></div>';
      document.getElementById("done-setup")?.addEventListener("click", () => void chrome.tabs.getCurrent().then((tab) => tab?.id !== undefined ? chrome.tabs.remove(tab.id) : undefined));
      document.getElementById("get-desktop")?.addEventListener("click", () => void chrome.tabs.create({ url: getInstallPageUrl("onboarding") }));
      document.getElementById("open-meet")?.addEventListener("click", () => void chrome.tabs.create({ url: "https://meet.google.com/" }));
    } catch (error) {
      message = `Setup could not be saved: ${String(error)}`;
      busy = false;
      render();
    }
  });
}

void (async () => {
  const settings = await getSettings();
  consent = settings.consentDisclosureAcknowledged;
  microphoneReady = await microphoneAlreadyAllowed();
  render();
})().catch((error) => {
  app.textContent = `Setup could not open: ${String(error)}`;
});
