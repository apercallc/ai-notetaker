import { cookies } from "next/headers";
import type { RequestContext } from "./requestContext";

export const SESSION_COOKIE = "session";

function appUrlProtocol(): "http" | "https" | null {
  const value = process.env.APP_URL?.trim() || process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!value) return null;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "https:" ? "https" : protocol === "http:" ? "http" : null;
  } catch {
    return null;
  }
}

function isLocalHost(host: string | null): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, "").toLowerCase();
  return name === "localhost" || name === "127.0.0.1" || name === "[::1]" || name.endsWith(".localhost");
}

/**
 * Whether the session cookie should carry `Secure`.
 *
 * NODE_ENV alone is the wrong signal: a production build served over plain
 * http (docker compose on a LAN, localhost) would set a Secure cookie the
 * browser silently drops, and every sign-in would appear to succeed and
 * bounce straight back to /login. Order of trust:
 *   1. INSECURE_COOKIES=true — operator explicitly opts out.
 *   2. APP_URL's protocol — deployment configuration, not client input.
 *   3. Fail safe: Secure in production, not in development.
 *
 * The per-request protocol (x-forwarded-proto, Origin) is deliberately NOT
 * trusted for the Secure decision. Those headers are client-influenced on
 * the first hop; a request carrying a spoofed `x-forwarded-proto: http`
 * could otherwise downgrade the session cookie to non-Secure and have it
 * leak in cleartext under a network attacker. The per-request protocol is
 * still used by cookiesLikelyDropped (a hint, not a security decision) to
 * detect the opposite problem: a genuine http deployment where the browser
 * would drop a Secure cookie.
 */
export function shouldUseSecureCookies(context: Pick<RequestContext, "protocol" | "host">): boolean {
  if (process.env.INSECURE_COOKIES === "true") return false;
  if (isLocalHost(context.host)) return false;
  const configured = appUrlProtocol();
  if (configured) return configured === "https";
  if (context.protocol) return context.protocol === "https";
  return process.env.NODE_ENV === "production";
}

/**
 * True when there is positive evidence the visitor is on plain http yet the
 * cookie would be marked Secure — i.e. the browser would drop it. Used to show
 * an actionable hint on /login instead of a silent sign-in loop.
 */
export function cookiesLikelyDropped(context: Pick<RequestContext, "protocol" | "host">): boolean {
  if (!shouldUseSecureCookies(context)) return false;
  if (context.protocol === "http") return true;
  if (context.protocol === "https") return false;
  return appUrlProtocol() === "http";
}

export async function setSessionCookie(
  session: { id: string; expiresAt: Date },
  context: Pick<RequestContext, "protocol" | "host">,
): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, session.id, {
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecureCookies(context),
    path: "/",
    expires: session.expiresAt,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}
