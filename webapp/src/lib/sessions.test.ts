import { describe, expect, it, beforeEach, afterAll } from "vitest";
import { prisma } from "./db";
import {
  createSession,
  getSessionContext,
  getSessionUser,
  deleteSession,
  deleteUserSessions,
  revokeUserSession,
  listUserSessions,
  setSessionActiveWorkspace,
  cleanupExpiredAuth,
  describeUserAgent,
} from "./sessions";

beforeEach(async () => {
  await prisma.session.deleteMany();
  await prisma.authToken.deleteMany();
  await prisma.apiToken.deleteMany();
  await prisma.workspaceMembership.deleteMany();
  await prisma.user.deleteMany();
});

afterAll(async () => {
  await prisma.session.deleteMany();
  await prisma.authToken.deleteMany();
  await prisma.apiToken.deleteMany();
  await prisma.workspaceMembership.deleteMany();
  await prisma.user.deleteMany();
  await prisma.$disconnect();
});

async function makeUser(email = "person@example.com") {
  return prisma.user.create({ data: { email, passwordHash: "irrelevant-for-this-test" } });
}

describe("createSession / getSessionUser / deleteSession", () => {
  it("creates a session and resolves it back to the user", async () => {
    const user = await makeUser();
    const session = await createSession(user.id);
    const resolved = await getSessionUser(session.id);
    expect(resolved?.id).toBe(user.id);
    expect(resolved?.email).toBe(user.email);
  });

  it("returns null for an unknown session id", async () => {
    expect(await getSessionUser("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("returns null for an undefined session id", async () => {
    expect(await getSessionUser(undefined)).toBeNull();
  });

  it("returns null for an expired session, and reaps the row", async () => {
    const user = await makeUser();
    const session = await createSession(user.id);
    await prisma.session.update({ where: { id: session.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    expect(await getSessionUser(session.id)).toBeNull();
    // Nothing else deletes these, so an abandoned session used to live in
    // the table forever.
    expect(await prisma.session.count({ where: { id: session.id } })).toBe(0);
  });

  it("deleteSession makes the session unresolvable", async () => {
    const user = await makeUser();
    const session = await createSession(user.id);
    await deleteSession(session.id);
    expect(await getSessionUser(session.id)).toBeNull();
  });

  it("stores bounded device metadata, touches stale sessions, and returns their active workspace", async () => {
    const user = await makeUser();
    const session = await createSession(user.id, {
      userAgent: "u".repeat(350),
      ip: "1".repeat(80),
      activeWorkspaceId: "workspace-picked-by-user",
    });
    const stored = await prisma.session.findUniqueOrThrow({ where: { id: session.id } });
    expect(stored.userAgent).toHaveLength(300);
    expect(stored.ip).toHaveLength(64);

    const fixedNow = Date.now() + 10 * 60_000;
    await prisma.session.update({ where: { id: session.id }, data: { lastUsedAt: new Date(fixedNow - 10 * 60_000) } });
    const context = await getSessionContext(session.id, fixedNow);
    expect(context).toMatchObject({ sessionId: session.id, user: { id: user.id }, activeWorkspaceId: "workspace-picked-by-user" });
    expect((await prisma.session.findUniqueOrThrow({ where: { id: session.id } })).lastUsedAt?.getTime()).toBe(fixedNow);
  });

  it("does not treat extension API tokens as browser session cookies", async () => {
    expect(await getSessionContext("ant_" + "a".repeat(40))).toBeNull();
  });

  it("revokes selected sessions and can preserve the current browser session", async () => {
    const user = await makeUser();
    const keep = await createSession(user.id);
    const remove = await createSession(user.id);
    const otherUser = await makeUser("other@example.com");
    const other = await createSession(otherUser.id);

    expect(await revokeUserSession(otherUser.id, remove.id)).toBe(false);
    expect(await deleteUserSessions(user.id, keep.id)).toBe(1);
    expect(await listUserSessions(user.id)).toHaveLength(1);
    expect(await revokeUserSession(user.id, keep.id)).toBe(true);
    expect(await revokeUserSession(user.id, keep.id)).toBe(false);
    expect(await listUserSessions(user.id)).toHaveLength(0);
    expect(await prisma.session.findUnique({ where: { id: other.id } })).not.toBeNull();
  });

  it("updates the active workspace and reaps expired browser, API, and auth tokens", async () => {
    const user = await makeUser();
    const session = await createSession(user.id);
    await setSessionActiveWorkspace(session.id, "workspace-2");
    expect((await prisma.session.findUniqueOrThrow({ where: { id: session.id } })).activeWorkspaceId).toBe("workspace-2");

    const now = Date.now();
    await prisma.session.create({ data: { userId: user.id, expiresAt: new Date(now - 1) } });
    await prisma.authToken.create({ data: { tokenHash: "1".repeat(64), purpose: "verify_email", email: user.email, expiresAt: new Date(now - 86_400_001) } });
    await prisma.authToken.create({ data: { tokenHash: "2".repeat(64), purpose: "verify_email", email: user.email, expiresAt: new Date(now + 86_400_000) } });
    await prisma.apiToken.create({ data: { userId: user.id, tokenHash: "3".repeat(64), label: "expired", expiresAt: new Date(now - 1) } });

    await cleanupExpiredAuth(now);
    expect(await prisma.session.count({ where: { userId: user.id, expiresAt: { lt: new Date(now) } } })).toBe(0);
    expect(await prisma.apiToken.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.authToken.count({ where: { email: user.email } })).toBe(1);
  });
});

describe("describeUserAgent", () => {
  it("labels known browser and operating-system combinations and safely falls back", () => {
    expect(describeUserAgent(null)).toBe("Unknown device");
    expect(describeUserAgent("Mozilla/5.0 Windows Chrome/120.0")).toBe("Chrome on Windows");
    expect(describeUserAgent("Mozilla/5.0 Mac OS X Safari/17.0")).toBe("Safari on macOS");
    expect(describeUserAgent("Mozilla/5.0 Android OPR/80.0")).toBe("Opera on Android");
    expect(describeUserAgent("Mozilla/5.0 iPhone Firefox/120.0")).toBe("Firefox on iOS");
    expect(describeUserAgent("custom-device/1")).toBe("custom-device/1");
    expect(describeUserAgent("x".repeat(50))).toHaveLength(40);
  });
});
