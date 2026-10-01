import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { addWorkspaceMember, createWorkspaceWithOwner } from "@/lib/workspaces";
import { getMeeting } from "@/lib/meetings";
import { retrieveNotes } from "@/lib/notesChat";

const cookieStore = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => cookieStore) }));
vi.mock("next/navigation", () => ({ redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const library = await import("./libraryActions");
const trash = await import("../trash/actions");
const note = await import("./[id]/actions");

function form(fields: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) for (const item of Array.isArray(value) ? value : [value]) data.append(key, item);
  return data;
}

async function signIn(userId: string): Promise<void> {
  const session = await prisma.session.create({ data: { userId, expiresAt: new Date(Date.now() + 100_000) } });
  cookieStore.get.mockReturnValue({ value: session.id });
}

async function reset() {
  await prisma.meeting.deleteMany();
  await prisma.auditEvent.deleteMany();
  await prisma.session.deleteMany();
  await prisma.workspaceMembership.deleteMany();
  await prisma.user.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.workspace.create({ data: { name: "My Workspace", isDefault: true } });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await reset();
});

afterAll(async () => {
  await reset();
  await prisma.$disconnect();
});

async function redirectOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const match = /^REDIRECT:(.*)$/.exec((error as Error).message);
    if (match) return match[1]!;
    throw error;
  }
  throw new Error("expected a redirect");
}

describe("library actions", () => {
  it("creates folders (reporting conflicts as values), moves notes and trashes a folder with a count", async () => {
    const { userId, workspaceId } = await createWorkspaceWithOwner("owner@example.com", "hash");
    await signIn(userId);

    expect(await library.createFolderAction(form({ name: "Clients", parentId: "" }))).toEqual({ ok: true });
    expect(await library.createFolderAction(form({ name: "clients", parentId: "" }))).toEqual({ ok: false, error: "A folder with that name already exists here." });
    const folder = await prisma.folder.findFirstOrThrow({ where: { workspaceId, name: "Clients" } });

    const created = await redirectOf(library.createNoteAction(form({ folderId: folder.id })));
    const noteId = /^\/meetings\/([^?]+)\?edit=1$/.exec(created)![1]!;
    expect((await getMeeting(workspaceId, noteId))?.folderId).toBe(folder.id);

    expect(await library.moveNotesAction(form({ id: [noteId], folderId: "" }))).toEqual({ ok: true, message: "Moved." });
    expect((await getMeeting(workspaceId, noteId))?.folderId).toBeNull();
    await library.moveNotesAction(form({ id: [noteId], folderId: folder.id }));
    expect(await library.trashFolderAction(form({ id: folder.id }))).toEqual({ ok: true, message: "Folder moved to Trash with 1 note." });
    expect(await getMeeting(workspaceId, noteId)).toBeNull();

    expect(await trash.restoreAction(form({ kind: "folder", id: folder.id }))).toEqual({ ok: true, message: "Restored." });
    expect((await getMeeting(workspaceId, noteId))?.folderId).toBe(folder.id);
  });

  it("uploads a text file as a note and refuses other types, oversize text and binary", async () => {
    const { userId, workspaceId } = await createWorkspaceWithOwner("owner@example.com", "hash");
    await signIn(userId);

    const ok = await library.uploadNoteAction(form({ fileName: "Weekly plan.md", body: "# Plan\n- ship", folderId: "" }));
    expect(ok).toMatchObject({ ok: true });
    const meeting = await getMeeting(workspaceId, (ok as { id: string }).id);
    expect(meeting).toMatchObject({ title: "Weekly plan", summary: "# Plan\n- ship", isManual: true });

    expect(await library.uploadNoteAction(form({ fileName: "photo.png", body: "x" }))).toMatchObject({ ok: false });
    expect(await library.uploadNoteAction(form({ fileName: "big.txt", body: "x".repeat(600 * 1024) }))).toMatchObject({ ok: false, error: expect.stringContaining("too large") });
    expect(await library.uploadNoteAction(form({ fileName: "bin.txt", body: "a\u0000b" }))).toMatchObject({ ok: false });
  });

  it("moves a deleted note to the trash and lets only its author or an owner do it", async () => {
    const { userId: ownerId, workspaceId } = await createWorkspaceWithOwner("owner@example.com", "hash");
    const { userId: memberId } = await addWorkspaceMember(workspaceId, "member@example.com", "hash2");
    await signIn(ownerId);
    const ownersNote = await prisma.meeting.create({ data: { userId: ownerId, workspaceId, title: "Owner's note", summary: "s", startedAt: new Date(), endedAt: new Date() } });

    await signIn(memberId);
    const denied = await redirectOf(note.deleteMeetingAction(form({ id: ownersNote.id })));
    expect(denied).toContain(`/meetings/${ownersNote.id}?error=`);
    expect((await prisma.meeting.findUniqueOrThrow({ where: { id: ownersNote.id } })).deletedAt).toBeNull();

    await signIn(ownerId);
    expect(await redirectOf(note.deleteMeetingAction(form({ id: ownersNote.id })))).toBe("/meetings?notice=trashed");
    expect((await prisma.meeting.findUniqueOrThrow({ where: { id: ownersNote.id } })).deletedAt).not.toBeNull();

    // The member cannot empty the trash; the owner can, and the note is really gone afterwards.
    await signIn(memberId);
    expect(await trash.emptyTrashAction()).toMatchObject({ ok: false });
    await signIn(ownerId);
    expect(await trash.emptyTrashAction()).toEqual({ ok: true, message: "Trash emptied." });
    expect(await prisma.meeting.count({ where: { id: ownersNote.id } })).toBe(0);
  });

  it("saves note text and reports a stale version as a conflict, then restores the earlier text", async () => {
    const { userId, workspaceId } = await createWorkspaceWithOwner("owner@example.com", "hash");
    await signIn(userId);
    const created = await library.uploadNoteAction(form({ fileName: "Draft.md", body: "first", folderId: "" }));
    const id = (created as { id: string }).id;
    const loaded = (await getMeeting(workspaceId, id))!.version;

    const saved = await note.saveNoteBodyAction(form({ meetingId: id, body: "second", version: loaded }));
    expect(saved).toMatchObject({ status: "saved" });
    const stale = await note.saveNoteBodyAction(form({ meetingId: id, body: "third", version: loaded }));
    expect(stale).toMatchObject({ status: "conflict" });
    expect((await getMeeting(workspaceId, id))?.summary).toBe("second");

    expect(await note.restorePreviousBodyAction(form({ meetingId: id }))).toMatchObject({ status: "saved" });
    expect((await getMeeting(workspaceId, id))?.summary).toBe("first");
  });
});

describe("Ask scope", () => {
  it("retrieves only from the chosen folders", async () => {
    const { userId, workspaceId } = await createWorkspaceWithOwner("owner@example.com", "hash");
    const inside = await prisma.folder.create({ data: { workspaceId, name: "Inside" } });
    const mk = (title: string, folderId: string | null) => prisma.meeting.create({ data: { userId, workspaceId, title, summary: "We discussed quasar pricing.", startedAt: new Date(), endedAt: new Date(), folderId } });
    const a = await mk("In folder", inside.id);
    const b = await mk("Elsewhere", null);

    expect((await retrieveNotes(workspaceId, "quasar pricing")).map((source) => source.id).sort()).toEqual([a.id, b.id].sort());
    expect((await retrieveNotes(workspaceId, "quasar pricing", [inside.id])).map((source) => source.id)).toEqual([a.id]);
    expect(await retrieveNotes(workspaceId, "quasar pricing", [])).toEqual([]);
  });
});
