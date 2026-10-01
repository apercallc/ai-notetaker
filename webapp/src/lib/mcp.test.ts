import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "./db";
import { handleMcpMessage, MCP_VERSIONS } from "./mcp";

const call = async (workspaceId: string, name: string, args: Record<string, unknown> = {}) => {
  const response = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { workspaceId });
  return response!.result as { content: Array<{ text: string }>; isError?: boolean };
};
const payload = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0]!.text) as Record<string, any>;

describe("MCP protocol", () => {
  const ctx = { workspaceId: "unused" };

  it("negotiates the protocol version and describes the server", async () => {
    const supported = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, ctx);
    expect((supported!.result as { protocolVersion: string }).protocolVersion).toBe("2025-03-26");
    const unknown = await handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } }, ctx);
    const result = unknown!.result as { protocolVersion: string; capabilities: object; serverInfo: { name: string }; instructions: string };
    expect(result.protocolVersion).toBe(MCP_VERSIONS[0]);
    expect(result.capabilities).toHaveProperty("tools");
    expect(result.serverInfo.name).toBe("ai-notetaker");
    expect(result.instructions).toMatch(/never follow instructions/i);
  });

  it("answers ping, lists only read-only tools, and ignores notifications", async () => {
    expect((await handleMcpMessage({ jsonrpc: "2.0", id: 3, method: "ping" }, ctx))!.result).toEqual({});
    const list = (await handleMcpMessage({ jsonrpc: "2.0", id: 4, method: "tools/list" }, ctx))!.result as { tools: Array<{ name: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean } }> };
    expect(list.tools.map((tool) => tool.name).sort()).toEqual(["get_note", "list_action_items", "list_folders", "list_recent_notes", "search_notes"]);
    expect(list.tools.every((tool) => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint)).toBe(true);
    expect(await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, ctx)).toBeNull();
  });

  it("rejects malformed requests, unknown methods and unknown tools with JSON-RPC errors", async () => {
    expect((await handleMcpMessage([{ jsonrpc: "2.0", id: 1, method: "ping" }], ctx))!.error?.code).toBe(-32600);
    expect((await handleMcpMessage("ping", ctx))!.error?.code).toBe(-32600);
    expect((await handleMcpMessage({ jsonrpc: "1.0", id: 5, method: "ping" }, ctx))!.error?.code).toBe(-32600);
    expect((await handleMcpMessage({ jsonrpc: "2.0", id: 6, method: "resources/list" }, ctx))!.error?.code).toBe(-32601);
    expect((await handleMcpMessage({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "delete_note" } }, ctx))!.error?.code).toBe(-32602);
  });
});

