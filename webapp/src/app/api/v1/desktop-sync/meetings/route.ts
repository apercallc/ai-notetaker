import { NextResponse } from "next/server";
import { apiErrorResponse, jsonError, requestIdFrom } from "@/lib/apiErrors";
import { authenticateDesktopSync } from "@/lib/desktopSyncAuth";
import { listDesktopSyncMeetings, upsertMeeting } from "@/lib/meetings";

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const PULL_PAGE_SIZE = 50;

export async function GET(request: Request) {
  const requestId = requestIdFrom(request);
  try {
    const auth = await authenticateDesktopSync(request);
    if (!auth.ok) {
      return NextResponse.json({ error: auth.message, requestId }, {
        status: auth.status,
        headers: { "x-request-id": requestId, "cache-control": "no-store" },
      });
    }

    const url = new URL(request.url);
    const updatedAtValue = url.searchParams.get("updatedAt");
    const id = url.searchParams.get("id");
    const updatedAt = updatedAtValue ? new Date(updatedAtValue) : null;
    if ((updatedAtValue && (!updatedAt || Number.isNaN(updatedAt.getTime()))) || (id !== null && !updatedAt) || (id && (id.length > 128 || id.includes("\u0000")))) {
      return jsonError("invalid sync cursor", 400, requestId);
    }

    const rows = await listDesktopSyncMeetings(
      auth.auth.workspaceId,
      updatedAt ? { updatedAt, ...(id ? { id } : {}) } : null,
      PULL_PAGE_SIZE + 1,
    );
    const pageRows = rows.slice(0, PULL_PAGE_SIZE);
    const meetings = pageRows.map((meeting) => ({
      id: meeting.id,
      title: meeting.title,
      mode: meeting.mode,
      startedAt: meeting.startedAt.toISOString(),
      endedAt: meeting.endedAt.toISOString(),
      summary: meeting.summary,
      updatedAt: meeting.updatedAt.toISOString(),
      transcript: meeting.transcript.map((segment) => ({
        speaker: segment.speaker,
        text: segment.text,
        timestamp: segment.timestamp?.toISOString() ?? null,
      })),
      actionItems: meeting.actionItems.map((item) => ({
        id: item.id,
        text: item.text,
        owner: item.owner,
        status: item.status,
        dueAt: item.dueAt?.toISOString() ?? null,
        completedAt: item.completedAt?.toISOString() ?? null,
      })),
    }));
    // Reserve space for hasMore and the ID/timestamp cursor in the outer
    // response while keeping the body within the desktop's bounded reader.
    const pageLimit = MAX_REQUEST_BYTES - 512;
    while (meetings.length > 1 && new TextEncoder().encode(JSON.stringify({ meetings })).byteLength > pageLimit) {
      meetings.pop();
      pageRows.pop();
    }
    if (meetings.length === 1 && new TextEncoder().encode(JSON.stringify({ meetings })).byteLength > pageLimit) {
      return jsonError("workspace note is too large for desktop sync", 413, requestId);
    }
    const hasMore = rows.length > pageRows.length;
    const last = meetings.at(-1);
    return NextResponse.json({
      meetings,
      hasMore,
      nextCursor: last ? { updatedAt: last.updatedAt, id: last.id } : null,
    }, {
      headers: { "x-request-id": requestId, "cache-control": "no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error, { requestId, fallbackMessage: "Workspace note sync failed." });
  }
}

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
