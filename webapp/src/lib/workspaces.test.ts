import { describe, expect, it, beforeEach, afterAll } from "vitest";
import { prisma } from "./db";
import {
  getDefaultWorkspaceId,
  createWorkspaceWithOwner,
  addWorkspaceMember,
  getUserRole,
  getUserDefaultWorkspaceId,
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
