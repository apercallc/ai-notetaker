import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "./db";
import { AUDIT_RETENTION_DAYS, purgeExpiredAuditEvents, recordAudit, sanitizeAuditMetadata } from "./audit";

describe("sanitizeAuditMetadata", () => {
  it("keeps small scalar facts", () => {
    expect(sanitizeAuditMetadata({ role: "owner", count: 3, delivered: false, previous: null })).toEqual({ role: "owner", count: 3, delivered: false, previous: null });
  });

  it("drops anything that looks like a credential or note content, whatever the caller passes", () => {
    const result = sanitizeAuditMetadata({
      apiToken: "ant_secret",
      password: "hunter2",
      sessionCookie: "abc",
      transcriptText: "hello",
      summary: "notes",
      note: "private",
      authorization: "Bearer x",
      role: "member",
    });
    expect(result).toEqual({ role: "member" });
  });

  it("drops nested values, non-finite numbers and long keys; truncates long strings", () => {
    const result = sanitizeAuditMetadata({ nested: { a: 1 }, list: [1, 2], bad: Number.NaN, ["k".repeat(61)]: "x", label: "z".repeat(500) });
    expect(result).toEqual({ label: "z".repeat(200) });
  });

  it("returns undefined when nothing survives", () => {
    expect(sanitizeAuditMetadata(undefined)).toBeUndefined();
    expect(sanitizeAuditMetadata({ password: "x" })).toBeUndefined();
  });

  it("caps the number of keys", () => {
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`f${index}`, index]));
    expect(Object.keys(sanitizeAuditMetadata(many) ?? {})).toHaveLength(12);
  });
});

describe("recordAudit and purge", () => {
  const workspaceId = randomUUID();

  beforeEach(async () => {
    await prisma.workspace.create({ data: { id: workspaceId, name: "Audit workspace" } });
  });

  afterEach(async () => {
    await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("stores the actor, action, target and sanitized metadata", async () => {
    const actorUserId = randomUUID();
    expect(await recordAudit({ workspaceId, actorUserId, action: "share.create", targetType: "meeting", targetId: "m-1", metadata: { expiresInDays: 7, shareToken: "never-stored" } })).toBe(true);
    const event = await prisma.auditEvent.findFirstOrThrow({ where: { workspaceId } });
    expect(event).toMatchObject({ actorUserId, action: "share.create", targetType: "meeting", targetId: "m-1", metadata: { expiresInDays: 7 } });
  });

  it("records a system action with no actor", async () => {
    await recordAudit({ workspaceId, action: "meeting.retention_delete", metadata: { count: 2 } });
    expect(await prisma.auditEvent.findFirstOrThrow({ where: { workspaceId } })).toMatchObject({ actorUserId: null });
  });

  it("never throws: a failed write returns false and logs no payload", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // A workspace that does not exist violates the foreign key.
    const result = await recordAudit({ workspaceId: randomUUID(), action: "member.add", metadata: { email: "private@example.test" } });
    expect(result).toBe(false);
    expect(JSON.stringify(log.mock.calls)).not.toContain("private@example.test");
  });

  it("is removed with its workspace", async () => {
    await recordAudit({ workspaceId, action: "member.add" });
    await prisma.workspace.delete({ where: { id: workspaceId } });
    expect(await prisma.auditEvent.count({ where: { workspaceId } })).toBe(0);
  });

  it("purges only events past retention, in a bounded batch", async () => {
    const old = new Date(Date.now() - (AUDIT_RETENTION_DAYS + 1) * 24 * 3_600_000);
    await prisma.auditEvent.createMany({ data: [
      { workspaceId, action: "member.add", createdAt: old },
      { workspaceId, action: "member.add", createdAt: old },
      { workspaceId, action: "member.remove" },
    ] });
    expect(await purgeExpiredAuditEvents(new Date(), true)).toBe(2);
    expect(await prisma.auditEvent.findMany({ where: { workspaceId } })).toHaveLength(1);
    // The hourly throttle makes an immediate second call a no-op.
    expect(await purgeExpiredAuditEvents(new Date())).toBe(0);
  });
});
