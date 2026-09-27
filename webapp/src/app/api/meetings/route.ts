import { NextResponse, type NextRequest } from "next/server";
import { listMeetings, upsertMeeting, ValidationError } from "@/lib/meetings";
import { getDefaultWorkspaceId } from "@/lib/workspaces";
import { isLegacyIngestAvailable } from "@/lib/deploymentConfig";
import { apiErrorResponse, jsonError, requestIdFrom } from "@/lib/apiErrors";

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

// Auth is enforced globally by src/proxy.ts for every /api/* route —
// this handler doesn't re-check it, by design (one enforcement point).

export async function GET(request: NextRequest) {
  const requestId = requestIdFrom(request);
  if (!isLegacyIngestAvailable()) return jsonError("not found", 404, requestId);
  const { searchParams } = request.nextUrl;
  const query = searchParams.get("query") ?? undefined;
  try {
    const limit = parseIntegerParam(searchParams.get("limit"), "limit");
    const offset = parseIntegerParam(searchParams.get("offset"), "offset");
    const workspaceId = await getDefaultWorkspaceId();
    const result = await listMeetings(workspaceId, { query, limit, offset });
    return NextResponse.json(result, { headers: { "x-request-id": requestId } });
  } catch (err) {
    return apiErrorResponse(err, { requestId });
  }
}

function parseIntegerParam(value: string | null, name: string): number | undefined {
  if (value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ValidationError(`${name} must be a non-negative integer`);
  }
  return parsed;
}

export async function POST(request: NextRequest) {
  const requestId = requestIdFrom(request);
  if (!isLegacyIngestAvailable()) return jsonError("not found", 404, requestId);
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_REQUEST_BYTES) {
    return jsonError("request body is too large", 413, requestId);
  }

  let body: unknown;
  try {
    if (!request.body) throw new Error("missing request body");
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_REQUEST_BYTES) {
        await reader.cancel();
        return jsonError("request body is too large", 413, requestId);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return jsonError("invalid JSON body", 400, requestId);
  }

  try {
    const workspaceId = await getDefaultWorkspaceId();
    const result = await upsertMeeting(body, workspaceId);
    return NextResponse.json(result, { status: 201, headers: { "x-request-id": requestId } });
  } catch (err) {
    return apiErrorResponse(err, { requestId });
  }
}
