import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "./db";
import { AUDIT_ACTIONS } from "./audit";
import { AUDIT_ACTION_INFO, AUDIT_CATEGORIES, AUDIT_PAGE_SIZE, auditCsv, auditLogAvailable, csvCell, listAuditEvents } from "./auditLog";

describe("audit labels", () => {
  it("describes every recorded action, so a new action cannot reach the log unlabelled", () => {
    expect(Object.keys(AUDIT_ACTION_INFO).sort()).toEqual([...AUDIT_ACTIONS].sort());
    const categories = new Set(AUDIT_CATEGORIES.map((category) => category.id));
    for (const action of AUDIT_ACTIONS) {
      expect(AUDIT_ACTION_INFO[action].label.length, action).toBeGreaterThan(3);
      expect(categories.has(AUDIT_ACTION_INFO[action].category), action).toBe(true);
    }
  });
});

describe("csvCell", () => {
  it("quotes commas, quotes and newlines", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
  });

  it("defuses spreadsheet formulas", () => {
    for (const value of ["=SUM(A1)", "+1", "-2", "@cmd", "\tx"]) expect(csvCell(value).replace(/^"/, "")).toMatch(/^'/);
  });
});

describe("activity log", () => {
  const saved: Record<string, string | undefined> = {};
  let workspaceId: string;
  let otherWorkspaceId: string;
  let ownerId: string;
  let strangerId: string;

  const event = (action: string, extra: Record<string, unknown> = {}) =>
    prisma.auditEvent.create({ data: { workspaceId, actorUserId: ownerId, action, ...extra } });

  beforeEach(async () => {
    saved.MANAGED_HOSTING = process.env.MANAGED_HOSTING;
    workspaceId = randomUUID();
    otherWorkspaceId = randomUUID();
    ownerId = randomUUID();
    strangerId = randomUUID();
    await prisma.workspace.createMany({ data: [{ id: workspaceId, name: "Audit log workspace" }, { id: otherWorkspaceId, name: "Other audit workspace" }] });
    await prisma.user.createMany({ data: [
      { id: ownerId, email: `owner-${ownerId}@example.test`, passwordHash: "x", emailVerifiedAt: new Date() },
      { id: strangerId, email: `gone-${strangerId}@example.test`, passwordHash: "x", emailVerifiedAt: new Date() },
    ] });
    await prisma.workspaceMembership.create({ data: { userId: ownerId, workspaceId, role: "owner" } });
  });

  afterEach(async () => {
    await prisma.meeting.deleteMany({ where: { workspaceId } });
    await prisma.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, strangerId] } } });
    if (saved.MANAGED_HOSTING === undefined) delete process.env.MANAGED_HOSTING;
    else process.env.MANAGED_HOSTING = saved.MANAGED_HOSTING;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("lists newest first with readable actors, descriptions, details and note titles", async () => {
    const note = await prisma.meeting.create({ data: { userId: ownerId, workspaceId, title: "Pricing review", summary: "s", startedAt: new Date(), endedAt: new Date() } });
    await event("member.add", { createdAt: new Date("2026-09-30T10:00:00Z"), targetType: "user", targetId: strangerId });
    await event("meeting.trash", { createdAt: new Date("2026-09-30T11:00:00Z"), targetType: "meeting", targetId: note.id });
    await event("workspace.retention_update", { createdAt: new Date("2026-09-30T12:00:00Z"), actorUserId: null, metadata: { retentionDays: 90 } });
    await event("share.create", { createdAt: new Date("2026-09-30T13:00:00Z"), actorUserId: strangerId });

    const { rows } = await listAuditEvents(workspaceId);
    expect(rows.map((row) => row.action)).toEqual(["share.create", "workspace.retention_update", "meeting.trash", "member.add"]);
    expect(rows[0]).toMatchObject({ actor: "Former member", label: "Created a share link" });
    expect(rows[1]).toMatchObject({ actor: "System", details: "retentionDays: 90" });
    expect(rows[2]).toMatchObject({ actor: expect.stringContaining("owner-"), targetTitle: "Pricing review" });
    expect(JSON.stringify(rows)).not.toContain("gone-"); // a former member's address is never shown
  });

  it("drops the note title once the note is trashed or gone", async () => {
    const note = await prisma.meeting.create({ data: { userId: ownerId, workspaceId, title: "Secret title", summary: "s", startedAt: new Date(), endedAt: new Date(), deletedAt: new Date() } });
    await event("meeting.trash", { targetType: "meeting", targetId: note.id });
    expect((await listAuditEvents(workspaceId)).rows[0]!.targetTitle).toBeNull();
  });

  it("filters by category and by actor, and stays inside its workspace", async () => {
    await event("member.add");
    await event("folder.create");
    await event("integration.create", { actorUserId: null });
    await prisma.auditEvent.create({ data: { workspaceId: otherWorkspaceId, action: "member.add", actorUserId: ownerId } });
    expect((await listAuditEvents(workspaceId, { category: "members" })).rows.map((row) => row.action)).toEqual(["member.add"]);
    expect((await listAuditEvents(workspaceId, { category: "library" })).rows.map((row) => row.action)).toEqual(["folder.create"]);
    expect((await listAuditEvents(workspaceId, { actor: "system" })).rows.map((row) => row.action)).toEqual(["integration.create"]);
    expect((await listAuditEvents(workspaceId, { actor: ownerId })).rows).toHaveLength(2);
    expect((await listAuditEvents(workspaceId)).rows).toHaveLength(3);
  });

  it("pages without gaps or repeats, even when events share a timestamp", async () => {
    const same = new Date("2026-09-30T10:00:00Z");
    await prisma.auditEvent.createMany({ data: Array.from({ length: 120 }, (_, index) => ({ workspaceId, actorUserId: ownerId, action: "folder.create", createdAt: index < 60 ? same : new Date(same.getTime() + index * 1_000), targetId: String(index) })) });
    const seen: string[] = [];
    let cursor: string | null = null;
    const sizes: number[] = [];
    do {
      const page = await listAuditEvents(workspaceId, {}, cursor);
      sizes.push(page.rows.length);
      seen.push(...page.rows.map((row) => row.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(sizes).toEqual([AUDIT_PAGE_SIZE, AUDIT_PAGE_SIZE, 20]);
    expect(new Set(seen).size).toBe(120);
  });

  it("ignores a malformed cursor instead of failing", async () => {
    await event("member.add");
    expect((await listAuditEvents(workspaceId, {}, "garbage")).rows).toHaveLength(1);
  });

  it("exports CSV with a header, one line per event and formula-safe cells", async () => {
    await event("member.add", { metadata: { label: "=HYPERLINK(\"x\")" }, targetType: "user", targetId: "u1" });
    await event("folder.create");
    const csv = await auditCsv(workspaceId);
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("time_utc,actor,action,description,target_type,target_id,details");
    expect(lines).toHaveLength(3);
    // The details cell starts with "label:", so a spreadsheet will not run it; quotes inside are escaped.
    expect(csv).toContain('"label: =HYPERLINK(""x"")"');
    expect((await auditCsv(workspaceId, { category: "library" })).trim().split("\r\n")).toHaveLength(2);
  });

  it("is a Team feature on the hosted service and always on when self-hosted", async () => {
    delete process.env.MANAGED_HOSTING;
    expect(await auditLogAvailable(workspaceId)).toBe(true);
    process.env.MANAGED_HOSTING = "true";
    expect(await auditLogAvailable(workspaceId)).toBe(false);
    await prisma.workspaceSubscription.create({ data: { workspaceId, plan: "hosted_pro", status: "active" } });
    expect(await auditLogAvailable(workspaceId)).toBe(false);
    await prisma.workspaceSubscription.update({ where: { workspaceId }, data: { plan: "hosted_team" } });
    expect(await auditLogAvailable(workspaceId)).toBe(true);
    await prisma.workspaceSubscription.update({ where: { workspaceId }, data: { status: "canceled" } });
    expect(await auditLogAvailable(workspaceId)).toBe(false);
  });
});
