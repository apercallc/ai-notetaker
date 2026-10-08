import { getAppUrl } from "./deploymentConfig";

/**
 * A URL on this deployment's public origin, for redirects issued by route handlers.
 *
 * Behind Railway's proxy `request.url` carries the server's internal address
 * (https://0.0.0.0:8080), so a redirect built from it sends the user to a dead
 * page. On the managed deployment the canonical origin is configuration (APP_URL).
 * A self-hosted instance may run on any host and never needs APP_URL, so it keeps
 * using the request's own origin.
 */
export function publicUrl(path: string, request: Request, env: Record<string, string | undefined> = process.env): URL {
  if (env.MANAGED_HOSTING === "true") {
    try {
      return new URL(path, getAppUrl(env));
    } catch {
      // APP_URL missing or invalid: fall through rather than fail the redirect.
    }
  }
  return new URL(path, request.url);
}

/** This deployment's own origin: APP_URL on managed hosting, the request's origin otherwise. */
export function ownOrigin(request: Request, env: Record<string, string | undefined> = process.env): string {
  return publicUrl("/", request, env).origin;
}
