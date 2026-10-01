import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { addWorkspaceMember, createWorkspaceWithOwner } from "@/lib/workspaces";

const cookieStore = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => cookieStore) }));

const { GET } = await import("./route");

async function signIn(userId: string): Promise<void> {
  const session = await prisma.session.create({ data: { userId, expiresAt: new Date(Date.now() + 100_000) } });
  cookieStore.get.mockReturnValue({ value: session.id });
}

async function reset() {
  await prisma.auditEvent.deleteMany();
  await prisma.session.deleteMany();
  await prisma.workspaceSubscription.deleteMany();
  await prisma.workspaceMembership.deleteMany();
  await prisma.user.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.workspace.create({ data: { name: "My Workspace", isDefault: true } });
}

beforeEach(async () => {
  vi.clearAllMocks();
  delete process.env.MANAGED_HOSTING;
  await reset();
});

afterAll(async () => {
  await reset();
  await prisma.$disconnect();
});

const get = (query = "") => GET(new Request(`http://localhost/team/audit/export${query}`));

describe("activity log export", () => {
  it("requires a session and an owner", async () => {
    cookieStore.get.mockReturnValue(undefined);
    expect((await get()).status).toBe(401);
    const { workspaceId } = await createWorkspaceWithOwner("owner@example.com", "hash");
    const { userId: memberId } = await addWorkspaceMember(workspaceId, "member@example.com", "hash2");
    await signIn(memberId);
    expect((await get()).status).toBe(403);
  });

  it("downloads the owner's workspace log as CSV, filtered, and only that workspace's", async () => {
    const { userId, workspaceId } = await createWorkspaceWithOwner("owner@example.com", "hash");
    const other = { workspaceId: (await prisma.workspace.create({ data: { name: "Other workspace" } })).id, userId: userId };
    await prisma.auditEvent.createMany({ data: [
      { workspaceId, actorUserId: userId, action: "folder.create" },
      { workspaceId, actorUserId: userId, action: "member.add" },
      { workspaceId: other.workspaceId, actorUserId: other.userId, action: "member.add" },
    ] });
    await signIn(userId);

    const all = await get();
    expect(all.status).toBe(200);
    expect(all.headers.get("content-type")).toContain("text/csv");
    expect(all.headers.get("content-disposition")).toMatch(/^attachment; filename="activity-log-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect((await all.text()).trim().split("\r\n")).toHaveLength(3);
    const filtered = await (await get("?category=members")).text();
    expect(filtered).toContain("member.add");
    expect(filtered).not.toContain("folder.create");
    expect(filtered.trim().split("\r\n")).toHaveLength(2);
  });

  it("is refused on the hosted service without a Team plan", async () => {
    process.env.MANAGED_HOSTING = "true";
    const { userId, workspaceId } = await createWorkspaceWithOwner("owner@example.com", "hash");
    await signIn(userId);
    expect((await get()).status).toBe(403);
    await prisma.workspaceSubscription.create({ data: { workspaceId, plan: "hosted_team", status: "active" } });
    expect((await get()).status).toBe(200);
  });
});
