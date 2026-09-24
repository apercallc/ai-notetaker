import type { UiToBackgroundMessage } from "./internalMessages";
import { isMeetUrl } from "../meet/meetContext";

/** The only requests the Google Meet content script may make; everything else needs an extension page. */
const CONTENT_SCRIPT_MESSAGES = new Set<UiToBackgroundMessage["type"]>([
  "GET_WIDGET_STATE",
  "SAVE_WIDGET_POSITION",
  "CHECK_HELPER",
  "START_RECORDING",
  "STOP_RECORDING",
  "ADD_BOOKMARK",
  "OPEN_PAGE",
  "OPEN_MEETING",
]);

export interface SenderLike {
  id?: string;
  url?: string;
  tab?: unknown;
}

export interface SenderPolicyContext {
  extensionId: string;
  extensionBaseUrl: string;
  offscreenUrl: string;
}

export type SenderKind = "extension-page" | "meet-content-script" | "offscreen" | "untrusted";

export function classifySender(sender: SenderLike, context: SenderPolicyContext): SenderKind {
  if (sender.id !== context.extensionId) return "untrusted";
  const url = sender.url ?? "";
  if (url === context.offscreenUrl) return "offscreen";
  if (url.startsWith(context.extensionBaseUrl)) return "extension-page";
  if (sender.tab !== undefined && isMeetUrl(url)) return "meet-content-script";
  return "untrusted";
}

/**
 * A page-side sender never picks the capture tab or the capture mode: it is
 * always its own tab, always Meet. Extension pages (the popup) may choose.
 */
export function resolveStartRequest(
  message: Extract<UiToBackgroundMessage, { type: "START_RECORDING" }>,
  kind: SenderKind,
  senderTabId: number | undefined,
): { captureSource: "desktop" | "meet"; tabId: number | undefined } {
  if (kind === "meet-content-script") return { captureSource: "meet", tabId: senderTabId };
  return { captureSource: message.captureSource ?? "desktop", tabId: message.tabId ?? senderTabId };
}

/** The offscreen capture page only takes orders from this extension's own worker. */
export function isFromExtensionWorker(sender: SenderLike, context: Pick<SenderPolicyContext, "extensionId" | "extensionBaseUrl">): boolean {
  return sender.id === context.extensionId && sender.tab === undefined && (sender.url ?? "").startsWith(context.extensionBaseUrl);
}

export function isMessageAllowed(type: UiToBackgroundMessage["type"], kind: SenderKind): boolean {
  switch (kind) {
    case "extension-page":
      return type !== "MEET_AUDIO_CHUNK";
    case "offscreen":
      return type === "MEET_AUDIO_CHUNK";
    case "meet-content-script":
      return CONTENT_SCRIPT_MESSAGES.has(type);
    default:
      return false;
  }
}
