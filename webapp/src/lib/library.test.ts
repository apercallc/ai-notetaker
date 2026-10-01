import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "./db";
import { countTrashRoots, createFolder, deleteForever, emptyTrash, listFolders, listTrash, moveFolder, moveNotes, purgeExpiredTrash, renameFolder, restoreFromTrash, trashFolder, trashNote, TRASH_RETENTION_DAYS, type LibrarySession } from "./library";
import { MAX_FOLDER_DEPTH, flattenFolders, folderPath, folderPathLabel, subtreeHeight, subtreeIds, validateFolderName } from "./libraryTree";
import { getMeeting, listActionItems, listMeetings, previewText } from "./meetings";
import { retrieveNotes } from "./notesChat";
import { createMeetingShare } from "./sharing";
import { createNote, restorePreviousBody, titleFromFileName, updateNoteBody, validateNoteBody, MAX_NOTE_BODY } from "./noteEditing";

describe("folder tree helpers", () => {
  const tree = [
    { id: "a", parentId: null, name: "Clients" },
    { id: "b", parentId: "a", name: "Acme" },
    { id: "c", parentId: "b", name: "2026" },
    { id: "d", parentId: null, name: "archive" },
  ];

  it("builds paths, subtrees and heights", () => {
    expect(folderPath(tree, "c").map((folder) => folder.name)).toEqual(["Clients", "Acme", "2026"]);
    expect(folderPath(tree, null)).toEqual([]);
    expect(folderPathLabel(tree, "c")).toBe("Clients / Acme / 2026");
    expect(subtreeIds(tree, "a").sort()).toEqual(["a", "b", "c"]);
    expect(subtreeHeight(tree, "a")).toBe(3);
    expect(subtreeHeight(tree, "d")).toBe(1);
  });

  it("flattens alphabetically, depth first, ignoring case", () => {
    expect(flattenFolders(tree).map((folder) => `${"-".repeat(folder.depth)}${folder.name}`)).toEqual(["archive", "Clients", "-Acme", "--2026"]);
  });

  it("survives a corrupt cycle without looping", () => {
    const cyclic = [{ id: "x", parentId: "y", name: "x" }, { id: "y", parentId: "x", name: "y" }];
    expect(folderPath(cyclic, "x").length).toBeLessThanOrEqual(2);
    expect(subtreeIds(cyclic, "x").sort()).toEqual(["x", "y"]);
  });

  it("validates folder names", () => {
    expect(validateFolderName("  Q3   plans ")).toEqual({ name: "Q3 plans" });
    for (const bad of ["", "   ", "a/b", "a\\b", "..", ".", "x".repeat(81)]) expect(validateFolderName(bad)).toHaveProperty("error");
  });
});

describe("previewText", () => {
  it("drops Markdown markers and joins lines for card previews", () => {
    expect(previewText("# Launch checklist\n\n- Write docs\n- Ship it\n\n1. First\n> quoted\nPlain paragraph.")).toBe("Launch checklist Write docs Ship it First quoted Plain paragraph.");
    expect(previewText("## Key points\n- one")).toBe("Key points one");
  });

  it("cuts long text at 200 characters with an ellipsis and leaves short text alone", () => {
    expect(previewText("x".repeat(250))).toBe(`${"x".repeat(200)}…`);
    expect(previewText("Short note.")).toBe("Short note.");
    expect(previewText("")).toBe("");
  });
});

describe("note body validation", () => {
  it("normalises line endings and rejects binary or oversized text", () => {
    expect(validateNoteBody("a\r\nb\rc")).toEqual({ body: "a\nb\nc" });
    expect(validateNoteBody("bad\u0000data")).toHaveProperty("error");
    expect(validateNoteBody("x".repeat(MAX_NOTE_BODY + 1))).toHaveProperty("error");
    expect(titleFromFileName("C:\\docs\\Quarterly plan.MD")).toBe("Quarterly plan");
    expect(titleFromFileName(".md")).toBe("Untitled note");
  });
});

