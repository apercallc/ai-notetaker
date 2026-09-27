/**
 * The managed API is called by the fixed Chrome extension origin, not by
 * arbitrary web pages. Keep this allowlist narrow even though the API uses
 * bearer tokens and does not rely on browser cookies.
 */
export const DEFAULT_MANAGED_EXTENSION_ORIGIN = "chrome-extension://jidooookkdbbbhkkdmcajnnnhhphodok";

const EXTENSION_ORIGIN_PATTERN = /^(?:chrome|moz)-extension:\/\/[^/?#]+\/?$/;

export function managedExtensionOrigin(env: Record<string, string | undefined> = process.env): string {
  const configured = env.MANAGED_EXTENSION_ORIGIN?.trim();
  return configured && EXTENSION_ORIGIN_PATTERN.test(configured) ? configured.replace(/\/$/, "") : DEFAULT_MANAGED_EXTENSION_ORIGIN;
}

export function isManagedCorsOrigin(origin: string | null, requestOrigin: string): boolean {
  return !origin || origin === requestOrigin || origin === managedExtensionOrigin();
}

export function managedCorsHeaders(origin: string | null, requestOrigin: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key, X-Chunk-Sha256, X-Audio-Channel, X-Workspace-Id, X-Request-Id",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
  if (origin && isManagedCorsOrigin(origin, requestOrigin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}
