import { NextResponse } from "next/server";
import { apiErrorResponse, requestIdFrom } from "@/lib/apiErrors";
import { getManagedSession, managedUnauthorized } from "@/lib/managedAuth";
import { readManagedJson, ManagedValidationError } from "@/lib/managedJobs";
import { askWorkspaceNotes } from "@/lib/askRunner";

/** Ask your notes from the desktop app: the same quota, retrieval and answer as the web page. */
export async function POST(request: Request) {
  const requestId = requestIdFrom(request);
  const session = await getManagedSession(request);
  if (!session) return managedUnauthorized(requestId);
  try {
    const body = await readManagedJson(request);
    if (typeof body !== "object" || body === null) throw new ManagedValidationError("request body must be an object");
    const value = body as Record<string, unknown>;
    if (typeof value.question !== "string") throw new ManagedValidationError("question is required");
    const folderId = typeof value.folderId === "string" && value.folderId ? value.folderId : null;
    const result = await askWorkspaceNotes(session.workspaceId, value.question, folderId);
    return NextResponse.json(result, { status: result.ok ? 200 : 422, headers: { "x-request-id": requestId } });
  } catch (error) {
    return apiErrorResponse(error, { requestId });
  }
}
