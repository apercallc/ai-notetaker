import { normalizeWebappUrl } from "../lib/providerTest";
import type { NotetakerSettings, WebappConfig } from "../types";

/**
 * User-facing names for the two processing modes. "BYOK" and "managed" are
 * internal vocabulary (settings keys, the helper protocol) and must not appear
 * in copy; every surface in settings uses these two labels instead.
 */
export const MODE_LABEL_OWN_KEYS = "Your own API keys (free)";
export const MODE_LABEL_HOSTED = "Hosted (paid)";

/** Whether the saved settings mean Hosted is the active mode, i.e. what the page should open on. */
export function isHostedActive(settings: Pick<NotetakerSettings, "processingMode">): boolean {
  return settings.processingMode.kind === "managed";
}

/** A signed-in hosted session exists (independent of which mode is currently selected). */
export function hasHostedSession(settings: Pick<NotetakerSettings, "managedService">): boolean {
  return Boolean(settings.managedService?.accessToken && settings.managedService.accountId);
}

/**
 * Selecting a mode never signs the user out. Choosing Hosted with a session
 * restores the hosted processing mode from it; choosing your own keys leaves
 * the session in place so switching back is one click.
 */
export function applyModeChoice(settings: NotetakerSettings, hosted: boolean): NotetakerSettings {
  if (hosted && settings.managedService && hasHostedSession(settings)) {
    const { accountId, workspaceId, plan } = settings.managedService;
    return { ...settings, processingMode: { kind: "managed", accountId, workspaceId, plan } };
  }
  if (!hosted) return { ...settings, processingMode: { kind: "local_byok" } };
  return settings;
}

/** Sign-out is its own action: it drops the session and falls back to the user's own keys. */
export function signOutOfHosted(settings: NotetakerSettings): NotetakerSettings {
  return { ...settings, processingMode: { kind: "local_byok" }, managedService: null };
}

export interface WebappValidation {
  ok: boolean;
  webapp: WebappConfig | null;
  urlError?: string;
  tokenError?: string;
}

/**
 * Both blank clears the connection. A half-filled pair is an error shown next
 * to the missing field, not a silent reset that discards what the user typed.
 */
export function validateWebappInputs(rawUrl: string, rawToken: string): WebappValidation {
  const url = rawUrl.trim();
  const token = rawToken.trim();
  if (!url && !token) return { ok: true, webapp: null };
  if (!url) return { ok: false, webapp: null, urlError: "Enter the webapp URL, or clear the access token to disconnect." };
  if (!token) return { ok: false, webapp: null, tokenError: "Enter the access token, or clear the URL to disconnect." };
  if (!normalizeWebappUrl(url)) {
    return { ok: false, webapp: null, urlError: "Use an HTTPS URL with no path (HTTP is allowed only for localhost)." };
  }
  return { ok: true, webapp: { url, token } };
}
