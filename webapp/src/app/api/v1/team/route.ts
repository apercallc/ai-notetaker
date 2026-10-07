import { NextResponse } from "next/server";
import { apiErrorResponse, requestIdFrom } from "@/lib/apiErrors";
import { contextFromRequest } from "@/lib/requestContext";
import { getManagedSession, managedUnauthorized } from "@/lib/managedAuth";
import { readManagedJson, ManagedValidationError } from "@/lib/managedJobs";
import { addMemberAs, loadTeamRoster, manageTeamAs } from "@/lib/teamAdmin";

/** Team roster for the workspace owner. Members cannot list or manage the team. */
export async function GET(request: Request) {
  const requestId = requestIdFrom(request);
  const session = await getManagedSession(request);
  if (!session) return managedUnauthorized(requestId);
  if (session.role !== "owner") return NextResponse.json({ error: "Only the workspace owner can manage the team.", requestId }, { status: 403, headers: { "x-request-id": requestId } });
  try {
    return NextResponse.json(await loadTeamRoster(session.workspaceId), { headers: { "x-request-id": requestId } });
  } catch (error) {
    return apiErrorResponse(error, { requestId });
  }
}

/** operation: invite | add | role | remove | reset | revoke-invite — the same actions as the web Team page. */
export async function POST(request: Request) {
  const requestId = requestIdFrom(request);
  const session = await getManagedSession(request);
  if (!session) return managedUnauthorized(requestId);
  try {
    const body = await readManagedJson(request);
    if (typeof body !== "object" || body === null) throw new ManagedValidationError("request body must be an object");
    const value = body as Record<string, unknown>;
    const text = (key: string) => (typeof value[key] === "string" ? (value[key] as string).slice(0, 320) : "");
    const operation = text("operation");
    const result = operation === "add"
      ? await addMemberAs(session, text("email"))
      : await manageTeamAs(session, { operation, id: text("id"), email: text("email"), role: text("role") }, async () => contextFromRequest(request));
    return NextResponse.json(result, { status: result.ok ? 200 : session.role !== "owner" ? 403 : 422, headers: { "x-request-id": requestId } });
  } catch (error) {
    return apiErrorResponse(error, { requestId });
  }
}
