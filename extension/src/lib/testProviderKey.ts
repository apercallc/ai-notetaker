/**
 * Shared by every UI page that offers a "test this API key" action
 * (settings, onboarding). Always routes through the background service
 * worker's Native Messaging connection to the helper — never calls a
 * provider's API directly from a UI page. See extension/CLAUDE.md and
 * docs/native-messaging-protocol.md's `test_provider_key` message.
 */
import type { ProviderKind } from "../types";

export async function testProviderKey(
  provider: ProviderKind,
  key: string,
): Promise<{ valid: boolean; message: string }> {
  if (key.trim().length === 0) {
    return { valid: false, message: "Enter an API key first." };
  }
  return chrome.runtime.sendMessage({ type: "TEST_PROVIDER_KEY", provider, key });
}
