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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function render(): void {
  app.removeAttribute("aria-busy");
  // Re-rendering replaces the controls; keep keyboard focus on the one that was used.
  const focusedId = app.contains(document.activeElement) ? (document.activeElement as HTMLElement).id : "";
  app.innerHTML = `
    <div class="brand-lockup"><img src="../icons/icon48.png" alt="" aria-hidden="true" /><span>AI Notetaker</span></div>
    <h1>Set up browser meeting recording</h1>
    <p>The extension saves your microphone and the meeting’s audio as separate tracks, on this computer. The desktop app turns them into notes.</p>
    <section class="step-content">
      <h2>1. Allow microphone access</h2>
      <p>Chrome will ask once. The meeting’s audio comes from the browser tab you record.</p>
      <button type="button" class="secondary" id="allow-microphone" ${busy || microphoneReady ? "disabled" : ""}>${microphoneReady ? "Microphone ready" : "Allow microphone"}</button>
      <h2>2. Confirm recording consent</h2>
      <label class="consent"><input type="checkbox" id="recording-consent" ${consent ? "checked" : ""} /> I will tell everyone on the call before recording.</label>
      <p class="text-secondary">Start from the extension’s toolbar popup, or from the floating control in Meet, Teams, Zoom, Discord, and Slack. Audio stays on this computer until you export it.</p>
      <button type="button" class="primary" id="finish-setup" ${microphoneReady && consent && !busy ? "" : "disabled"}>Finish setup</button>
      <p id="setup-status" role="status" aria-live="polite">${escapeHtml(message)}</p>
    </section>`;
  const restored = focusedId ? document.getElementById(focusedId) : null;
  // A control that just became disabled cannot hold focus; move on to the next step instead.
  if (restored && !(restored as HTMLButtonElement).disabled) restored.focus();
  else if (focusedId === "allow-microphone") document.getElementById("recording-consent")?.focus();
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
      app.innerHTML = '<div class="brand-lockup"><img src="../icons/icon48.png" alt="" aria-hidden="true" /><span>AI Notetaker</span></div><h1 id="ready-heading" tabindex="-1">Ready to record</h1><p>Open a meeting in Chrome and tell everyone you’re recording. Then choose Start recording in the toolbar popup, the floating control, or your keyboard shortcut. If Chrome asks, click the extension’s toolbar icon to allow the tab’s audio.</p><p>After the call, export the saved audio from extension Settings and import it in the desktop app to make notes.</p><div class="setup-actions"><button type="button" class="primary" id="done-setup">Done</button><button type="button" class="secondary" id="open-meet">Open Google Meet</button><button type="button" class="secondary" id="get-desktop">Get the desktop app</button></div>';
      // Move focus to the new screen so keyboard and screen-reader users land on it.
      document.getElementById("ready-heading")?.focus();
      document.getElementById("done-setup")?.addEventListener("click", () => void chrome.tabs.getCurrent().then((tab) => tab?.id !== undefined ? chrome.tabs.remove(tab.id) : undefined));
      document.getElementById("get-desktop")?.addEventListener("click", () => void chrome.tabs.create({ url: getInstallPageUrl("onboarding") }));
      document.getElementById("open-meet")?.addEventListener("click", () => void chrome.tabs.create({ url: "https://meet.google.com/" }));
    } catch (error) {
      message = `Setup couldn’t be saved: ${errorText(error)}. Try again.`;
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
  app.removeAttribute("aria-busy");
  app.innerHTML = `<p class="error-state" role="alert">Setup couldn’t open: ${escapeHtml(errorText(error))}. Reload this page to try again.</p>`;
});
