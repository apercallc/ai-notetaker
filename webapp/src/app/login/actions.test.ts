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
const originalManagedHosting = process.env.MANAGED_HOSTING;
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => cookieStore), headers: vi.fn(async () => new Headers({ host: "localhost:3000" })) }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

const { bootstrap, login, signup, logout } = await import("./actions");

function formData(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  delete process.env.MANAGED_HOSTING;
  await prisma.loginThrottle.deleteMany();
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
  if (originalManagedHosting === undefined) delete process.env.MANAGED_HOSTING;
  else process.env.MANAGED_HOSTING = originalManagedHosting;
});

describe("bootstrap", () => {
  const SETUP_TOKEN = process.env.AUTH_TOKEN ?? "";

  it("creates the first user as owner and sets a resolvable session cookie", async () => {
    await expect(
      bootstrap(formData({ setupToken: SETUP_TOKEN, email: "owner@example.com", password: "correct horse battery", confirmPassword: "correct horse battery" })),
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
      bootstrap(formData({ setupToken: SETUP_TOKEN, email: "new@example.com", password: "correct horse battery", confirmPassword: "correct horse battery" })),
    ).rejects.toThrow("REDIRECT:/login");
    expect(await prisma.user.count()).toBe(1);
  });

  it("rejects mismatched passwords without creating a user", async () => {
    await expect(
      bootstrap(formData({ setupToken: SETUP_TOKEN, email: "owner@example.com", password: "correct horse battery", confirmPassword: "different password" })),
    ).rejects.toThrow(/REDIRECT:\/login/);
    expect(await prisma.user.count()).toBe(0);
  });

  it("rejects a wrong or missing setup token without creating a user, even with valid credentials otherwise", async () => {
    await expect(
      bootstrap(formData({ setupToken: "wrong-token", email: "attacker@example.com", password: "correct horse battery", confirmPassword: "correct horse battery" })),
    ).rejects.toThrow(/REDIRECT:\/login/);
    await expect(
      bootstrap(formData({ email: "attacker@example.com", password: "correct horse battery", confirmPassword: "correct horse battery" })),
    ).rejects.toThrow(/REDIRECT:\/login/);
    expect(await prisma.user.count()).toBe(0);
  });
});

describe("managed signup", () => {
  it("creates a separate tenant owner when managed hosting is enabled", async () => {
    process.env.MANAGED_HOSTING = "true";
    for (const name of ["S3_BUCKET", "MANAGED_WORKER_TOKEN", "MANAGED_DEEPGRAM_API_KEY", "MANAGED_ANTHROPIC_API_KEY", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_HOSTED_PRO", "STRIPE_PRICE_HOSTED_TEAM"]) vi.stubEnv(name, "test-only");
    vi.stubEnv("APP_URL", "http://localhost:3000");
    vi.stubEnv("ALLOW_UNVERIFIED_SIGNUP", "true");
    await expect(
      signup(formData({ workspaceName: "Acme Notes", email: "acme@example.com", password: "correct horse battery", confirmPassword: "correct horse battery", acceptTerms: "on" })),
    ).rejects.toThrow("REDIRECT:/meetings");

    const user = await prisma.user.findUniqueOrThrow({ where: { email: "acme@example.com" } });
    const membership = await prisma.workspaceMembership.findUniqueOrThrow({ where: { userId_workspaceId: { userId: user.id, workspaceId: (await prisma.workspace.findFirstOrThrow({ where: { name: "Acme Notes" } })).id } } });
    expect(membership.role).toBe("owner");
    expect(membership.workspaceId).not.toBe((await prisma.workspace.findFirstOrThrow({ where: { isDefault: true } })).id);
  });

  it("does not expose managed signup on self-hosted instances", async () => {
    delete process.env.MANAGED_HOSTING;
    await expect(
      signup(formData({ workspaceName: "Should not exist", email: "blocked@example.com", password: "correct horse battery", confirmPassword: "correct horse battery" })),
    ).rejects.toThrow("REDIRECT:/login?tab=signup&error=signup-disabled");
    expect(await prisma.user.findUnique({ where: { email: "blocked@example.com" } })).toBeNull();
  });
});

describe("login", () => {
  async function seedUser(email: string, password: string) {
    const passwordHash = await hashPassword(password);
    const workspace = await prisma.workspace.findFirstOrThrow({ where: { isDefault: true } });
    return prisma.user.create({ data: { email, passwordHash, emailVerifiedAt: new Date(), memberships: { create: { workspaceId: workspace.id, role: "owner" } } } });
  }

  it("rejects a wrong password", async () => {
    await seedUser("person@example.com", "the real password");
    await expect(
      login(formData({ email: "person@example.com", password: "wrong password", next: "/meetings" })),
    ).rejects.toThrow(/REDIRECT:\/login\?error=invalid/);
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
