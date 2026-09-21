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

export interface WebappHealthResult {
  healthy: boolean;
  message: string;
}

export async function testWebappHealth(
  url: string,
  fetchImpl: Fetcher = fetch,
): Promise<WebappHealthResult> {
  const normalized = url.replace(/\/+$/, "");
  try {
    const response = await fetchImpl(`${normalized}/api/health`);
    if (response.ok) {
      return { healthy: true, message: "Connected to your self-hosted webapp." };
    }
    return { healthy: false, message: `Webapp responded with HTTP ${response.status}.` };
  } catch {
    return {
      healthy: false,
      message: "Couldn't reach that URL. Check it's correct and the deployment is running.",
    };
  }
}
