import { NextResponse } from "next/server";
import { apiErrorResponse, jsonError, requestIdFrom } from "@/lib/apiErrors";
import { authenticateDesktopSync } from "@/lib/desktopSyncAuth";
import { updateActionItem } from "@/lib/meetings";

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
    let body: unknown;
    try {
      body = await request.json();
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
