import { describe, expect, it, beforeEach, afterAll } from "vitest";
import { prisma } from "./db";
import {
  getDefaultWorkspaceId,
  createWorkspaceWithOwner,
  addWorkspaceMember,
  getUserRole,
  getUserDefaultWorkspaceId,
  createHostedWorkspaceWithOwner,
  resolveActiveWorkspace,
  listUserWorkspaces,
  updateWorkspaceRetentionDays,
  changeMemberRole,
  removeWorkspaceMember,
  getWorkspaceMembership,
  userBelongsOnlyTo,
  joinWorkspaceFromInvite,
  createUserFromInvite,
} from "./workspaces";

beforeEach(async () => {
  await prisma.session.deleteMany();
  await prisma.workspaceMembership.deleteMany();
  await prisma.user.deleteMany();
  await prisma.workspace.deleteMany();
});

afterAll(async () => {
  await prisma.session.deleteMany();
  await prisma.workspaceMembership.deleteMany();
  await prisma.user.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.$disconnect();
});

describe("getDefaultWorkspaceId", () => {
  it("returns the workspace flagged isDefault", async () => {
    const workspace = await prisma.workspace.create({ data: { name: "My Workspace", isDefault: true } });
    expect(await getDefaultWorkspaceId()).toBe(workspace.id);
  });
});

describe("createWorkspaceWithOwner", () => {
  it("creates an owner membership for a new user in the default workspace", async () => {
    await prisma.workspace.create({ data: { name: "My Workspace", isDefault: true } });
    const { userId, workspaceId } = await createWorkspaceWithOwner("owner@example.com", "hash");
    expect(await getUserRole(userId, workspaceId)).toBe("owner");
  });
});

describe("addWorkspaceMember", () => {
  it("adds a member to an existing workspace", async () => {
    await prisma.workspace.create({ data: { name: "My Workspace", isDefault: true } });
    const { workspaceId } = await createWorkspaceWithOwner("owner@example.com", "hash");
    const { userId: memberId } = await addWorkspaceMember(workspaceId, "member@example.com", "hash2");
    expect(await getUserRole(memberId, workspaceId)).toBe("member");
  });
});

describe("getUserRole", () => {
  it("returns null when the user has no membership in that workspace", async () => {
    await prisma.workspace.create({ data: { name: "My Workspace", isDefault: true } });
    const { workspaceId } = await createWorkspaceWithOwner("owner@example.com", "hash");
    expect(await getUserRole("00000000-0000-0000-0000-000000000000", workspaceId)).toBeNull();
  });
});

