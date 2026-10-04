import { NextResponse } from "next/server";
import { apiErrorResponse, jsonError, requestIdFrom } from "@/lib/apiErrors";
import { authenticateDesktopSync } from "@/lib/desktopSyncAuth";
import {
  DesktopSyncConflictError,
  listDesktopSyncMeetingCandidates,
  listDesktopSyncMeetingDetails,
  upsertMeeting,
} from "@/lib/meetings";

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const PULL_PAGE_SIZE = 50;
const DETAIL_BATCH_SIZE = 4;

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

    const candidates = await listDesktopSyncMeetingCandidates(
      auth.auth.workspaceId,
      updatedAt ? { updatedAt, ...(id ? { id } : {}) } : null,
      PULL_PAGE_SIZE + 1,
    );
    const meetings: Array<{
      id: string;
      title: string;
      mode: string;
      startedAt: string;
      endedAt: string;
      summary: string;
      updatedAt: string;
      transcript: Array<{ speaker: string; text: string; timestamp: string | null }>;
      actionItems: Array<{ id: string; text: string; owner: string | null; status: string; dueAt: string | null; completedAt: string | null }>;
    }> = [];
    // Reserve space for hasMore and the ID/timestamp cursor in the outer
    // response while keeping the body within the desktop's bounded reader.
    const pageLimit = MAX_REQUEST_BYTES - 512;
    const encoder = new TextEncoder();
    let meetingsBytes = encoder.encode('{"meetings":[]}').byteLength;
    let hasMore = false;
    let processedCandidates = 0;
    let lastCandidate: (typeof candidates)[number] | undefined;
    let lastScannedCandidate: (typeof candidates)[number] | undefined;
    for (let offset = 0; offset < candidates.length; offset += DETAIL_BATCH_SIZE) {
      const batch = candidates.slice(offset, offset + DETAIL_BATCH_SIZE);
      const details = await listDesktopSyncMeetingDetails(auth.auth.workspaceId, batch.map((candidate) => candidate.id));
      const detailsById = new Map(details.map((meeting) => [meeting.id, meeting]));
      for (const candidate of batch) {
        processedCandidates += 1;
        const meeting = detailsById.get(candidate.id);
        if (!meeting) {
          // This note was deleted between the candidate and detail reads, so
          // it is safe to advance past it even though it is not in the page.
          lastScannedCandidate = candidate;
          continue;
        }
        const output = {
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
        };
        const outputBytes = encoder.encode(JSON.stringify(output)).byteLength;
        const projectedBytes = meetingsBytes + outputBytes + (meetings.length > 0 ? 1 : 0);
        if (projectedBytes > pageLimit) {
          if (meetings.length === 0) {
            return jsonError("workspace note is too large for desktop sync", 413, requestId);
          }
          hasMore = true;
          break;
        }
        meetings.push(output);
        meetingsBytes = projectedBytes;
        lastCandidate = candidate;
        lastScannedCandidate = candidate;
        if (meetings.length === PULL_PAGE_SIZE && processedCandidates < candidates.length) {
          hasMore = true;
          break;
        }
      }
      if (hasMore) break;
    }
    if (!hasMore && (processedCandidates < candidates.length || candidates.length > PULL_PAGE_SIZE)) hasMore = true;
    return NextResponse.json({
      meetings,
      hasMore,
      nextCursor: lastScannedCandidate
        ? { updatedAt: lastScannedCandidate.updatedAt.toISOString(), id: lastScannedCandidate.id }
        : lastCandidate ? { updatedAt: lastCandidate.updatedAt.toISOString(), id: lastCandidate.id } : null,
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

    const versionHeader = request.headers.get("x-desktop-sync-version");
    let expectedUpdatedAt: Date | null | undefined;
    if (versionHeader === "new") {
      expectedUpdatedAt = null;
    } else if (versionHeader !== null) {
      expectedUpdatedAt = new Date(versionHeader);
      if (Number.isNaN(expectedUpdatedAt.getTime())) {
        return jsonError("invalid desktop sync version", 400, requestId);
      }
    }

    let meeting: Awaited<ReturnType<typeof upsertMeeting>>;
    try {
      meeting = await upsertMeeting(body, auth.auth.workspaceId, auth.auth.userId, { expectedUpdatedAt });
    } catch (error) {
      if (error instanceof DesktopSyncConflictError) {
        return jsonError(error.message, 409, requestId);
      }
      throw error;
    }
    return NextResponse.json(meeting, {
      status: 201,
      headers: { "x-request-id": requestId, "cache-control": "no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error, { requestId, fallbackMessage: "Desktop note sync failed." });
  }
}
