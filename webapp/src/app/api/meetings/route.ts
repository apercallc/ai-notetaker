import { NextResponse, type NextRequest } from "next/server";
import { listMeetings, upsertMeeting, ValidationError } from "@/lib/meetings";

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

// Auth is enforced globally by src/proxy.ts for every /api/* route —
// this handler doesn't re-check it, by design (one enforcement point).

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const query = searchParams.get("query") ?? undefined;
  try {
    const limit = parseIntegerParam(searchParams.get("limit"), "limit");
    const offset = parseIntegerParam(searchParams.get("offset"), "offset");
    const result = await listMeetings({ query, limit, offset });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
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
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: "request body is too large" }, { status: 413 });
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
        return NextResponse.json({ error: "request body is too large" }, { status: 413 });
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
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    const result = await upsertMeeting(body);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
