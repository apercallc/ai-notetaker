import { describe, expect, it, beforeEach, afterAll, vi } from "vitest";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/passwords";
import { getSessionUser } from "@/lib/sessions";
import { getUserRole } from "@/lib/workspaces";

// No existing server-action test in this codebase mocks next/headers or
// next/navigation yet — this establishes the pattern other action tests
// (e.g. src/app/team/actions.test.ts) reuse. redirect() throws (matching
// its real behavior of throwing a special control-flow error caught by
// Next's rendering pipeline) so tests can assert on where a call redirects
// to; cookies() returns a plain mock object whose set() calls are
// inspectable, since real state doesn't matter — what matters is that the
// session id it was set to actually resolves via the real (unmocked)
// getSessionUser.
const cookieStore = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => cookieStore) }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

const { bootstrap, login, logout } = await import("./actions");

function formData(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
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

describe("bootstrap", () => {
  it("creates the first user as owner and sets a resolvable session cookie", async () => {
    await expect(
      bootstrap(formData({ email: "owner@example.com", password: "correct horse battery", confirmPassword: "correct horse battery" })),
    ).rejects.toThrow("REDIRECT:/meetings");

    const user = await prisma.user.findUniqueOrThrow({ where: { email: "owner@example.com" } });
    const workspace = await prisma.workspace.findFirstOrThrow({ where: { isDefault: true } });
    expect(await getUserRole(user.id, workspace.id)).toBe("owner");

    expect(cookieStore.set).toHaveBeenCalledWith("session", expect.any(String), expect.objectContaining({ httpOnly: true }));
    const sessionId = cookieStore.set.mock.calls[0][1] as string;
    expect((await getSessionUser(sessionId))?.id).toBe(user.id);
  });

  it("refuses to bootstrap a second account once one exists", async () => {
    await prisma.user.create({ data: { email: "existing@example.com", passwordHash: "irrelevant" } });

    await expect(
      bootstrap(formData({ email: "new@example.com", password: "correct horse battery", confirmPassword: "correct horse battery" })),
    ).rejects.toThrow("REDIRECT:/login");
    expect(await prisma.user.count()).toBe(1);
  });

  it("rejects mismatched passwords without creating a user", async () => {
    await expect(
      bootstrap(formData({ email: "owner@example.com", password: "correct horse battery", confirmPassword: "different password" })),
    ).rejects.toThrow(/REDIRECT:\/login/);
    expect(await prisma.user.count()).toBe(0);
  });
});

describe("login", () => {
  async function seedUser(email: string, password: string) {
    const passwordHash = await hashPassword(password);
    return prisma.user.create({ data: { email, passwordHash } });
  }

  it("rejects a wrong password", async () => {
    await seedUser("person@example.com", "the real password");
    await expect(
      login(formData({ email: "person@example.com", password: "wrong password", next: "/meetings" })),
    ).rejects.toThrow(/REDIRECT:\/login\?error=1/);
  });

  it("accepts a correct password and sets a session cookie that resolves to that user", async () => {
    const user = await seedUser("person@example.com", "the real password");
    await expect(
      login(formData({ email: "person@example.com", password: "the real password", next: "/meetings" })),
    ).rejects.toThrow("REDIRECT:/meetings");

    const sessionId = cookieStore.set.mock.calls[0][1] as string;
    expect((await getSessionUser(sessionId))?.id).toBe(user.id);
  });
});

describe("logout", () => {
  it("deletes the Session row, not just the cookie", async () => {
    const user = await prisma.user.create({ data: { email: "person@example.com", passwordHash: "irrelevant" } });
    const session = await prisma.session.create({ data: { userId: user.id, expiresAt: new Date(Date.now() + 100_000) } });
    cookieStore.get.mockReturnValue({ value: session.id });

    await expect(logout()).rejects.toThrow("REDIRECT:/login");

    expect(await prisma.session.findUnique({ where: { id: session.id } })).toBeNull();
  });
});
