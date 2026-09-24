import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedBearer } from "./lib/auth";
import { isManagedCorsOrigin, managedCorsHeaders } from "./lib/cors";
import { requestIdFrom } from "./lib/requestId";
import { getSessionUser } from "./lib/sessions";

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
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  const requestId = requestIdFrom(request);

  if (pathname === "/api/health") {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
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
      if (((pathname.startsWith("/api/v1/jobs/") && pathname.endsWith("/run")) || pathname === "/api/v1/jobs/next") && process.env.MANAGED_WORKER_TOKEN && request.headers.get("x-worker-token") === process.env.MANAGED_WORKER_TOKEN) {
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
    const authorized = isAuthorizedBearer(request.headers.get("authorization"));
    if (!authorized) {
      return NextResponse.json({ error: "unauthorized", requestId }, { status: 401, headers: { "x-request-id": requestId } });
    }
    return NextResponse.next();
  }

  if (pathname === "/login") {
    return NextResponse.next();
  }

  // Share links are bearer capabilities themselves. The page validates the
  // hashed, expiring token; requiring a browser session here would defeat the
  // purpose of sharing a meeting with someone outside the workspace.
  if (pathname.startsWith("/share/")) {
    return NextResponse.next();
  }

  const sessionId = request.cookies.get("session")?.value;
  const user = await getSessionUser(sessionId);
  if (!user) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
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
