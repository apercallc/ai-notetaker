import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

const requestTimes: number[] = [];

export function authorizeAdminRequest(request: NextRequest): NextResponse | null {
  const expected = process.env.AI_NOTETAKER_ADMIN_API_TOKEN;
  const provided = request.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1];
  if (!expected || expected.length < 32 || expected.length > 500 || !provided) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  const expectedHash = createHash("sha256").update(expected).digest();
  const providedHash = createHash("sha256").update(provided).digest();
  if (!timingSafeEqual(expectedHash, providedHash)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  const now = Date.now();
  while (requestTimes.length && requestTimes[0] < now - 60_000) requestTimes.shift();
  if (requestTimes.length >= 120) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": "60" } });
  }
  requestTimes.push(now);
  return null;
}

export function noStoreJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function isValidWindow(fromValue: string | null, toValue: string | null): { from: Date; to: Date } | null {
  const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  if (!fromValue || !toValue || !rfc3339.test(fromValue) || !rfc3339.test(toValue)) return null;
  const from = new Date(fromValue);
  const to = new Date(toValue);
  const width = to.getTime() - from.getTime();
  if (!Number.isFinite(width) || width <= 0 || width > 400 * 24 * 60 * 60 * 1000) return null;
  return { from, to };
}

export function encodeAdminCursor(input: { id: string; createdAt: Date }): string {
  return Buffer.from(JSON.stringify({ id: input.id, createdAt: input.createdAt.toISOString() })).toString("base64url");
}

export function decodeAdminCursor(value: string | null): { id: string; createdAt: Date } | null | undefined {
  if (!value) return null;
  if (value.length > 500) return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!payload || typeof payload !== "object" || !("id" in payload) || !("createdAt" in payload)) return undefined;
    const { id, createdAt } = payload as { id: unknown; createdAt: unknown };
    if (typeof id !== "string" || typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) return undefined;
    return { id, createdAt: new Date(createdAt) };
  } catch {
    return undefined;
  }
}
