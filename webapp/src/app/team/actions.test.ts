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

const { addMember } = await import("./actions");
const { ForbiddenError } = await import("./errors");

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

    expect(result.email).toBe("teammate@example.com");
    expect(result.temporaryPassword.length).toBeGreaterThan(8);
    const member = await prisma.user.findUniqueOrThrow({ where: { email: "teammate@example.com" } });
    expect(await getUserRole(member.id, workspaceId)).toBe("member");
  });

  it("rejects a member (non-owner) trying to add another member", async () => {
    const { workspaceId } = await createWorkspaceWithOwner("owner@example.com", "hash");
    const { userId: memberId } = await addWorkspaceMember(workspaceId, "member@example.com", "hash2");
    await sessionCookieFor(memberId);

    await expect(addMember(formData({ email: "new@example.com" }))).rejects.toThrow(ForbiddenError);
    expect(await prisma.user.count()).toBe(2); // owner + the one existing member, no new user created
  });
});
