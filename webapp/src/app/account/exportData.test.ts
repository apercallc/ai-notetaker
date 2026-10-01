import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { upsertMeeting } from "@/lib/meetings";
import { streamWorkspaceMeetings } from "./exportData";

const WORKSPACE_ID = "77777777-0000-0000-0000-000000000007";
const LIVE_ID = "88888888-0000-0000-0000-000000000008";
const TRASHED_ID = "99999999-0000-0000-0000-000000000009";

const meeting = (id: string, title: string) => ({
  id,
  title,
  startedAt: "2026-09-24T10:00:00.000Z",
  endedAt: "2026-09-24T10:30:00.000Z",
  summary: "s",
  transcript: [],
  actionItems: [],
});

async function exportedIds() {
  const ids: string[] = [];
  for await (const batch of streamWorkspaceMeetings(WORKSPACE_ID)) ids.push(...batch.map((m) => m.id));
  return ids;
}

beforeEach(async () => {
  await prisma.meeting.deleteMany({ where: { id: { in: [LIVE_ID, TRASHED_ID] } } });
  await prisma.workspace.deleteMany({ where: { id: WORKSPACE_ID } });
  await prisma.workspace.create({ data: { id: WORKSPACE_ID, name: "Export workspace" } });
  await upsertMeeting(meeting(LIVE_ID, "Live note"), WORKSPACE_ID);
  await upsertMeeting(meeting(TRASHED_ID, "Trashed note"), WORKSPACE_ID);
});

afterAll(async () => {
  await prisma.meeting.deleteMany({ where: { id: { in: [LIVE_ID, TRASHED_ID] } } });
  await prisma.workspace.deleteMany({ where: { id: WORKSPACE_ID } });
});

describe("streamWorkspaceMeetings", () => {
  it("leaves notes in the Trash out of the export", async () => {
    await prisma.meeting.update({ where: { id: TRASHED_ID }, data: { deletedAt: new Date() } });
    expect(await exportedIds()).toEqual([LIVE_ID]);
  });
});
