import type { ProviderKind } from "../types";

const PROVIDER_ORIGINS: Record<ProviderKind, string> = {
  deepgram: "https://api.deepgram.com/*",
  groq: "https://api.groq.com/*",
  claude: "https://api.anthropic.com/*",
  gemini: "https://generativelanguage.googleapis.com/*",
  deepseek: "https://api.deepseek.com/*",
};

export type OptionalPermissionRequest = chrome.permissions.Permissions;

/** Check a declared optional permission without prompting the user. */
export async function hasOptionalPermission(request: OptionalPermissionRequest): Promise<boolean> {
  if (!chrome.permissions?.contains) return false;
  return chrome.permissions.contains(request);
}

/**
 * Request a declared permission. Call only from a visible, meaningful user
 * action because Chrome requires a user gesture for permissions.request().
 * A denied request is reported as false; API errors propagate to the UI.
 */
export async function requestOptionalPermission(request: OptionalPermissionRequest): Promise<boolean> {
  // Invoke request before the first await so the browser observes the original
  // click's transient user activation. Chrome resolves already-granted
  // requests to true without showing a second prompt.
  if (chrome.permissions?.request) return chrome.permissions.request(request);
  return hasOptionalPermission(request);
}

export function providerHostPermission(provider: ProviderKind): OptionalPermissionRequest {
  return { origins: [PROVIDER_ORIGINS[provider]] };
}

export function providerHostPermissions(providers: readonly ProviderKind[]): OptionalPermissionRequest {
  return { origins: [...new Set(providers.map((provider) => PROVIDER_ORIGINS[provider]))] };
}

export function providerPermissionName(provider: ProviderKind): string {
  const names: Record<ProviderKind, string> = {
    deepgram: "Deepgram",
    groq: "Groq",
    claude: "Anthropic",
    gemini: "Gemini",
    deepseek: "DeepSeek",
  };
  return names[provider];
}

export async function requestDesktopHelperPermissions(): Promise<{ nativeMessaging: boolean; alarms: boolean }> {
  // The retry alarm is part of the desktop helper's recovery contract. Ask
  // for both only after the user chooses the desktop helper feature.
  const requestAccepted = await requestOptionalPermission({ permissions: ["nativeMessaging", "alarms"] });
  if (requestAccepted) return { nativeMessaging: true, alarms: true };
  const [nativeMessaging, alarms] = await Promise.all([
    hasOptionalPermission({ permissions: ["nativeMessaging"] }),
    hasOptionalPermission({ permissions: ["alarms"] }),
  ]);
  return { nativeMessaging, alarms };
}

export async function requestLegacyGoogleIdentityPermission(): Promise<boolean> {
  return requestOptionalPermission({ permissions: ["identity"] });
}