describe("getUserDefaultWorkspaceId", () => {
  it("returns the workspace id for a user's first (only) membership", async () => {
    await prisma.workspace.create({ data: { name: "My Workspace", isDefault: true } });
    const { userId, workspaceId } = await createWorkspaceWithOwner("owner@example.com", "hash");
    expect(await getUserDefaultWorkspaceId(userId)).toBe(workspaceId);
  });

  it("returns null for a user with no membership", async () => {
    expect(await getUserDefaultWorkspaceId("00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});

describe("managed workspace setup and selection", () => {
  it("creates isolated hosted workspaces and lists a user's memberships in stable form", async () => {
    const first = await createHostedWorkspaceWithOwner(" OWNER@Example.com ", "hash", "Hosted Team");
    const second = await createHostedWorkspaceWithOwner("other@example.com", "hash", "Other Team");
    const guest = await addWorkspaceMember(first.workspaceId, "guest@example.com", "hash");
    await prisma.workspaceMembership.update({
      where: { userId_workspaceId: { userId: guest.userId, workspaceId: first.workspaceId } },
      data: { createdAt: new Date("2026-01-01T00:00:00.000Z") },
    });
    await prisma.workspaceMembership.create({
      data: { userId: guest.userId, workspaceId: second.workspaceId, role: "member", createdAt: new Date("2026-01-02T00:00:00.000Z") },
    });

    expect(await listUserWorkspaces(guest.userId)).toEqual([
      { id: first.workspaceId, name: "Hosted Team", role: "member" },
      { id: second.workspaceId, name: "Other Team", role: "member" },
    ]);
    expect(await resolveActiveWorkspace(guest.userId, second.workspaceId)).toEqual({ workspaceId: second.workspaceId, role: "member" });
    expect(await resolveActiveWorkspace(guest.userId, "removed-workspace")).toEqual({ workspaceId: first.workspaceId, role: "member" });
    expect(await resolveActiveWorkspace("00000000-0000-0000-0000-000000000000")).toBeNull();
    expect(await userBelongsOnlyTo(guest.userId, first.workspaceId)).toBe(false);
    expect(await userBelongsOnlyTo(guest.userId, second.workspaceId)).toBe(false);
    expect(await userBelongsOnlyTo(guest.userId, "not-a-membership")).toBe(false);
  });

  it("validates retention bounds and allows retention to be disabled", async () => {
    const workspace = await prisma.workspace.create({ data: { name: "Retention workspace" } });
    await updateWorkspaceRetentionDays(workspace.id, 1);
    await updateWorkspaceRetentionDays(workspace.id, 3_650);
    await updateWorkspaceRetentionDays(workspace.id, null);
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })).retentionDays).toBeNull();
    for (const invalid of [0, -1, 3_651, 1.5, Number.NaN]) {
      await expect(updateWorkspaceRetentionDays(workspace.id, invalid)).rejects.toThrow("retention must be between 1 and 3650 days");
    }
  });
});

describe("workspace membership changes", () => {
  it("protects the last owner, supports role changes, and scopes lookup to the workspace", async () => {
    const workspace = await prisma.workspace.create({ data: { name: "Role workspace", isDefault: true } });
    const otherWorkspace = await prisma.workspace.create({ data: { name: "Different role workspace" } });
    const owner = await createWorkspaceWithOwner("role-owner@example.com", "hash");
    const membership = await prisma.workspaceMembership.findUniqueOrThrow({ where: { userId_workspaceId: { userId: owner.userId, workspaceId: owner.workspaceId } } });
    expect(await changeMemberRole(owner.workspaceId, membership.id, "member")).toEqual({ ok: false, reason: "last-owner" });
    expect(await changeMemberRole(owner.workspaceId, membership.id, "owner")).toEqual({ ok: true });
    expect(await changeMemberRole(otherWorkspace.id, membership.id, "member")).toEqual({ ok: false, reason: "not-found" });

    const otherOwner = await addWorkspaceMember(owner.workspaceId, "other-owner@example.com", "hash");
    const otherMembership = await prisma.workspaceMembership.findUniqueOrThrow({ where: { userId_workspaceId: { userId: otherOwner.userId, workspaceId: owner.workspaceId } } });
    expect(await changeMemberRole(owner.workspaceId, otherMembership.id, "owner")).toEqual({ ok: true });
    expect(await changeMemberRole(owner.workspaceId, membership.id, "member")).toEqual({ ok: true });
    expect(await getWorkspaceMembership(owner.workspaceId, otherMembership.id)).toMatchObject({ user: { id: otherOwner.userId, email: "other-owner@example.com" } });
    expect(await getWorkspaceMembership(otherWorkspace.id, otherMembership.id)).toBeNull();
  });

  it("clears removed members' active workspace and deletes orphaned accounts only", async () => {
    await prisma.workspace.create({ data: { name: "Member home", isDefault: true } });
    const second = await prisma.workspace.create({ data: { name: "Member second" } });
    const owner = await createWorkspaceWithOwner("remove-owner@example.com", "hash");
    const member = await addWorkspaceMember(owner.workspaceId, "remove-member@example.com", "hash");
    await prisma.workspaceMembership.create({ data: { userId: member.userId, workspaceId: second.id, role: "member" } });
    const session = await prisma.session.create({ data: { userId: member.userId, expiresAt: new Date(Date.now() + 60_000), activeWorkspaceId: owner.workspaceId } });
    const memberMembership = await prisma.workspaceMembership.findUniqueOrThrow({ where: { userId_workspaceId: { userId: member.userId, workspaceId: owner.workspaceId } } });

    expect(await removeWorkspaceMember(owner.workspaceId, "missing-membership")).toEqual({ ok: false, reason: "not-found" });
    const removed = await removeWorkspaceMember(owner.workspaceId, memberMembership.id);
    expect(removed).toEqual({ ok: true, removedUserId: member.userId, accountDeleted: false });
    expect((await prisma.session.findUniqueOrThrow({ where: { id: session.id } })).activeWorkspaceId).toBeNull();
    expect(await prisma.user.findUnique({ where: { id: member.userId } })).not.toBeNull();
    expect(await userBelongsOnlyTo(member.userId, second.id)).toBe(true);

    const finalMembership = await prisma.workspaceMembership.findUniqueOrThrow({ where: { userId_workspaceId: { userId: member.userId, workspaceId: second.id } } });
    expect(await removeWorkspaceMember(second.id, finalMembership.id)).toEqual({ ok: true, removedUserId: member.userId, accountDeleted: true });
    expect(await prisma.user.findUnique({ where: { id: member.userId } })).toBeNull();

    const onlyOwner = await prisma.workspaceMembership.findUniqueOrThrow({ where: { userId_workspaceId: { userId: owner.userId, workspaceId: owner.workspaceId } } });
    expect(await removeWorkspaceMember(owner.workspaceId, onlyOwner.id)).toEqual({ ok: false, reason: "last-owner" });
  });
});

describe("workspace invitations", () => {
  it("checks the invited identity, maps roles safely, and prevents duplicate membership", async () => {
    await prisma.workspace.create({ data: { name: "Invite default workspace", isDefault: true } });
    const workspace = await prisma.workspace.create({ data: { name: "Invite workspace" } });
    const user = await createWorkspaceWithOwner("invited@example.com", "hash");
    expect(await joinWorkspaceFromInvite(user.userId, "wrong@example.com", { email: "invited@example.com", workspaceId: workspace.id, role: "owner" }))
      .toEqual({ ok: false, reason: "email-mismatch" });
    expect(await joinWorkspaceFromInvite(user.userId, user.userId + "@example.com", { email: "other@example.com", workspaceId: workspace.id, role: null }))
      .toEqual({ ok: false, reason: "email-mismatch" });
    expect(await joinWorkspaceFromInvite(user.userId, "invited@example.com", { email: "invited@example.com", workspaceId: "missing", role: "owner" }))
      .toEqual({ ok: false, reason: "workspace-gone" });
    expect(await joinWorkspaceFromInvite(user.userId, "invited@example.com", { email: "invited@example.com", workspaceId: workspace.id, role: "owner" }))
      .toEqual({ ok: true, userId: user.userId, workspaceId: workspace.id });
    expect(await getUserRole(user.userId, workspace.id)).toBe("owner");
    expect(await joinWorkspaceFromInvite(user.userId, "invited@example.com", { email: "invited@example.com", workspaceId: workspace.id, role: "member" }))
      .toEqual({ ok: false, reason: "already-member" });
  });

  it("creates a verified account for the invited address and reports deleted workspaces", async () => {
    const workspace = await prisma.workspace.create({ data: { name: "New invite workspace" } });
    const terms = { termsAcceptedAt: new Date("2026-09-27T12:00:00Z"), termsVersion: "2026-09-24" };
    const created = await createUserFromInvite({ email: " New@Example.com ", workspaceId: workspace.id, role: "owner" }, "hash", terms);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: created.userId } });
    expect(created.workspaceId).toBe(workspace.id);
    expect(user.email).toBe("new@example.com");
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(user.termsVersion).toBe(terms.termsVersion);
    expect(await getUserRole(created.userId, workspace.id)).toBe("owner");
    await expect(createUserFromInvite({ email: "ghost@example.com", workspaceId: "missing", role: null }, "hash", terms))
      .rejects.toThrow("workspace no longer exists");
  });
});
