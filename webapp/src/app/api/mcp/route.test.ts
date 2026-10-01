import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET, POST } from "./route";
import { API_TOKEN_SCOPE, READ_TOKEN_SCOPE, createApiToken, resolveApiToken, resolveReadToken } from "@/lib/apiTokens";
import { getSessionUser } from "@/lib/sessions";
import { prisma } from "@/lib/db";

const rpc = (method: string, id: number | null = 1, params: object = {}) => ({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params });
const post = (body: unknown, headers: Record<string, string> = {}, raw?: string) =>
  POST(new Request("http://localhost/api/mcp", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: raw ?? JSON.stringify(body) }));

describe("MCP endpoint", () => {
  let userId: string;
  let workspaceId: string;
  let readToken: string;
  let managedToken: string;
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeEach(async () => {
    workspaceId = randomUUID();
    userId = randomUUID();
    await prisma.workspace.create({ data: { id: workspaceId, name: "MCP route workspace", isDefault: false } });
    await prisma.user.create({ data: { id: userId, email: `mcp-${userId}@example.test`, passwordHash: "x", emailVerifiedAt: new Date() } });
    await prisma.workspaceMembership.create({ data: { userId, workspaceId, role: "owner" } });
    readToken = (await createApiToken(userId, { scope: READ_TOKEN_SCOPE, label: "assistant" })).token;
    managedToken = (await createApiToken(userId)).token;
  });

  afterEach(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("separates the two token scopes in both directions", async () => {
    expect(await resolveReadToken(readToken)).toMatchObject({ id: userId });
    expect(await resolveReadToken(managedToken)).toBeNull();
    expect(await resolveApiToken(readToken, Date.now(), API_TOKEN_SCOPE)).toBeNull();
    // A read-only token cannot stand in for a managed session anywhere sessions are resolved.
    expect(await getSessionUser(readToken)).toBeNull();
    expect(await getSessionUser(managedToken)).toMatchObject({ id: userId });
  });

  it("requires a read-only token", async () => {
    for (const headers of [{}, bearer("ant_unknown"), bearer(managedToken), { authorization: "Basic abc" }]) {
      const response = await post(rpc("ping"), headers);
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain("Bearer");
    }
  });

  it("serves initialize, tools/list and a tool call to a valid token", async () => {
    const init = await post(rpc("initialize", 1, { protocolVersion: "2025-06-18" }), bearer(readToken));
    expect(init.status).toBe(200);
    expect((await init.json()).result.serverInfo.name).toBe("ai-notetaker");
    const tools = await post(rpc("tools/list", 2), bearer(readToken));
    expect((await tools.json()).result.tools).toHaveLength(5);
    await prisma.meeting.create({ data: { userId, workspaceId, title: "Roadmap sync", summary: "Quartz launch plan.", startedAt: new Date(), endedAt: new Date() } });
    const search = await post(rpc("tools/call", 3, { name: "search_notes", arguments: { query: "quartz" } }), bearer(readToken));
    expect(JSON.parse((await search.json()).result.content[0].text).notes[0].title).toBe("Roadmap sync");
  });

  it("acknowledges notifications with 202 and no body", async () => {
    const response = await post(rpc("notifications/initialized", null), bearer(readToken));
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  it("rejects a cross-origin browser request, bad JSON and oversized bodies", async () => {
    expect((await post(rpc("ping"), { ...bearer(readToken), origin: "https://evil.example" })).status).toBe(403);
    expect((await post(rpc("ping"), { ...bearer(readToken), origin: "http://localhost" })).status).toBe(200);
    const bad = await post(null, bearer(readToken), "{nope");
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe(-32700);
    expect((await post(null, bearer(readToken), JSON.stringify({ pad: "x".repeat(70_000) }))).status).toBe(413);
  });

  it("answers GET with 405 because there is no server-initiated stream", async () => {
    const response = GET();
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("refuses a workspace the token's user does not belong to, and accepts one they do", async () => {
    const other = randomUUID();
    await prisma.workspace.create({ data: { id: other, name: "Not mine" } });
    expect((await post(rpc("ping"), { ...bearer(readToken), "x-workspace-id": other })).status).toBe(403);
    expect((await post(rpc("ping"), { ...bearer(readToken), "x-workspace-id": workspaceId })).status).toBe(200);
    await prisma.workspace.delete({ where: { id: other } });
  });

  it("stops working once the token is revoked", async () => {
    await prisma.apiToken.updateMany({ where: { userId, scope: READ_TOKEN_SCOPE }, data: { revokedAt: new Date() } });
    expect((await post(rpc("ping"), bearer(readToken))).status).toBe(401);
  });

  it("rate limits a token", async () => {
    let last = 200;
    for (let index = 0; index < 125; index += 1) last = (await post(rpc("ping"), bearer(readToken))).status;
    expect(last).toBe(429);
  });
});