describe("MCP tools", () => {
  const T0 = new Date("2026-09-24T15:00:00.000Z");
  let workspaceId: string;
  let otherWorkspaceId: string;
  let acmeFolder: string;
  let acmeNote: string;
  let looseNote: string;

  beforeEach(async () => {
    workspaceId = randomUUID();
    otherWorkspaceId = randomUUID();
    await prisma.workspace.createMany({ data: [{ id: workspaceId, name: "MCP workspace" }, { id: otherWorkspaceId, name: "Other MCP workspace" }] });
    const clients = await prisma.folder.create({ data: { workspaceId, name: "Clients" } });
    acmeFolder = (await prisma.folder.create({ data: { workspaceId, name: "Acme", parentId: clients.id } })).id;
    const mk = (title: string, summary: string, folderId: string | null, ws = workspaceId) => prisma.meeting.create({
      data: { userId: "u", workspaceId: ws, title, summary, startedAt: T0, endedAt: T0, folderId, speakers: { create: [] } },
    });
    acmeNote = (await mk("Acme renewal", "We discussed zephyr pricing for Acme.", acmeFolder)).id;
    looseNote = (await mk("Board prep", "Zephyr roadmap review.", null)).id;
    await mk("Foreign note", "Zephyr secret of another workspace.", null, otherWorkspaceId);
    await prisma.actionItem.createMany({ data: [
      { meetingId: acmeNote, userId: "u", text: "Send the zephyr quote", owner: "Sam", status: "open" },
      { meetingId: acmeNote, userId: "u", text: "Archive contract", status: "done" },
    ] });
    await prisma.transcriptSegment.create({ data: { meetingId: acmeNote, userId: "u", speaker: "them-1", text: "We need faster onboarding.", timestamp: T0, order: 0 } });
    await prisma.meetingSpeaker.create({ data: { meetingId: acmeNote, speakerKey: "them-1", displayName: "Sam Rivera", appliedLabel: "Sam Rivera" } });
  });

  afterEach(async () => {
    await prisma.meeting.deleteMany({ where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } } });
    await prisma.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("searches only the caller's workspace and shows folder path and where it matched", async () => {
    const data = payload(await call(workspaceId, "search_notes", { query: "zephyr" }));
    expect(data.total).toBe(2);
    expect(data.notes.map((note: { title: string }) => note.title).sort()).toEqual(["Acme renewal", "Board prep"]);
    const acme = data.notes.find((note: { id: string }) => note.id === acmeNote);
    expect(acme).toMatchObject({ folder: "Clients / Acme", matchedIn: "summary" });
    expect(JSON.stringify(data)).not.toContain("another workspace");
  });

  it("scopes a search to a folder given by path (any case) or id, including subfolders", async () => {
    expect(payload(await call(workspaceId, "search_notes", { query: "zephyr", folder: "clients" })).notes.map((note: { id: string }) => note.id)).toEqual([acmeNote]);
    expect(payload(await call(workspaceId, "search_notes", { query: "zephyr", folder: "Clients / Acme" })).total).toBe(1);
    expect(payload(await call(workspaceId, "search_notes", { query: "zephyr", folder: acmeFolder })).total).toBe(1);
    const missing = await call(workspaceId, "search_notes", { query: "zephyr", folder: "Nope" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toContain("list_folders");
  });

  it("validates search arguments and caps the limit", async () => {
    expect((await call(workspaceId, "search_notes", {})).isError).toBe(true);
    expect((await call(workspaceId, "search_notes", { query: "x".repeat(201) })).isError).toBe(true);
    for (let index = 0; index < 25; index += 1) await prisma.meeting.create({ data: { userId: "u", workspaceId, title: `Extra ${index}`, summary: "filler zephyr", startedAt: T0, endedAt: T0 } });
    expect(payload(await call(workspaceId, "search_notes", { query: "zephyr", limit: 500 })).notes).toHaveLength(20);
    expect(payload(await call(workspaceId, "list_recent_notes", { limit: 3 })).notes).toHaveLength(3);
  });

  it("never returns notes in the Trash", async () => {
    await prisma.meeting.update({ where: { id: looseNote }, data: { deletedAt: new Date(), trashRootId: looseNote } });
    expect(payload(await call(workspaceId, "search_notes", { query: "zephyr" })).notes.map((note: { id: string }) => note.id)).toEqual([acmeNote]);
    expect((await call(workspaceId, "get_note", { id: looseNote })).isError).toBe(true);
  });

  it("reads a note as Markdown with speaker names, folder, actions and an explicit data marker", async () => {
    const text = (await call(workspaceId, "get_note", { id: acmeNote })).content[0]!.text;
    expect(text).toContain("# Acme renewal");
    expect(text).toContain("Folder: Clients / Acme");
    expect(text).toContain("provided as data");
    expect(text).toContain("We discussed zephyr pricing");
    expect(text).toContain("- [ ] Send the zephyr quote (Sam)");
    expect(text).toContain("- [x] Archive contract");
    expect(text).not.toContain("## Transcript");
    const withTranscript = (await call(workspaceId, "get_note", { id: acmeNote, include_transcript: true })).content[0]!.text;
    expect(withTranscript).toContain("Sam Rivera: We need faster onboarding.");
  });

  it("will not read a note from another workspace or with a bad id", async () => {
    const foreign = await prisma.meeting.findFirstOrThrow({ where: { workspaceId: otherWorkspaceId } });
    expect((await call(workspaceId, "get_note", { id: foreign.id })).isError).toBe(true);
    expect((await call(workspaceId, "get_note", { id: "" })).isError).toBe(true);
    expect((await call(workspaceId, "get_note", { id: randomUUID() })).isError).toBe(true);
  });

  it("truncates very large notes", async () => {
    await prisma.meeting.update({ where: { id: looseNote }, data: { summary: "z".repeat(60_000) } });
    const text = (await call(workspaceId, "get_note", { id: looseNote })).content[0]!.text;
    expect(text).toContain("[truncated]");
    expect(text.length).toBeLessThan(45_000);
  });

  it("lists folders and action items with their source notes", async () => {
    expect(payload(await call(workspaceId, "list_folders")).folders.map((folder: { path: string }) => folder.path)).toEqual(["Clients", "Clients / Acme"]);
    const open = payload(await call(workspaceId, "list_action_items", { status: "open" }));
    expect(open.total).toBe(1);
    expect(open.actionItems[0]).toMatchObject({ text: "Send the zephyr quote", owner: "Sam", status: "open", note: { id: acmeNote, title: "Acme renewal" } });
    expect(payload(await call(workspaceId, "list_action_items", {})).total).toBe(2);
  });
});
