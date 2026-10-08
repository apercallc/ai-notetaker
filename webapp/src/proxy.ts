import { ownOrigin, publicUrl } from "@/lib/publicUrl";
import { NextResponse, type NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { isAuthorizedBearer } from "./lib/auth";
import { isLegacyIngestAvailable } from "./lib/deploymentConfig";
import { isValidWorkerToken } from "./lib/secureCompare";
import { isManagedCorsOrigin, managedCorsHeaders } from "./lib/cors";
import { requestIdFrom } from "./lib/requestId";
import { getSessionUser } from "./lib/sessions";
import { MARKETING_HEADER, isMarketingPath } from "./marketing/paths";
import { directUploadOrigin } from "./lib/directUploadConfig";

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
    `connect-src 'self'${sentry ? ` ${sentry}` : ""}${directUploadOrigin() ? ` ${directUploadOrigin()}` : ""}${development ? " ws: wss:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://checkout.stripe.com https://billing.stripe.com https://accounts.google.com",
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

  // This private service-to-service namespace authenticates its dedicated
  // bearer token inside each Route Handler; it must not fall through to the
  // browser-session gate below.
  if (pathname === "/internal/admin" || pathname.startsWith("/internal/admin/")) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    // These browser OAuth endpoints validate the signed-in session and the
    // encrypted, one-time PKCE state themselves. Google must be able to
    // redirect to the callback without an API Bearer token.
    if (pathname === "/api/google/oauth/connect" || pathname === "/api/google/oauth/callback" || pathname === "/api/google/oauth/start") {
      return NextResponse.next();
    }
    // The browser import form uploads with its HttpOnly session cookie. Each
    // route authenticates the cookie itself and enforces same-origin + CSRF
    // checks (getBrowserManagedSession), so it needs no Bearer token here.
    if (pathname === "/api/import" || pathname.startsWith("/api/import/")) {
      return NextResponse.next();
    }
    // The MCP endpoint authenticates a read-only API token itself and checks Origin.
    if (pathname === "/api/mcp") {
      return NextResponse.next();
    }
    // Native desktop requests use a workspace-bound notes-sync token and do
    // not carry a browser Origin. Both routes authenticate in their handler.
    if (pathname === "/api/v1/desktop-sync" || pathname.startsWith("/api/v1/desktop-sync/")) {
      return NextResponse.next();
    }
    if (pathname.startsWith("/api/v1/")) {
      const origin = request.headers.get("origin");
      // Behind Railway request.nextUrl is the internal address; compare against the public origin.
      const selfOrigin = ownOrigin(request);
      const corsHeaders = managedCorsHeaders(origin, selfOrigin);
      if (!isManagedCorsOrigin(origin, selfOrigin)) {
        return NextResponse.json({ error: "origin not allowed", requestId }, { status: 403, headers: { ...corsHeaders, "x-request-id": requestId } });
      }
      if (request.method === "OPTIONS") {
        return new NextResponse(null, { status: 204, headers: { ...corsHeaders, "x-request-id": requestId } });
      }
      // Password and Google OAuth exchanges must be reachable before a
      // managed token exists. Each route verifies its own credentials/code.
      if (pathname === "/api/v1/auth/login" || pathname === "/api/v1/auth/google/exchange" || pathname === "/api/v1/auth/desktop-code") return NextResponse.next();
      if ((WORKER_RUN_PATH.test(pathname) || pathname === "/api/v1/jobs/next") && isValidWorkerToken(request.headers.get("x-worker-token"))) {
        return NextResponse.next();
      }
      if (pathname === "/api/v1/billing/webhook" && request.headers.has("stripe-signature")) {
        return NextResponse.next();
      }
      const authorization = request.headers.get("authorization");
      const sessionId = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
      let user: Awaited<ReturnType<typeof getSessionUser>> = null;
      try {
        user = sessionId && sessionId !== process.env.AUTH_TOKEN ? await getSessionUser(sessionId) : null;
      } catch (error) {
        // The session store is unreachable. That is not "signed out": clients must be told to retry,
        // not to discard a good session.
        console.error("session lookup failed", { requestId, error: error instanceof Error ? error.message : String(error) });
        return NextResponse.json({ error: "service temporarily unavailable", requestId }, { status: 503, headers: { ...corsHeaders, "retry-after": "5", "x-request-id": requestId } });
      }
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
  let user: Awaited<ReturnType<typeof getSessionUser>>;
  try {
    user = await getSessionUser(sessionId);
  } catch (error) {
    console.error("session lookup failed", { requestId, error: error instanceof Error ? error.message : String(error) });
    return new NextResponse("The service is temporarily unavailable. Please try again in a moment.", {
      status: 503,
      headers: { "retry-after": "5", "content-type": "text/plain; charset=utf-8", "x-request-id": requestId },
    });
  }
  if (!user) {
    const loginUrl = publicUrl("/login", request);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return nextPage(request);
}

export const config = {
  // Everything except Next's own internals and static assets — those don't
  // need to pass through the auth check. In particular, excluding SVG and
  // font files keeps the login page's own assets usable before a session
  // exists. API paths are never exempt: a client-chosen id such as
  // `/api/meetings/x.png` must still hit the auth check.
  matcher: [
    "/((?!_next/static|_next/image|_next/font|favicon.ico|(?!api/).*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml|webmanifest)$).*)",
  ],
};
