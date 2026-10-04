import { NextResponse } from "next/server";
import { apiErrorResponse, requestIdFrom } from "@/lib/apiErrors";
import { authenticateDesktopSync } from "@/lib/desktopSyncAuth";

export async function GET(request: Request) {
  const requestId = requestIdFrom(request);
  try {
    const result = await authenticateDesktopSync(request);
    if (!result.ok) {
      return NextResponse.json({ error: result.message, requestId }, {
        status: result.status,
        headers: { "x-request-id": requestId, "cache-control": "no-store" },
      });
    }
    return NextResponse.json({ ok: true, workspace: { id: result.auth.workspaceId, name: result.auth.workspaceName } }, {
      headers: { "x-request-id": requestId, "cache-control": "no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error, { requestId, fallbackMessage: "Desktop sync is temporarily unavailable." });
  }
}
