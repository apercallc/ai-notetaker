import { NextResponse, type NextRequest } from "next/server";
import { listMeetings, upsertMeeting, ValidationError } from "@/lib/meetings";

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
  let body: unknown;
  try {
    body = await request.json();
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
