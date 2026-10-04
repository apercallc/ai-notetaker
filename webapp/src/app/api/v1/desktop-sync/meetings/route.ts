import { NextResponse } from "next/server";
import { apiErrorResponse, jsonError, requestIdFrom } from "@/lib/apiErrors";
import { authenticateDesktopSync } from "@/lib/desktopSyncAuth";
import { upsertMeeting } from "@/lib/meetings";

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

export async function POST(request: Request) {
  const requestId = requestIdFrom(request);
  try {
    const auth = await authenticateDesktopSync(request);
    if (!auth.ok) {
      return NextResponse.json({ error: auth.message, requestId }, {
        status: auth.status,
        headers: { "x-request-id": requestId, "cache-control": "no-store" },
      });
    }

    const contentLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
      return jsonError("meeting note is too large", 413, requestId);
    }
    if (!request.body) return jsonError("invalid JSON body", 400, requestId);
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_REQUEST_BYTES) {
        await reader.cancel();
        return jsonError("meeting note is too large", 413, requestId);
      }
      chunks.push(value);
    }

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return jsonError("invalid JSON body", 400, requestId);
    }

    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      const fields = body as Record<string, unknown>;
      if (fields.captureSource !== undefined && fields.captureSource !== "desktop") {
        return jsonError("only desktop notes can be synced", 400, requestId);
      }
      if (fields.processingMode !== undefined && fields.processingMode !== "local_byok") {
        return jsonError("only local notes can be synced", 400, requestId);
      }
    }

    const meeting = await upsertMeeting(body, auth.auth.workspaceId, auth.auth.userId);
    return NextResponse.json(meeting, {
      status: 201,
      headers: { "x-request-id": requestId, "cache-control": "no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error, { requestId, fallbackMessage: "Desktop note sync failed." });
  }
}
