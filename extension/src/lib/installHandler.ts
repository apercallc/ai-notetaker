import { getExtensionOnboardingUrl } from "./install";

/**
 * First install goes straight to setup: nothing works until AI is chosen and the
 * microphone is allowed, so make the toolbar icon's first job unnecessary.
 * An update instead replaces any wizard tab that is still open with the
 * canonical Meet-first URL; reloading an older helper-first tab is not enough
 * because Chrome preserves its old `mode=desktop` query string.
 */
export async function handleInstalled(details: { reason: string }): Promise<void> {
  const base = chrome.runtime.getURL("");
  if (details.reason === "install") {
    await chrome.tabs.create({ url: getExtensionOnboardingUrl(base, "meet") });
    return;
  }
  if (details.reason !== "update") return;
  const onboardingUrl = chrome.runtime.getURL("onboarding/onboarding.html");
  const meetFirstUrl = getExtensionOnboardingUrl(base, "meet");
  const tabs = await chrome.tabs.query({ url: `${onboardingUrl}*` });
  await Promise.all(tabs.flatMap((tab) => (typeof tab.id === "number" ? [chrome.tabs.update(tab.id, { url: meetFirstUrl })] : [])));
}
