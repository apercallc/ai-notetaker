/**
 * One-time microphone grant. Chrome ties the permission to the extension's
 * origin and cannot show its prompt inside the hidden offscreen capture page,
 * so it is requested here, on a normal tab, and stays granted afterwards.
 */
import { escapeHtml } from "../lib/html";

const app = document.getElementById("app")!;

type Outcome = "granted" | "blocked" | "no-device";

export async function requestMicrophone(): Promise<Outcome> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    return "granted";
  } catch (error) {
    return error instanceof DOMException && error.name === "NotFoundError" ? "no-device" : "blocked";
  }
}

function render(outcome: Outcome | "asking"): void {
  const copy = {
    asking: {
      title: "Allow your microphone",
      body: "Chrome is asking for permission. Choose <strong>Allow</strong> so Notetaker can hear you in Google Meet. Audio is saved on this device and sent only to the transcription provider you chose.",
      action: false,
    },
    granted: {
      title: "Microphone allowed",
      body: "You're set. Close this tab, go back to your Meet call, and start taking notes. You won't be asked again.",
      action: false,
    },
    blocked: {
      title: "Chrome blocked the microphone",
      body: "Click the site-settings icon at the left of the address bar, set Microphone to <strong>Allow</strong>, then try again.",
      action: true,
    },
    "no-device": {
      title: "No microphone found",
      body: "Connect or enable a microphone, then try again.",
      action: true,
    },
  }[outcome];
  app.innerHTML = `
    <h1 tabindex="-1" id="heading">${escapeHtml(copy.title)}</h1>
    <p role="status">${copy.body}</p>
    ${copy.action ? `<div><button type="button" class="primary" id="retry">Try again</button></div>` : ""}
  `;
  document.getElementById("retry")?.addEventListener("click", () => void run());
  document.getElementById("heading")?.focus();
}

async function run(): Promise<void> {
  render("asking");
  render(await requestMicrophone());
}

void run();
