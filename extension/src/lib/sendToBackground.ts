/**
 * Sends a request to the service worker and turns its failure envelope into a
 * rejection. The worker answers a handler that threw with `{ error }` as an
 * ordinary resolved reply, so a caller that only awaits would report success
 * for a save, delete or retry that never happened.
 *
 * Only the bare envelope (a single `error` string) counts as a failure: replies
 * that carry data next to an `error` field (for example a key test's verdict)
 * are returned untouched.
 */
export async function sendToBackground<T = unknown>(message: unknown): Promise<T> {
  const response: unknown = await chrome.runtime.sendMessage(message);
  if (response && typeof response === "object" && !Array.isArray(response)) {
    const keys = Object.keys(response);
    const error = (response as { error?: unknown }).error;
    if (keys.length === 1 && keys[0] === "error" && typeof error === "string") throw new Error(error);
  }
  return response as T;
}
