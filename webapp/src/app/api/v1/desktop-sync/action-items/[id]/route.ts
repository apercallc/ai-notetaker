import { NextResponse } from "next/server";
import { apiErrorResponse, jsonError, requestIdFrom } from "@/lib/apiErrors";
import { authenticateDesktopSync } from "@/lib/desktopSyncAuth";
import { ManagedValidationError, readManagedBytes } from "@/lib/managedJobs";
import { updateActionItem } from "@/lib/meetings";

// The body is one status field; refuse anything larger before buffering it.
const MAX_REQUEST_BYTES = 4 * 1024;

/**
 * Marks one workspace action item open or done from the desktop app, exactly as the web Actions
 * page does, so the two always agree. Scoped to the notes-sync token's workspace.
 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestId = requestIdFrom(request);
  try {
    const auth = await authenticateDesktopSync(request, { write: true });
    if (!auth.ok) {
      return NextResponse.json({ error: auth.message, requestId }, { status: auth.status, headers: { "x-request-id": requestId, "cache-control": "no-store" } });
    }
    let bytes: Uint8Array;
    try {
      bytes = await readManagedBytes(request, MAX_REQUEST_BYTES);
    } catch (error) {
      if (error instanceof ManagedValidationError) return jsonError("request body is too large", 413, requestId);
      throw error;
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return jsonError("invalid JSON body", 400, requestId);
    }
    const status = typeof body === "object" && body !== null ? (body as Record<string, unknown>).status : undefined;
    if (status !== "open" && status !== "done") return jsonError("status must be open or done", 400, requestId);
    const { id } = await context.params;
    const updated = await updateActionItem(auth.auth.workspaceId, id, { status });
    if (!updated) return jsonError("action item not found", 404, requestId);
    return NextResponse.json({ ok: true, id, status }, { headers: { "x-request-id": requestId, "cache-control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error, { requestId, fallbackMessage: "Could not update the action item." });
  }
}
