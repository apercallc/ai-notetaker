import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedBearer } from "./lib/auth";
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

  if (pathname === "/api/health") {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    const authorized = isAuthorizedBearer(request.headers.get("authorization"));
    if (!authorized) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return NextResponse.next();
  }

  if (pathname === "/login") {
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
