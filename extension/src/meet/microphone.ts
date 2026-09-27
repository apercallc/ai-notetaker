/**
 * One-time microphone grant. Chrome ties the permission to the extension's
 * origin and cannot show its prompt inside the hidden offscreen capture page,
 * so it is requested here, on a normal tab, and stays granted afterwards.
 */
import { escapeHtml } from "../lib/html";
import { requestMicrophone, type MicOutcome } from "./micPermission";

const app = document.getElementById("app")!;

/** The Meet tab that sent the person here, when they came from the in-call widget. */
function returnTabId(): number | null {
  const value = new URLSearchParams(window.location.search).get("returnTo");
  const id = value === null ? NaN : Number(value);
  return Number.isInteger(id) && id >= 0 ? id : null;
}

/**
 * After a grant, put the person back in their call and get out of the way.
 * Returns false (and leaves this tab open with instructions) when the call tab
 * is gone or Chrome will not switch to it.
 */
export async function returnToCall(): Promise<boolean> {
  const tabId = returnTabId();
  if (tabId === null) return false;
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (typeof tab?.windowId === "number") await chrome.windows?.update(tab.windowId, { focused: true });
    const current = await chrome.tabs.getCurrent();
    if (typeof current?.id !== "number") return false;
    await chrome.tabs.remove(current.id);
    return true;
  } catch {
    return false;
  }
}

type Outcome = MicOutcome;

export { requestMicrophone };

function render(outcome: Outcome | "asking"): void {
  const copy = {
    asking: {
      title: "Allow your microphone",
      body: "Chrome is asking for permission. Choose <strong>Allow</strong> so Notetaker can hear you in Google Meet. Your microphone is only used while you are taking notes.",
      action: false,
    },
    granted: {
      title: "Microphone allowed",
      body: "You're set. Close this tab, go back to your Meet call, and start notes. You won't be asked again.",
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
  const outcome = await requestMicrophone();
  render(outcome);
  if (outcome === "granted") await returnToCall();
}

void run();
