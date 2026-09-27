import { describe, expect, it, beforeEach, afterAll, vi } from "vitest";
import { prisma } from "@/lib/db";
import { createWorkspaceWithOwner, addWorkspaceMember, getUserRole } from "@/lib/workspaces";

// Mirrors the mocking pattern established in src/app/login/actions.test.ts:
// cookies() returns an inspectable mock, redirect() throws so a call site's
// destination is assertable.
const cookieStore = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => cookieStore) }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { addMember, updateRetentionPolicy } = await import("./actions");

function formData(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

async function sessionCookieFor(userId: string): Promise<void> {
  const session = await prisma.session.create({ data: { userId, expiresAt: new Date(Date.now() + 100_000) } });
  cookieStore.get.mockReturnValue({ value: session.id });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await prisma.session.deleteMany();
  await prisma.workspaceMembership.deleteMany();
  await prisma.user.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.workspace.create({ data: { name: "My Workspace", isDefault: true } });
});

afterAll(async () => {
  await prisma.session.deleteMany();
  await prisma.workspaceMembership.deleteMany();
  await prisma.user.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.$disconnect();
});

describe("addMember", () => {
  it("lets an owner add a member and returns a one-time password", async () => {
    const { userId: ownerId, workspaceId } = await createWorkspaceWithOwner("owner@example.com", "hash");
    await sessionCookieFor(ownerId);

    const result = await addMember(formData({ email: "teammate@example.com" }));

    expect(result).toMatchObject({ ok: true, email: "teammate@example.com" });
    if (!result.ok) throw new Error("expected success");
    expect(result.temporaryPassword.length).toBeGreaterThan(8);
    const member = await prisma.user.findUniqueOrThrow({ where: { email: "teammate@example.com" } });
    expect(await getUserRole(member.id, workspaceId)).toBe("member");
  });

  // Expected failures are returned, not thrown: Next.js masks the message of
  // anything thrown out of a Server Action in production, so a thrown
  // "only the owner can do this" reached the user as a generic server error.
  it("rejects a member (non-owner) trying to add another member", async () => {
    const { workspaceId } = await createWorkspaceWithOwner("owner@example.com", "hash");
    const { userId: memberId } = await addWorkspaceMember(workspaceId, "member@example.com", "hash2");
    await sessionCookieFor(memberId);

    const result = await addMember(formData({ email: "new@example.com" }));

    expect(result).toEqual({ ok: false, error: "Only the workspace owner can add members." });
    expect(await prisma.user.count()).toBe(2); // owner + the one existing member, no new user created
  });

  it("reports a duplicate email instead of surfacing a raw database error", async () => {
    const { userId: ownerId, workspaceId } = await createWorkspaceWithOwner("owner@example.com", "hash");
    await addWorkspaceMember(workspaceId, "teammate@example.com", "hash2");
    await sessionCookieFor(ownerId);

    const result = await addMember(formData({ email: "teammate@example.com" }));

    expect(result).toEqual({ ok: false, error: "Could not add this address. Send an invitation instead." });
    expect(await prisma.user.count()).toBe(2);
  });

  it("asks for an email rather than creating a member with a blank one", async () => {
    const { userId: ownerId } = await createWorkspaceWithOwner("owner@example.com", "hash");
    await sessionCookieFor(ownerId);

    const result = await addMember(formData({ email: "   " }));

    expect(result).toEqual({ ok: false, error: "Enter an email address." });
    expect(await prisma.user.count()).toBe(1);
  });
});

describe("workspace membership creation", () => {
  it("never leaves a user without a membership", async () => {
    // A User with no membership is unrecoverable: requireSession bounces them
    // to /login for having no workspace, while bootstrap's hasAnyUser() check
    // now sees an account and refuses to let anyone claim the instance.
    const { userId } = await createWorkspaceWithOwner("owner@example.com", "hash");
    expect(await prisma.workspaceMembership.count({ where: { userId } })).toBe(1);

    // A duplicate email fails the transaction; no half-created user survives.
    await expect(
      createWorkspaceWithOwner("owner@example.com", "hash"),
    ).rejects.toThrow();

    const orphans = await prisma.user.findMany({ where: { memberships: { none: {} } } });
    expect(orphans).toEqual([]);
  });
});

describe("retention policy", () => {
  it("lets an owner save a bounded hosted retention policy", async () => {
    const { userId: ownerId, workspaceId } = await createWorkspaceWithOwner("owner@example.com", "hash");
    await sessionCookieFor(ownerId);

    await expect(updateRetentionPolicy(formData({ retentionDays: "30" }))).resolves.toEqual({ ok: true, retentionDays: 30 });
    await expect(prisma.workspace.findUnique({ where: { id: workspaceId }, select: { retentionDays: true } })).resolves.toEqual({ retentionDays: 30 });
    await expect(updateRetentionPolicy(formData({ retentionDays: "never" }))).resolves.toEqual({ ok: true, retentionDays: null });
  });

  it("rejects invalid retention values and non-owner changes", async () => {
    const { workspaceId } = await createWorkspaceWithOwner("owner@example.com", "hash");
    const { userId: memberId } = await addWorkspaceMember(workspaceId, "member@example.com", "hash2");
    await sessionCookieFor(memberId);
    await expect(updateRetentionPolicy(formData({ retentionDays: "30" }))).resolves.toEqual({ ok: false, error: "Only the workspace owner can change retention." });

    const { userId: ownerId } = await prisma.workspaceMembership.findFirstOrThrow({ where: { workspaceId, role: "owner" }, select: { userId: true } });
    await sessionCookieFor(ownerId);
    await expect(updateRetentionPolicy(formData({ retentionDays: "0" }))).resolves.toEqual({ ok: false, error: "Choose never or a value from 1 to 3650 days." });
  });
});
