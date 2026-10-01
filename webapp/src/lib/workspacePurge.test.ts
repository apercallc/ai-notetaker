import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "./db";
import { deleteAccount, purgeWorkspace } from "./workspacePurge";

const PREFIX = "purge.batch.";
const created = { workspaces: [] as string[], users: [] as string[] };

async function makeUser(label: string): Promise<string> {
  const user = await prisma.user.create({ data: { email: `${PREFIX}${label}.${randomUUID()}@example.test`, passwordHash: "x", emailVerifiedAt: new Date() } });
  created.users.push(user.id);
  return user.id;
}

async function makeWorkspace(name: string, members: Array<{ userId: string; role: "owner" | "member" }>): Promise<string> {
  const workspace = await prisma.workspace.create({ data: { name: `${PREFIX}${name}`, isDefault: false } });
  created.workspaces.push(workspace.id);
  for (const member of members) await prisma.workspaceMembership.create({ data: { workspaceId: workspace.id, ...member } });
  return workspace.id;
}

beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = "sk_purge";
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: created.workspaces } } });
  await prisma.user.deleteMany({ where: { id: { in: created.users } } });
  await prisma.$disconnect();
});

describe("deleteAccount", () => {
  it("purges workspaces the person owns alone, including the subscription, and deletes the user", async () => {
    const userId = await makeUser("solo");
    const workspaceId = await makeWorkspace("solo", [{ userId, role: "owner" }]);
    await prisma.workspaceSubscription.create({ data: { workspaceId, plan: "hosted_pro", status: "active", stripeSubscriptionId: "sub_purge_solo" } });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    await expect(deleteAccount(userId)).resolves.toEqual({ ok: true });
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("subscriptions/sub_purge_solo");
    expect(await prisma.workspace.findUnique({ where: { id: workspaceId } })).toBeNull();
    expect(await prisma.user.findUnique({ where: { id: userId } })).toBeNull();
  });

  it("refuses when the person is the only owner of a workspace that has other members, deleting nothing", async () => {
    const owner = await makeUser("owner");
    const member = await makeUser("member");
    const workspaceId = await makeWorkspace("shared", [{ userId: owner, role: "owner" }, { userId: member, role: "member" }]);

    const result = await deleteAccount(owner);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("other members") });
    expect(await prisma.workspace.findUnique({ where: { id: workspaceId } })).not.toBeNull();
    expect(await prisma.user.findUnique({ where: { id: owner } })).not.toBeNull();
  });

  it("only removes the person from workspaces where another owner remains, or where they are a member", async () => {
    const leaver = await makeUser("leaver");
    const other = await makeUser("other");
    const coOwned = await makeWorkspace("co-owned", [{ userId: leaver, role: "owner" }, { userId: other, role: "owner" }]);
    const guest = await makeWorkspace("guest", [{ userId: other, role: "owner" }, { userId: leaver, role: "member" }]);

    await expect(deleteAccount(leaver)).resolves.toEqual({ ok: true });
    expect(await prisma.user.findUnique({ where: { id: leaver } })).toBeNull();
    expect(await prisma.workspace.findUnique({ where: { id: coOwned } })).not.toBeNull();
    expect(await prisma.workspace.findUnique({ where: { id: guest } })).not.toBeNull();
    expect(await prisma.workspaceMembership.count({ where: { workspaceId: { in: [coOwned, guest] } } })).toBe(2);
  });

  it("keeps everything if Stripe cannot cancel the subscription", async () => {
    const userId = await makeUser("stripe-down");
    const workspaceId = await makeWorkspace("stripe-down", [{ userId, role: "owner" }]);
    await prisma.workspaceSubscription.create({ data: { workspaceId, plan: "hosted_pro", status: "active", stripeSubscriptionId: "sub_purge_down" } });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 }));

    expect(await deleteAccount(userId)).toMatchObject({ ok: false, error: expect.stringContaining("nothing was deleted") });
    expect(await prisma.workspace.findUnique({ where: { id: workspaceId } })).not.toBeNull();
    expect(await prisma.user.findUnique({ where: { id: userId } })).not.toBeNull();
  });
});

describe("purgeWorkspace", () => {
  it("removes the workspace and member accounts that belong to nothing else", async () => {
    const a = await makeUser("a");
    const b = await makeUser("b");
    const other = await makeWorkspace("other", [{ userId: b, role: "owner" }]);
    const workspaceId = await makeWorkspace("purged", [{ userId: a, role: "owner" }, { userId: b, role: "member" }]);
    await expect(purgeWorkspace(workspaceId)).resolves.toEqual({ ok: true });
    expect(await prisma.user.findUnique({ where: { id: a } })).toBeNull();
    expect(await prisma.user.findUnique({ where: { id: b } })).not.toBeNull();
    expect(await prisma.workspace.findUnique({ where: { id: other } })).not.toBeNull();
  });

  it("reports a failed delete transaction as a normal error and leaves the workspace in place", async () => {
    const a = await makeUser("tx");
    const workspaceId = await makeWorkspace("tx-fails", [{ userId: a, role: "owner" }]);
    vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("Transaction already closed (P2028)"));
    const result = await purgeWorkspace(workspaceId);
    expect(result.ok).toBe(false);
    expect(await prisma.workspace.findUnique({ where: { id: workspaceId } })).not.toBeNull();
  });
});
