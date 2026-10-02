import type { ManagedEntitlements } from "../types";

export const HOSTED_QUOTA_NOTIFICATION_ID = "hosted-quota-low";

export function isHostedQuotaExhaustion(message: string): boolean {
  return /plan has no hosted processing left|hosted meeting hours left|managed processing entitlement is unavailable|managed audio hours are exhausted/iu.test(message);
}

/** Persistent browser-level heads-up for a low Hosted allowance. */
export function notifyHostedQuotaLow(entitlements: ManagedEntitlements): void {
  if (!chrome.notifications || (entitlements.warning !== "low" && entitlements.audio.warning !== "low")) return;
  const hours = Math.floor(entitlements.audio.remainingSeconds / 3600);
  const minutes = Math.floor((entitlements.audio.remainingSeconds % 3600) / 60);
  const audio = hours > 0 ? `${hours}h ${minutes}m audio` : minutes > 0 ? `${minutes}m audio` : "less than 1m audio";
  chrome.notifications.create(HOSTED_QUOTA_NOTIFICATION_ID, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: "Hosted AI allowance is running low",
    message: `${entitlements.remaining} ${entitlements.remaining === 1 ? "meeting" : "meetings"} and ${audio} remain. Your recording stays on this device if Hosted processing becomes unavailable.`,
    buttons: [{ title: "Review settings" }],
    priority: 1,
  });
}

/** Alert if a shared workspace uses its remaining allowance during a call. */
export function notifyHostedQuotaExhausted(): void {
  if (!chrome.notifications) return;
  chrome.notifications.create(HOSTED_QUOTA_NOTIFICATION_ID, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: "Hosted AI allowance is exhausted",
    message: "Your recording is saved on this device. It was not switched to your API keys. Review your plan or choose your own keys for future meetings in Settings.",
    buttons: [{ title: "Review settings" }],
    priority: 2,
  });
}

/** Open extension settings from the low-quota notification. */
export async function openHostedQuotaNotice(notificationId: string): Promise<boolean> {
  if (notificationId !== HOSTED_QUOTA_NOTIFICATION_ID) return false;
  chrome.notifications?.clear(notificationId);
  await chrome.runtime.openOptionsPage();
  return true;
}
