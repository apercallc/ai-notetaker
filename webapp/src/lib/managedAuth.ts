import { getSessionUser } from "./sessions";
import { getUserDefaultWorkspaceId, getUserRole } from "./workspaces";

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
