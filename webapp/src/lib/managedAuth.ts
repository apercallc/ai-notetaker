import { ownOrigin } from "./publicUrl";
import { getSessionContext, getSessionUser } from "./sessions";
import { getUserDefaultWorkspaceId, getUserRole, resolveActiveWorkspace } from "./workspaces";

export interface ManagedSession {
  userId: string;
  email: string;
  workspaceId: string;
  role: "owner" | "member";
}

export function managedHostingEnabled(): boolean {
  return process.env.MANAGED_HOSTING === "true";
}

/**
 * Managed client calls use the same opaque session id as the browser cookie,
 * but carry it in an Authorization header. The selected workspace is carried
 * in `X-Workspace-Id` when a user belongs to more than one workspace and is
 * validated against membership before any route uses it. The deploy-time AUTH_TOKEN is
 * intentionally not accepted here: it is the legacy self-hosted ingestion
 * credential and has no user/workspace identity.
 */
export async function getManagedSession(request: Request): Promise<ManagedSession | null> {
  if (!managedHostingEnabled()) return null;
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const sessionId = authorization.slice("Bearer ".length).trim();
  if (!sessionId || sessionId === process.env.AUTH_TOKEN) return null;

  const user = await getSessionUser(sessionId);
  if (!user) return null;
  const requestedWorkspaceId = request.headers.get("x-workspace-id")?.trim();
  const workspaceId = requestedWorkspaceId || (await getUserDefaultWorkspaceId(user.id));
  if (!workspaceId) return null;
  const role = await getUserRole(user.id, workspaceId);
  if (!role) return null;
  return { userId: user.id, email: user.email, workspaceId, role };
}

export function managedUnauthorized(requestId?: string): Response {
  return Response.json(
    { error: "managed session required", ...(requestId ? { requestId } : {}) },
    { status: 401, ...(requestId ? { headers: { "x-request-id": requestId } } : {}) },
  );
}

/** Header the import form sets on every request; a cross-site page cannot add it without a CORS preflight we never grant. */
const BROWSER_API_HEADER = "x-notetaker-browser";

function cookieValue(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

/**
 * Cookie-session variant of getManagedSession for same-origin browser pages
 * that upload through fetch (file import). The browser cookie is HttpOnly, so
 * page scripts cannot turn it into a Bearer token, and cookies are sent
 * ambiently, so this adds the CSRF checks a Bearer API does not need: the
 * request must carry an Origin equal to this app's own origin and the custom
 * browser-API header. The workspace is the session's active workspace, never a
 * client-chosen header.
 */
export async function getBrowserManagedSession(request: Request): Promise<ManagedSession | null> {
  if (!managedHostingEnabled()) return null;
  const origin = request.headers.get("origin");
  if (!origin || origin !== ownOrigin(request)) return null;
  if (request.headers.get(BROWSER_API_HEADER) !== "1") return null;

  const context = await getSessionContext(cookieValue(request.headers.get("cookie"), "session"));
  if (!context || context.user.mustChangePassword) return null;
  const active = await resolveActiveWorkspace(context.user.id, context.activeWorkspaceId);
  if (!active) return null;
  return { userId: context.user.id, email: context.user.email, workspaceId: active.workspaceId, role: active.role };
}
