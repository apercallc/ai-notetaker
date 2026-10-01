import { NextResponse } from "next/server";
import { resolveReadToken } from "@/lib/apiTokens";
import { handleMcpMessage } from "@/lib/mcp";
import { getUserDefaultWorkspaceId, getUserRole } from "@/lib/workspaces";
import { requestIdFrom } from "@/lib/requestId";

/**
 * Remote MCP endpoint (Streamable HTTP, stateless). Authenticates a read-only
 * `ant_` token itself; the proxy lets /api/mcp through for that reason.
 */
const MAX_BODY_BYTES = 64 * 1024;
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 120;
const hits = new Map<string, { count: number; resetAt: number }>();

function rateLimited(tokenId: string, now = Date.now()): boolean {
  const entry = hits.get(tokenId);
  if (!entry || entry.resetAt <= now) {
    hits.set(tokenId, { count: 1, resetAt: now + WINDOW_MS });
    if (hits.size > 5_000) for (const [key, value] of hits) if (value.resetAt <= now) hits.delete(key);
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_REQUESTS_PER_WINDOW;
}

function json(body: unknown, status: number, requestId: string, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { "x-request-id": requestId, "cache-control": "no-store", ...headers } });
}

/** Reads the body without buffering more than `limit` bytes; null means it was too large. */
async function readBoundedText(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function POST(request: Request) {
  const requestId = requestIdFrom(request);
  try {
    return await handlePost(request, requestId);
  } catch (error) {
    // MCP clients parse JSON-RPC; a bare 500 page would read as a protocol failure.
    console.error("mcp request failed", { requestId, error: error instanceof Error ? error.message : String(error) });
    return json({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error. Try again." } }, 500, requestId);
  }
}

async function handlePost(request: Request, requestId: string): Promise<NextResponse> {
  // MCP asks servers to reject unexpected browser origins (DNS-rebinding defence).
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return json({ error: "origin not allowed" }, 403, requestId);

  const authorization = request.headers.get("authorization");
  const secret = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  const user = secret ? await resolveReadToken(secret) : null;
  if (!user) return json({ error: "A read-only token is required." }, 401, requestId, { "www-authenticate": 'Bearer realm="ai-notetaker-mcp"' });
  if (rateLimited(user.tokenId)) return json({ error: "Too many requests. Slow down." }, 429, requestId, { "retry-after": "30" });

  const requested = request.headers.get("x-workspace-id")?.trim();
  const workspaceId = requested || (await getUserDefaultWorkspaceId(user.id));
  if (!workspaceId || !(await getUserRole(user.id, workspaceId))) return json({ error: "No workspace is available for this token." }, 403, requestId);

  const raw = await readBoundedText(request, MAX_BODY_BYTES);
  if (raw === null) return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request is too large." } }, 413, requestId);
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } }, 400, requestId);
  }
  const response = await handleMcpMessage(message, { workspaceId });
  if (response === null) return new NextResponse(null, { status: 202, headers: { "x-request-id": requestId } });
  return json(response, 200, requestId);
}

/** No server-initiated stream: clients that probe with GET are told to use POST only. */
export function GET() {
  return new NextResponse(null, { status: 405, headers: { allow: "POST" } });
}
