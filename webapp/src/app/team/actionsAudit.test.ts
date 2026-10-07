import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { addWorkspaceMember, createWorkspaceWithOwner } from "@/lib/workspaces";

const cookieStore = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => cookieStore) }));
vi.mock("next/navigation", () => ({ redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { manageTeam, updateRetentionPolicy } = await import("./actions");
const { requireSession } = await import("@/lib/currentUser");
const { addMemberAs } = await import("@/lib/teamAdmin");

// Members are added through the REST team route (addMemberAs); exercise it under a real session here.
const addMember = async (data: FormData) => addMemberAs(await requireSession(), String(data.get("email") ?? ""));

function formData(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

async function signIn(userId: string): Promise<void> {
  const session = await prisma.session.create({ data: { userId, expiresAt: new Date(Date.now() + 100_000) } });
  cookieStore.get.mockReturnValue({ value: session.id });
}

async function reset() {
  await prisma.auditEvent.deleteMany();
  await prisma.session.deleteMany();
  await prisma.workspaceMembership.deleteMany();
  await prisma.user.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.workspace.create({ data: { name: "My Workspace", isDefault: true } });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await reset();
});

afterAll(async () => {
  await reset();
  await prisma.$disconnect();
});

describe("team actions write audit events", () => {
  it("records adding a member, changing a role and removing a member by id, not by content", async () => {
    const { userId: ownerId, workspaceId } = await createWorkspaceWithOwner("owner@example.com", "hash");
    await signIn(ownerId);

    const added = await addMember(formData({ email: "teammate@example.com" }));
    expect(added.ok).toBe(true);
    const teammate = await prisma.user.findUniqueOrThrow({ where: { email: "teammate@example.com" } });
    const membership = await prisma.workspaceMembership.findFirstOrThrow({ where: { userId: teammate.id, workspaceId } });

    await manageTeam(formData({ operation: "role", id: membership.id, role: "owner" }));
    await manageTeam(formData({ operation: "remove", id: membership.id }));

    const events = await prisma.auditEvent.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" } });
    expect(events.map((event) => event.action)).toEqual(["member.add", "member.role_change", "member.remove"]);
    expect(events.every((event) => event.actorUserId === ownerId)).toBe(true);
    expect(events[1]).toMatchObject({ targetId: teammate.id, metadata: { role: "owner" } });
    expect(JSON.stringify(events)).not.toContain("hash");
  });

  it("records a retention policy change with the new value", async () => {
    const { userId: ownerId, workspaceId } = await createWorkspaceWithOwner("owner@example.com", "hash");
    await signIn(ownerId);
    await updateRetentionPolicy(formData({ retentionDays: "90" }));
    expect(await prisma.auditEvent.findFirstOrThrow({ where: { workspaceId, action: "workspace.retention_update" } })).toMatchObject({ actorUserId: ownerId, metadata: { retentionDays: 90 } });
  });

  it("records nothing when a non-owner is refused", async () => {
    const { workspaceId } = await createWorkspaceWithOwner("owner@example.com", "hash");
    const { userId: memberId } = await addWorkspaceMember(workspaceId, "member@example.com", "hash2");
    await signIn(memberId);
    await updateRetentionPolicy(formData({ retentionDays: "30" }));
    expect(await prisma.auditEvent.count({ where: { workspaceId } })).toBe(0);
  });
});