describe("library", () => {
  const saved = new Set<string>();
  const T0 = new Date("2026-09-24T15:00:00.000Z");
  let workspaceId: string;
  let otherWorkspaceId: string;
  let owner: LibrarySession;
  let member: LibrarySession;
  let otherOwner: LibrarySession;

  async function note(options: { title?: string; userId?: string; folderId?: string | null; summary?: string; ws?: string } = {}): Promise<string> {
    const id = randomUUID();
    await prisma.meeting.create({
      data: {
        id, userId: options.userId ?? owner.userId, workspaceId: options.ws ?? workspaceId, title: options.title ?? "A note",
        summary: options.summary ?? "Summary text", startedAt: T0, endedAt: T0, folderId: options.folderId ?? null,
      },
    });
    saved.add(id);
    return id;
  }

  async function folder(name: string, parentId: string | null = null, session: LibrarySession = owner): Promise<string> {
    const result = await createFolder(session, parentId, name);
    if (!result.ok) throw new Error(result.error);
    return result.id;
  }

  beforeEach(async () => {
    workspaceId = randomUUID();
    otherWorkspaceId = randomUUID();
    await prisma.workspace.createMany({ data: [{ id: workspaceId, name: "Library workspace" }, { id: otherWorkspaceId, name: "Other library workspace" }] });
    owner = { workspaceId, userId: "lib-owner", role: "owner" };
    member = { workspaceId, userId: "lib-member", role: "member" };
    otherOwner = { workspaceId: otherWorkspaceId, userId: "lib-other", role: "owner" };
  });

  afterEach(async () => {
    await prisma.meeting.deleteMany({ where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } } });
    await prisma.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe("folders", () => {
    it("creates nested folders and lists them", async () => {
      const clients = await folder("Clients");
      const acme = await folder("Acme", clients);
      expect((await listFolders(workspaceId)).map((entry) => [entry.name, entry.parentId])).toEqual(expect.arrayContaining([["Clients", null], ["Acme", clients]]));
      expect(acme).toBeTruthy();
    });

    it("refuses a duplicate name among siblings regardless of case, at the top level and nested, but allows it elsewhere", async () => {
      const a = await folder("Plans");
      expect(await createFolder(owner, null, "plans")).toEqual({ ok: false, error: "A folder with that name already exists here." });
      const b = await folder("Other");
      await folder("Plans", b); // same name under a different parent
      await folder("Sub", a);
      expect(await createFolder(owner, a, "SUB")).toMatchObject({ ok: false });
    });

    it("lets a name be reused once its folder is in the trash", async () => {
      const plans = await folder("Plans");
      await trashFolder(owner, plans);
      expect((await createFolder(owner, null, "Plans")).ok).toBe(true);
    });

    it("limits nesting depth", async () => {
      let parent: string | null = null;
      for (let level = 1; level <= MAX_FOLDER_DEPTH; level += 1) parent = await folder(`L${level}`, parent);
      expect(await createFolder(owner, parent, "too deep")).toMatchObject({ ok: false, error: expect.stringContaining(`${MAX_FOLDER_DEPTH} levels`) });
    });

    it("rejects bad names and unknown or foreign parents", async () => {
      expect(await createFolder(owner, null, "a/b")).toMatchObject({ ok: false });
      expect(await createFolder(owner, randomUUID(), "x")).toMatchObject({ ok: false, error: "That folder no longer exists." });
      const foreign = await folder("Theirs", null, otherOwner);
      expect(await createFolder(owner, foreign, "x")).toMatchObject({ ok: false, error: "That folder no longer exists." });
    });

    it("renames, reports conflicts, and stays inside the workspace", async () => {
      const a = await folder("A");
      await folder("B");
      expect(await renameFolder(owner, a, "B")).toMatchObject({ ok: false });
      expect(await renameFolder(owner, a, "Renamed")).toEqual({ ok: true, name: "Renamed" });
      expect(await renameFolder(otherOwner, a, "Hijack")).toMatchObject({ ok: false });
    });

    it("moves folders, refusing cycles, depth overflow and name clashes", async () => {
      const a = await folder("A");
      const b = await folder("B", a);
      const c = await folder("C", b);
      expect(await moveFolder(owner, a, c)).toMatchObject({ ok: false, error: expect.stringContaining("into itself") });
      expect(await moveFolder(owner, a, a)).toMatchObject({ ok: false });
      expect(await moveFolder(owner, c, null)).toEqual({ ok: true });
      expect((await listFolders(workspaceId)).find((entry) => entry.id === c)?.parentId).toBeNull();
      await folder("C", a); // now a clash target for moving the top-level C under A
      expect(await moveFolder(owner, c, a)).toMatchObject({ ok: false, error: expect.stringContaining("already has a folder") });

      // A tall subtree cannot be dropped somewhere that pushes it past the depth cap.
      let deep: string | null = null;
      for (let level = 1; level <= MAX_FOLDER_DEPTH - 1; level += 1) deep = await folder(`D${level}`, deep);
      const tall = await folder("Tall");
      await folder("TallChild", tall);
      expect(await moveFolder(owner, tall, deep)).toMatchObject({ ok: false, error: expect.stringContaining("levels deep") });
    });
  });

  describe("moving notes and scoped listing", () => {
    it("places notes in folders and lists by exact folder, subtree or everywhere", async () => {
      const clients = await folder("Clients");
      const acme = await folder("Acme", clients);
      const inClients = await note({ title: "Clients note" });
      const inAcme = await note({ title: "Acme note" });
      const loose = await note({ title: "Loose note" });
      expect(await moveNotes(owner, [inClients], clients)).toEqual({ ok: true, moved: 1 });
      expect(await moveNotes(owner, [inAcme], acme)).toEqual({ ok: true, moved: 1 });

      const titles = async (options: Parameters<typeof listMeetings>[1]) => (await listMeetings(workspaceId, options)).meetings.map((meeting) => meeting.title).sort();
      expect(await titles({})).toEqual(["Acme note", "Clients note", "Loose note"]);
      expect(await titles({ folderId: null })).toEqual(["Loose note"]);
      expect(await titles({ folderId: clients })).toEqual(["Clients note"]);
      expect(await titles({ folderIds: [clients, acme] })).toEqual(["Acme note", "Clients note"]);
      expect(await titles({ folderIds: [clients, acme], query: "acme" })).toEqual(["Acme note"]);
      expect((await getMeeting(workspaceId, inAcme))?.folderId).toBe(acme);
      expect(loose).toBeTruthy();
      expect(await moveNotes(owner, [inAcme], null)).toEqual({ ok: true, moved: 1 });
    });

    it("refuses bad destinations and never moves another workspace's notes", async () => {
      const theirs = await note({ ws: otherWorkspaceId });
      const mine = await folder("Mine");
      expect(await moveNotes(owner, [theirs], mine)).toEqual({ ok: true, moved: 0 });
      expect((await prisma.meeting.findUniqueOrThrow({ where: { id: theirs } })).folderId).toBeNull();
      expect(await moveNotes(owner, [theirs], randomUUID())).toMatchObject({ ok: false });
      expect(await moveNotes(owner, [], mine)).toMatchObject({ ok: false });
      expect(await moveNotes(owner, Array.from({ length: 201 }, () => randomUUID()), mine)).toMatchObject({ ok: false });
    });
  });

  describe("trash", () => {
    it("counts every trashed root, which listTrash caps", async () => {
      const first = await note({ title: "One" });
      const second = await note({ title: "Two" });
      expect(await countTrashRoots(workspaceId)).toBe(0);
      await trashNote(owner, first);
      await trashNote(owner, second);
      expect(await countTrashRoots(workspaceId)).toBe(2);
      expect(await countTrashRoots("00000000-0000-0000-0000-00000000dead")).toBe(0);
    });

    it("hides a trashed note from lists, detail, actions, Ask and sharing, and restores it", async () => {
      const id = await note({ title: "Pricing review", summary: "We discussed zebra pricing." });
      await prisma.actionItem.create({ data: { meetingId: id, userId: owner.userId, text: "Send zebra quote" } });
      expect((await listMeetings(workspaceId, {})).total).toBe(1);

      expect(await trashNote(owner, id)).toEqual({ ok: true });

      expect((await listMeetings(workspaceId, {})).total).toBe(0);
      expect((await listMeetings(workspaceId, { query: "zebra" })).total).toBe(0);
      expect(await getMeeting(workspaceId, id)).toBeNull();
      expect((await listActionItems(workspaceId)).total).toBe(0);
      expect(await retrieveNotes(workspaceId, "zebra pricing")).toEqual([]);
      await expect(createMeetingShare(workspaceId, id)).rejects.toThrow();
      expect((await listTrash(workspaceId)).map((item) => [item.kind, item.id])).toEqual([["note", id]]);

      expect(await restoreFromTrash(owner, "note", id)).toEqual({ ok: true });
      expect((await getMeeting(workspaceId, id))?.title).toBe("Pricing review");
      expect((await listActionItems(workspaceId)).total).toBe(1);
      expect(await listTrash(workspaceId)).toEqual([]);
    });

    it("lets a member trash only their own notes; an owner can trash any", async () => {
      const theirs = await note({ userId: owner.userId });
      const mine = await note({ userId: member.userId });
      expect(await trashNote(member, theirs)).toMatchObject({ ok: false, error: expect.stringContaining("owner") });
      expect(await trashNote(member, mine)).toEqual({ ok: true });
      expect(await trashNote(owner, theirs)).toEqual({ ok: true });
      expect(await trashNote(otherOwner, randomUUID())).toMatchObject({ ok: false });
    });

    it("trashes a folder with everything inside and restores exactly that batch", async () => {
      const clients = await folder("Clients");
      const acme = await folder("Acme", clients);
      const keep = await folder("Keep");
      const a = await note({ folderId: clients, title: "In clients" });
      const b = await note({ folderId: acme, title: "In acme" });
      const earlier = await note({ folderId: acme, title: "Trashed earlier" });
      const safe = await note({ folderId: keep, title: "Safe" });
      await trashNote(owner, earlier);

      expect(await trashFolder(owner, clients)).toEqual({ ok: true, folders: 2, notes: 2 });

      expect((await listMeetings(workspaceId, {})).meetings.map((meeting) => meeting.title)).toEqual(["Safe"]);
      expect((await listFolders(workspaceId)).map((entry) => entry.name)).toEqual(["Keep"]);
      const trash = await listTrash(workspaceId);
      expect(trash.map((item) => [item.kind, item.name])).toEqual(expect.arrayContaining([["folder", "Clients"], ["note", "Trashed earlier"]]));
      expect(trash).toHaveLength(2); // contents of the folder are not separate roots
      expect(trash.find((item) => item.kind === "folder")).toMatchObject({ noteCount: 2, folderCount: 2, daysLeft: TRASH_RETENTION_DAYS });

      expect(await restoreFromTrash(owner, "folder", clients)).toEqual({ ok: true });

      expect((await listMeetings(workspaceId, {})).meetings.map((meeting) => meeting.title).sort()).toEqual(["In acme", "In clients", "Safe"]);
      expect((await listFolders(workspaceId)).map((entry) => entry.name).sort()).toEqual(["Acme", "Clients", "Keep"]);
      expect((await getMeeting(workspaceId, b))?.folderId).toBe(acme);
      expect(await getMeeting(workspaceId, earlier)).toBeNull(); // still in the trash on its own
      expect([a, safe]).toBeTruthy();
    });

    it("restores a note whose folder is gone to the top level, and a folder with a taken name under a new name", async () => {
      const plans = await folder("Plans");
      const inside = await note({ folderId: plans });
      await trashNote(owner, inside);
      await trashFolder(owner, plans);
      expect(await restoreFromTrash(owner, "note", inside)).toEqual({ ok: true });
      expect((await getMeeting(workspaceId, inside))?.folderId).toBeNull();

      await folder("Plans"); // the name is free again, now taken
      expect(await restoreFromTrash(owner, "folder", plans)).toEqual({ ok: true });
      expect((await listFolders(workspaceId)).map((entry) => entry.name).sort()).toEqual(["Plans", "Plans (restored)"]);
    });

    it("restores a subfolder trashed under a trashed parent to the top level when the parent is gone", async () => {
      const parent = await folder("Parent");
      const child = await folder("Child", parent);
      await trashFolder(owner, child);
      await trashFolder(owner, parent);
      expect(await restoreFromTrash(owner, "folder", child)).toEqual({ ok: true });
      expect((await listFolders(workspaceId)).find((entry) => entry.id === child)?.parentId).toBeNull();
    });

    it("lets a member trash a folder only when everything in it is theirs", async () => {
      const mine = await folder("Mine", null, member);
      await note({ folderId: mine, userId: member.userId });
      expect((await trashFolder(member, mine)).ok).toBe(true);

      const shared = await folder("Shared", null, member);
      await note({ folderId: shared, userId: owner.userId });
      expect(await trashFolder(member, shared)).toMatchObject({ ok: false, error: expect.stringContaining("other people") });
      const ownerFolder = await folder("Owner folder");
      expect(await trashFolder(member, ownerFolder)).toMatchObject({ ok: false });
      expect((await trashFolder(owner, shared)).ok).toBe(true);
    });

    it("deletes forever: a folder removes its notes for good, and members are held to the same rule", async () => {
      const f = await folder("Doomed");
      const inside = await note({ folderId: f, userId: owner.userId });
      await trashFolder(owner, f);
      expect(await deleteForever(member, "folder", f)).toMatchObject({ ok: false, error: expect.stringContaining("other people") });
      expect(await deleteForever(owner, "folder", f)).toEqual({ ok: true });
      expect(await prisma.meeting.count({ where: { id: inside } })).toBe(0);
      expect(await prisma.folder.count({ where: { id: f } })).toBe(0);
      expect(await deleteForever(owner, "folder", f)).toMatchObject({ ok: false });
    });

    it("only deletes items that are actually in the trash", async () => {
      const live = await note();
      expect(await deleteForever(owner, "note", live)).toMatchObject({ ok: false });
      expect(await restoreFromTrash(owner, "note", live)).toMatchObject({ ok: false });
      expect(await prisma.meeting.count({ where: { id: live } })).toBe(1);
    });

    it("empties the trash for owners only", async () => {
      const a = await note();
      const f = await folder("F");
      await note({ folderId: f });
      await trashNote(owner, a);
      await trashFolder(owner, f);
      expect(await emptyTrash(member)).toMatchObject({ ok: false });
      expect(await emptyTrash(owner)).toEqual({ ok: true, removed: 2 });
      expect(await prisma.meeting.count({ where: { workspaceId } })).toBe(0);
      expect(await listTrash(workspaceId)).toEqual([]);
    });

    it("purges items past the retention window and records it", async () => {
      const old = await note({ title: "Old" });
      const fresh = await note({ title: "Fresh" });
      const f = await folder("Old folder");
      const inFolder = await note({ folderId: f });
      await trashNote(owner, old);
      await trashNote(owner, fresh);
      await trashFolder(owner, f);
      const past = new Date(Date.now() - (TRASH_RETENTION_DAYS + 1) * 24 * 3_600_000);
      await prisma.meeting.updateMany({ where: { id: { in: [old, inFolder] } }, data: { deletedAt: past } });
      await prisma.folder.updateMany({ where: { id: f }, data: { deletedAt: past } });

      expect(await purgeExpiredTrash(new Date(), true)).toBe(2);

      expect(await prisma.meeting.count({ where: { id: { in: [old, inFolder] } } })).toBe(0);
      expect(await prisma.folder.count({ where: { id: f } })).toBe(0);
      expect(await prisma.meeting.count({ where: { id: fresh } })).toBe(1);
      expect(await prisma.auditEvent.findFirstOrThrow({ where: { workspaceId, action: "trash.purge" } })).toMatchObject({ metadata: { items: 2 } });
      expect(await purgeExpiredTrash(new Date())).toBe(0); // throttled
    });

    it("writes audit events for folder and note changes without names or content", async () => {
      const f = await folder("Secret project name");
      const n = await note({ summary: "confidential body" });
      await moveNotes(owner, [n], f);
      await trashNote(owner, n);
      const events = await prisma.auditEvent.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" } });
      expect(events.map((event) => event.action)).toEqual(["folder.create", "meeting.move", "meeting.trash"]);
      expect(JSON.stringify(events)).not.toContain("Secret project name");
      expect(JSON.stringify(events)).not.toContain("confidential body");
    });
  });

  describe("note editing", () => {
    it("creates a blank note and an uploaded text note in a folder, without transcript or provider state", async () => {
      const f = await folder("Docs");
      const blank = await createNote(owner, { source: "manual" });
      const uploaded = await createNote(member, { title: titleFromFileName("Plan.md"), body: "# Plan\n- item\r\n", folderId: f, source: "upload" });
      if (!blank.ok || !uploaded.ok) throw new Error("expected success");
      expect(await prisma.meeting.findUniqueOrThrow({ where: { id: blank.id } })).toMatchObject({ title: "Untitled note", summary: "", captureSource: "manual", processingMode: "local_byok", folderId: null });
      expect(await prisma.meeting.findUniqueOrThrow({ where: { id: uploaded.id } })).toMatchObject({ title: "Plan", summary: "# Plan\n- item\n", folderId: f, userId: member.userId });
      expect((await getMeeting(workspaceId, uploaded.id))?.isManual).toBe(true);
      expect(await createNote(owner, { source: "manual", folderId: randomUUID() })).toMatchObject({ ok: false });
      expect(await createNote(owner, { source: "upload", body: "bad\u0000" })).toMatchObject({ ok: false });
    });

    it("saves an edit, keeps the previous text once and undoes it (and redoes)", async () => {
      const id = await note({ summary: "Original" });
      const version = (await getMeeting(workspaceId, id))!.version;
      const saved = await updateNoteBody(owner, id, "Edited by hand", version);
      if (!saved.ok) throw new Error("expected success");
      const row = await prisma.meeting.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ summary: "Edited by hand", previousSummary: "Original" });
      expect(row.summaryEditedAt).not.toBeNull();
      expect(saved.version).toBe(row.updatedAt.toISOString());

      expect(await restorePreviousBody(owner, id)).toMatchObject({ ok: true });
      expect(await prisma.meeting.findUniqueOrThrow({ where: { id } })).toMatchObject({ summary: "Original", previousSummary: "Edited by hand" });
      expect(await restorePreviousBody(owner, id)).toMatchObject({ ok: true });
      expect((await prisma.meeting.findUniqueOrThrow({ where: { id } })).summary).toBe("Edited by hand");
      expect(await prisma.auditEvent.count({ where: { workspaceId, action: "meeting.edit" } })).toBe(3);
    });

    it("refuses to overwrite a note that changed since the editor loaded it", async () => {
      const id = await note({ summary: "Original" });
      const stale = (await getMeeting(workspaceId, id))!.version;
      await prisma.meeting.update({ where: { id }, data: { title: "Renamed meanwhile" } });
      const result = await updateNoteBody(owner, id, "My edit", stale);
      expect(result).toMatchObject({ ok: false, conflict: true });
      expect((await prisma.meeting.findUniqueOrThrow({ where: { id } })).summary).toBe("Original");
    });

    it("treats an unchanged save as a no-op and refuses trashed, foreign and oversized notes", async () => {
      const id = await note({ summary: "Same" });
      const version = (await getMeeting(workspaceId, id))!.version;
      expect(await updateNoteBody(owner, id, "Same", version)).toEqual({ ok: true, version });
      expect(await prisma.auditEvent.count({ where: { workspaceId, action: "meeting.edit" } })).toBe(0);
      expect(await updateNoteBody(owner, id, "x".repeat(MAX_NOTE_BODY + 1), version)).toMatchObject({ ok: false });
      expect(await updateNoteBody(otherOwner, id, "hijack", version)).toMatchObject({ ok: false, error: "This note no longer exists." });
      await trashNote(owner, id);
      expect(await updateNoteBody(owner, id, "late edit", version)).toMatchObject({ ok: false });
      expect(await restorePreviousBody(owner, id)).toMatchObject({ ok: false });
    });

    it("has nothing to restore before any edit", async () => {
      const id = await note();
      expect(await restorePreviousBody(owner, id)).toEqual({ ok: false, error: "There's no earlier version to restore." });
    });
  });
});
