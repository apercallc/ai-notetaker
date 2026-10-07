import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { createWorkspaceWithOwner } from "@/lib/workspaces";
import { getMeeting } from "@/lib/meetings";
import { expireManagedMeetings } from "@/lib/managedJobs";
import { LAPSED_READ_ONLY_MESSAGE } from "@/lib/workspaceAccess";

const cookieStore = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => cookieStore) }));
vi.mock("next/navigation", () => ({ redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const library = await import("./libraryActions");
const note = await import("./[id]/actions");

function form(fields: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) for (const item of Array.isArray(value) ? value : [value]) data.append(key, item);
  return data;
}

async function reset() {
  await prisma.meeting.deleteMany();
  await prisma.auditEvent.deleteMany();
  await prisma.session.deleteMany();
  await prisma.maintenanceCursor.deleteMany();
  await prisma.workspaceSubscription.deleteMany();
  await prisma.workspaceMembership.deleteMany();
  await prisma.user.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.workspace.create({ data: { name: "My Workspace", isDefault: true } });
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv("MANAGED_HOSTING", "true");
  await reset();
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await reset();
  await prisma.$disconnect();
});

async function setup(status: string) {
  const { userId, workspaceId } = await createWorkspaceWithOwner("owner@example.com", "hash");
  const session = await prisma.session.create({ data: { userId, expiresAt: new Date(Date.now() + 100_000) } });
  cookieStore.get.mockReturnValue({ value: session.id });
  await prisma.workspaceSubscription.upsert({
    where: { workspaceId },
    create: { workspaceId, plan: "hosted_pro", status, stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1" },
    update: { plan: "hosted_pro", status, stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1" },
  });
  return { userId, workspaceId };
}

describe("a workspace whose plan ended is read-only, never locked out", () => {
  it("keeps every note readable, deletable and restorable, and refuses new content", async () => {
    const { workspaceId } = await setup("active");
    const first = (await library.uploadNoteAction(form({ fileName: "Plan.md", body: "# Plan", folderId: "" }))) as { ok: true; id: string };
    expect(first.ok).toBe(true);

    await prisma.workspaceSubscription.update({ where: { workspaceId }, data: { status: "canceled" } });

    // Reading is untouched.
    expect((await getMeeting(workspaceId, first.id))?.title).toBe("Plan");

    // Anything that adds or changes content says why, as a value the page can show.
    expect(await library.createFolderAction(form({ name: "New", parentId: "" }))).toEqual({ ok: false, error: LAPSED_READ_ONLY_MESSAGE });
    expect(await library.uploadNoteAction(form({ fileName: "Two.md", body: "2", folderId: "" }))).toEqual({ ok: false, error: LAPSED_READ_ONLY_MESSAGE });
    expect(await library.moveItemsAction(form({ noteId: [first.id], destination: "" }))).toEqual({ ok: false, error: LAPSED_READ_ONLY_MESSAGE });
    await expect(library.createNoteAction(form({ folderId: "" }))).rejects.toThrow(/REDIRECT:\/meetings\?error=note-create-failed/);
    expect(await note.renameMeetingAction(form({ meetingId: first.id, title: "Renamed" }))).toEqual({ status: "error", message: LAPSED_READ_ONLY_MESSAGE });
    expect((await getMeeting(workspaceId, first.id))?.title).toBe("Plan");

    // Deleting and undoing a delete are the user's own data: always allowed.
    expect(await library.trashItemsAction(form({ noteId: [first.id] }))).toMatchObject({ ok: true, done: 1 });
    expect(await getMeeting(workspaceId, first.id)).toBeNull();
    expect(await library.restoreItemsAction(form({ item: [`note:${first.id}`] }))).toMatchObject({ ok: true });
    expect((await getMeeting(workspaceId, first.id))?.title).toBe("Plan");
  });

  it("writes again the moment a plan is back", async () => {
    const { workspaceId } = await setup("canceled");
    expect(await library.createFolderAction(form({ name: "Blocked", parentId: "" }))).toMatchObject({ ok: false });
    await prisma.workspaceSubscription.update({ where: { workspaceId }, data: { status: "active" } });
    expect(await library.createFolderAction(form({ name: "Back", parentId: "" }))).toMatchObject({ ok: true, name: "Back" });
  });

  it("does not run an owner's deletion policy unless the Team plan is active", async () => {
    const { workspaceId } = await setup("active");
    await prisma.workspaceSubscription.update({ where: { workspaceId }, data: { plan: "hosted_team" } });
    const uploaded = (await library.uploadNoteAction(form({ fileName: "Old.md", body: "old", folderId: "" }))) as { id: string };
    const longAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1_000);
    await prisma.meeting.update({ where: { id: uploaded.id }, data: { startedAt: longAgo, endedAt: longAgo } });
    await prisma.workspace.update({ where: { id: workspaceId }, data: { retentionDays: 30 } });

    await prisma.workspaceSubscription.update({ where: { workspaceId }, data: { status: "canceled" } });
    await expireManagedMeetings();
    expect(await prisma.meeting.count({ where: { id: uploaded.id } })).toBe(1);

    // Downgrading to Pro keeps sync but ends the Team-only policy, so the notes are still kept.
    await prisma.workspaceSubscription.update({ where: { workspaceId }, data: { plan: "hosted_pro", status: "active" } });
    await prisma.maintenanceCursor.deleteMany();
    await expireManagedMeetings();
    expect(await prisma.meeting.count({ where: { id: uploaded.id } })).toBe(1);
    await prisma.workspaceSubscription.update({ where: { workspaceId }, data: { plan: "hosted_team" } });

    await prisma.workspaceSubscription.update({ where: { workspaceId }, data: { status: "active" } });
    await prisma.maintenanceCursor.deleteMany();
    await expireManagedMeetings();
    expect(await prisma.meeting.count({ where: { id: uploaded.id } })).toBe(0);
  });
});
