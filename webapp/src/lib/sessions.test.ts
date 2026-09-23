import { describe, expect, it, beforeEach, afterAll } from "vitest";
import { prisma } from "./db";
import { createSession, getSessionUser, deleteSession } from "./sessions";

beforeEach(async () => {
  await prisma.session.deleteMany();
  await prisma.workspaceMembership.deleteMany();
  await prisma.user.deleteMany();
});

afterAll(async () => {
  await prisma.session.deleteMany();
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
});
