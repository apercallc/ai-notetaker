/**
 * "Test this API key", shared by onboarding and settings.
 *
 * The extension holds provider keys in its own chrome.storage.local and can
 * reach every provider directly (host permissions already cover these
 * hosts), so every "test key" runs as a minimal authenticated request
 * straight from the extension — onboarding included. The desktop helper
 * receives the same keys verbatim via the settings push, so testing from
 * the extension proves the key to the party that will actually use it;
 * routing the check through the helper instead made a not-yet-installed
 * helper a hard blocker for finishing setup, for no validation benefit.
 * The helper keeps its own test_provider_key for its tray/CLI surfaces.
 */
import type { ProviderKind } from "../types";

export interface KeyTestResult {
  valid: boolean;
  message: string;
}

export interface KeyTestOptions {
  /** @deprecated Keys are validated directly from the extension regardless of
   * the capture surface; kept only for wire compatibility of the internal message. */
  desktop?: boolean;
}

export async function testProviderKey(
  provider: ProviderKind,
  key: string,
  options: KeyTestOptions = {},
): Promise<KeyTestResult> {
  if (key.trim().length === 0) {
    return { valid: false, message: "Enter an API key first." };
  }
  return chrome.runtime.sendMessage({
    type: "TEST_PROVIDER_KEY",
    provider,
    key,
    ...(options.desktop ? { desktop: true } : {}),
  });
}

const PROVIDER_NAMES: Record<ProviderKind, string> = {
  deepgram: "Deepgram",
  groq: "Groq",
  claude: "Claude",
  gemini: "Gemini",
  deepseek: "DeepSeek",
};

const KEY_CHECK_TIMEOUT_MS = 10_000;

/** The cheapest authenticated, read-only, free request each provider offers. */
function keyCheckRequest(provider: ProviderKind, key: string): { url: string; headers: Record<string, string> } {
  switch (provider) {
    case "deepgram":
      return { url: "https://api.deepgram.com/v1/auth/token", headers: { Authorization: `Token ${key}` } };
    case "groq":
      return { url: "https://api.groq.com/openai/v1/models", headers: { Authorization: `Bearer ${key}` } };
    case "claude":
      return {
        url: "https://api.anthropic.com/v1/models?limit=1",
        headers: {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
      };
    case "gemini":
      return { url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", headers: { "x-goog-api-key": key } };
    case "deepseek":
      return { url: "https://api.deepseek.com/models", headers: { Authorization: `Bearer ${key}` } };
  }
}

/** Runs in the background worker. Never throws; a network failure is a result. */
export async function testProviderKeyDirect(
  provider: ProviderKind,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<KeyTestResult> {
  const trimmed = key.trim();
  if (trimmed.length === 0) return { valid: false, message: "Enter an API key first." };
  const name = PROVIDER_NAMES[provider];
  const request = keyCheckRequest(provider, trimmed);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), KEY_CHECK_TIMEOUT_MS);
  try {
    const response = await fetchImpl(request.url, { method: "GET", headers: request.headers, signal: controller.signal });
    if (response.ok) return { valid: true, message: `${name} accepted the key.` };
    if (response.status === 401 || response.status === 403) {
      return { valid: false, message: `${name} rejected the key. Check that it is copied in full and still active.` };
    }
    // An edge rate limit may happen before authentication; it proves nothing about the key.
    if (response.status === 429) return { valid: false, message: `${name} is rate limiting key checks. Wait a moment and test again.` };
    return { valid: false, message: `${name} could not check the key (HTTP ${response.status}). Try again in a moment.` };
  } catch {
    return { valid: false, message: `Could not reach ${name}. Check your connection and try again.` };
  } finally {
    clearTimeout(timeout);
  }
}
