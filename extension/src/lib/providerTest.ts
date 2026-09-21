/**
 * "Test connection" for the optional self-hosted webapp on the settings
 * page. This is the one legitimate direct-fetch exception: the webapp is
 * the user's own configured instance, not a third-party AI provider — see
 * docs/webapp-api.md and extension/CLAUDE.md.
 *
 * AI provider "test key" validation does NOT live here — the extension
 * never calls transcription/LLM provider APIs directly (extension/CLAUDE.md).
 * That's routed through the helper via `NativeMessagingClient.testProviderKey`,
 * per docs/native-messaging-protocol.md's `test_provider_key` message.
 */
type Fetcher = typeof fetch;
const HEALTH_CHECK_TIMEOUT_MS = 8_000;

export interface WebappHealthResult {
  healthy: boolean;
  message: string;
}

/**
 * Normalize a user-owned webapp URL and reject destinations that could send
 * its bearer token over an unsafe scheme or through embedded credentials.
 * Plain HTTP remains available for loopback development only.
 */
export function normalizeWebappUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
    if (url.username || url.password) return null;
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export async function testWebappHealth(
  url: string,
  fetchImpl: Fetcher = fetch,
): Promise<WebappHealthResult> {
  const normalized = normalizeWebappUrl(url);
  if (!normalized) {
    return {
      healthy: false,
      message: "Use an HTTPS webapp URL (HTTP is allowed only for localhost).",
    };
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${normalized}/api/health`, { signal: controller.signal });
    if (response.ok) {
      return { healthy: true, message: "Connected to your self-hosted webapp." };
    }
    return { healthy: false, message: `Webapp responded with HTTP ${response.status}.` };
  } catch {
    return {
      healthy: false,
      message: "Couldn't reach that URL. Check it's correct and the deployment is running.",
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
