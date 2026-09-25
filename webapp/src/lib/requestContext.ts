import { headers } from "next/headers";

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
  protocol: "http" | "https" | null;
  host: string | null;
}

/**
 * Best-effort client address. The LAST x-forwarded-for hop is the one the
 * nearest (platform) proxy appended; earlier hops are client-supplied and
 * trivially forged, so they are ignored. Without a proxy the header is fully
 * attacker-controlled — which is why the per-email throttle key exists as a
 * backstop that does not depend on this value.
 */
export function clientIpFromHeaders(get: (name: string) => string | null): string | null {
  const real = get("x-real-ip")?.trim();
  if (real) return real.slice(0, 64);
  const forwarded = get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded.split(",").map((hop) => hop.trim()).filter(Boolean);
    const last = hops[hops.length - 1];
    if (last) return last.slice(0, 64);
  }
  return null;
}

export function protocolFromHeaders(get: (name: string) => string | null): "http" | "https" | null {
  const forwarded = get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (forwarded === "https" || forwarded === "http") return forwarded;
  const origin = get("origin");
  if (origin) {
    try {
      const protocol = new URL(origin).protocol;
      if (protocol === "https:") return "https";
      if (protocol === "http:") return "http";
    } catch {
      // fall through
    }
  }
  return null;
}

export function contextFromHeaders(get: (name: string) => string | null): RequestContext {
  return {
    ip: clientIpFromHeaders(get),
    userAgent: get("user-agent")?.slice(0, 300) ?? null,
    protocol: protocolFromHeaders(get),
    host: get("host"),
  };
}

/** Server Components / Actions only. */
export async function getRequestContext(): Promise<RequestContext> {
  const store = await headers();
  return contextFromHeaders((name) => store.get(name));
}

export function contextFromRequest(request: Request): RequestContext {
  const context = contextFromHeaders((name) => request.headers.get(name));
  if (!context.protocol) {
    try {
      const protocol = new URL(request.url).protocol;
      context.protocol = protocol === "https:" ? "https" : protocol === "http:" ? "http" : null;
    } catch {
      // leave null
    }
  }
  return context;
}
