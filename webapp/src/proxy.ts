import { NextResponse, type NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { isAuthorizedBearer } from "./lib/auth";
import { isLegacyIngestAvailable } from "./lib/deploymentConfig";
import { isValidWorkerToken } from "./lib/secureCompare";
import { isManagedCorsOrigin, managedCorsHeaders } from "./lib/cors";
import { requestIdFrom } from "./lib/requestId";
import { getSessionUser } from "./lib/sessions";
import { MARKETING_HEADER, isMarketingPath } from "./marketing/paths";

// Proxy files (Next.js 16's replacement for middleware.ts) always run on
// the Node.js runtime, which is exactly why we moved off middleware.ts in
// the first place — lib/auth.ts's constant-time comparison needs
// node:crypto, which the old Edge-runtime middleware didn't support.

/**
 * Every route in this app requires authentication, including reads — see
 * docs/webapp-api.md, the architecture spec §3.5, and
 * docs/superpowers/specs/2026-09-22-webapp-multi-user-auth-design.md. This
 * is the single enforcement point for that rule; it must run before every
 * page and API route (see `config.matcher` below), not be re-implemented
 * per-route where it's easy to forget on one.
 *
 * Two auth mechanisms, for two different kinds of client:
 * - `/api/*` (the extension, future mobile clients): a Bearer token in the
 *   Authorization header, per docs/webapp-api.md. `/api/health` is the one
 *   deliberate exception, documented there. Unchanged by the multi-user
 *   auth work — one deployment still has one AUTH_TOKEN.
 * - Everything else (the browser UI): a real per-user session, looked up
 *   in the database by the opaque id in the `session` cookie. This is a
 *   deliberate, acknowledged move from a zero-database-call comparison to
 *   a DB round trip on every page load — a revocable, per-user session
 *   can't be validated without state, and this project already has a
 *   database.
 */
const WORKER_RUN_PATH = /^\/api\/v1\/jobs\/[^/]+\/run$/;

function sentryOrigin(): string | undefined {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN?.trim();
  if (!dsn) return undefined;
  try {
    return new URL(dsn).origin;
  } catch {
    return undefined;
  }
}

export function contentSecurityPolicy(nonce: string, development = process.env.NODE_ENV !== "production"): string {
  const sentry = sentryOrigin();
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    // Inline style attributes are currently used by React components. Script
    // execution is nonce-only in production; style elements also accept the
    // request nonce so generated Next.js styles remain compatible.
    `style-src 'self' 'unsafe-inline' 'nonce-${nonce}'`,
    // A nonce in style-src makes browsers ignore 'unsafe-inline' for it, which
    // silently blocked every inline style="" attribute React renders. Attributes
    // cannot run script, so allow them explicitly while <style> elements stay
    // nonce-only.
    "style-src-attr 'unsafe-inline'",
    `img-src 'self' data: blob:${sentry ? ` ${sentry}` : ""}`,
    "font-src 'self' data:",
    "media-src 'self' blob:",
    `connect-src 'self'${sentry ? ` ${sentry}` : ""}${development ? " ws: wss:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://checkout.stripe.com https://billing.stripe.com",
    "frame-ancestors 'none'",
  ].join("; ");
}

function nextPage(request: NextRequest, options: { marketing?: boolean } = {}): NextResponse {
  const nonce = randomBytes(18).toString("base64");
  const policy = contentSecurityPolicy(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  // Never trust a client-supplied value: set it only for marketing pages.
  requestHeaders.delete(MARKETING_HEADER);
  if (options.marketing) requestHeaders.set(MARKETING_HEADER, "1");
  // Next extracts the nonce from the forwarded request CSP and adds it to
  // framework and inline scripts during dynamic rendering.
  requestHeaders.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  const requestId = requestIdFrom(request);

  if (pathname === "/api/health") {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    // These browser OAuth endpoints validate the signed-in session and the
    // encrypted, one-time PKCE state themselves. Google must be able to
    // redirect to the callback without an API Bearer token.
    if (pathname === "/api/google/oauth/connect" || pathname === "/api/google/oauth/callback") {
      return NextResponse.next();
    }
    if (pathname.startsWith("/api/v1/")) {
      const origin = request.headers.get("origin");
      const corsHeaders = managedCorsHeaders(origin, request.nextUrl.origin);
      if (!isManagedCorsOrigin(origin, request.nextUrl.origin)) {
        return NextResponse.json({ error: "origin not allowed", requestId }, { status: 403, headers: { ...corsHeaders, "x-request-id": requestId } });
      }
      if (request.method === "OPTIONS") {
        return new NextResponse(null, { status: 204, headers: { ...corsHeaders, "x-request-id": requestId } });
      }
      // Login is the one managed API route that must be reachable before a
      // session exists. The route itself performs password verification and
      // creates the opaque session used by every other managed endpoint.
      if (pathname === "/api/v1/auth/login") return NextResponse.next();
      if ((WORKER_RUN_PATH.test(pathname) || pathname === "/api/v1/jobs/next") && isValidWorkerToken(request.headers.get("x-worker-token"))) {
        return NextResponse.next();
      }
      if (pathname === "/api/v1/billing/webhook" && request.headers.has("stripe-signature")) {
        return NextResponse.next();
      }
      const authorization = request.headers.get("authorization");
      const sessionId = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
      const user = sessionId && sessionId !== process.env.AUTH_TOKEN ? await getSessionUser(sessionId) : null;
      if (!user) {
        return NextResponse.json({ error: "managed session required", requestId }, { status: 401, headers: { ...corsHeaders, "x-request-id": requestId } });
      }
      return NextResponse.next();
    }
    // The legacy AUTH_TOKEN ingestion API does not exist on managed hosting
    // unless explicitly re-enabled; answer before any credential check so it
    // does not even confirm the route.
    if ((pathname === "/api/meetings" || pathname.startsWith("/api/meetings/")) && !isLegacyIngestAvailable()) {
      return NextResponse.json({ error: "not found", requestId }, { status: 404, headers: { "x-request-id": requestId } });
    }
    const authorized = isAuthorizedBearer(request.headers.get("authorization"));
    if (!authorized) {
      return NextResponse.json({ error: "unauthorized", requestId }, { status: 401, headers: { "x-request-id": requestId } });
    }
    return NextResponse.next();
  }

  if (pathname === "/login") {
    return nextPage(request);
  }

  // The project-operated managed service has a public front page. These routes
  // are static product copy only (see marketing/paths.ts); the check is exact
  // path equality, and self-hosted instances never reach it, so a private
  // deployment's meeting data is never one route away from being public.
  if (process.env.MANAGED_HOSTING === "true" && isMarketingPath(pathname)) {
    return nextPage(request, { marketing: true });
  }

  // Share links are bearer capabilities themselves. The page validates the
  // hashed, expiring token; requiring a browser session here would defeat the
  // purpose of sharing a meeting with someone outside the workspace.
  if (pathname.startsWith("/share/")) {
    return nextPage(request);
  }

  const sessionId = request.cookies.get("session")?.value;
  const user = await getSessionUser(sessionId);
  if (!user) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return nextPage(request);
}

export const config = {
  // Everything except Next's own internals and static assets — those don't
  // need to pass through the auth check. In particular, excluding SVG and
  // font files keeps the login page's own assets usable before a session
  // exists.
  matcher: [
    "/((?!_next/static|_next/image|_next/font|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml|webmanifest)$).*)",
  ],
};
