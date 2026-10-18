import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "./db";
import { upsertMeeting } from "./meetings";
import { createMeetingShare, getSharedMeeting, listActiveShares, MAX_ACTIVE_SHARES_PER_MEETING, revokeMeetingShare, SharingValidationError } from "./sharing";

const WORKSPACE_ID = "44444444-0000-0000-0000-000000000004";
const OTHER_WORKSPACE_ID = "55555555-0000-0000-0000-000000000005";
const MEETING_ID = "66666666-0000-0000-0000-000000000006";

beforeEach(async () => {
  await prisma.meetingShareToken.deleteMany();
  await prisma.actionItem.deleteMany();
  await prisma.transcriptSegment.deleteMany();
  await prisma.meeting.deleteMany({ where: { id: MEETING_ID } });
  await prisma.workspace.deleteMany({ where: { id: { in: [WORKSPACE_ID, OTHER_WORKSPACE_ID] } } });
  await prisma.workspace.createMany({ data: [{ id: WORKSPACE_ID, name: "Share workspace" }, { id: OTHER_WORKSPACE_ID, name: "Other workspace" }] });
  await upsertMeeting({
    id: MEETING_ID,
    title: "Shared roadmap",
    startedAt: "2026-09-24T10:00:00.000Z",
    endedAt: "2026-09-24T10:30:00.000Z",
    summary: "A private summary",
    transcript: [{ speaker: "you", text: "hello", timestamp: "2026-09-24T10:00:00.000Z" }],
    actionItems: [],
  }, WORKSPACE_ID);
});

afterAll(async () => {
  await prisma.meetingShareToken.deleteMany();
  await prisma.meeting.deleteMany({ where: { id: MEETING_ID } });
  await prisma.workspace.deleteMany({ where: { id: { in: [WORKSPACE_ID, OTHER_WORKSPACE_ID] } } });
  await prisma.$disconnect();
});

describe("meeting shares", () => {
  it("returns a private meeting through an expiring bearer token", async () => {
    const share = await createMeetingShare(WORKSPACE_ID, MEETING_ID, 7);
    expect(share.token).not.toContain("44444444");
    expect(share.expiresAt!.getTime()).toBeGreaterThan(Date.now());

    const meeting = await getSharedMeeting(share.token);
    expect(meeting?.title).toBe("Shared roadmap");
    expect(meeting?.summary).toBe("A private summary");
    expect(await getSharedMeeting(`${share.token}tampered`)).toBeNull();
  });

  it("supports links that never expire, until revoked", async () => {
    const share = await createMeetingShare(WORKSPACE_ID, MEETING_ID, null);
    expect(share.expiresAt).toBeNull();
    expect((await getSharedMeeting(share.token))?.title).toBe("Shared roadmap");
    expect((await listActiveShares(WORKSPACE_ID, MEETING_ID)).map((link) => link.expiresAt)).toEqual([null]);
    expect(await revokeMeetingShare(WORKSPACE_ID, share.id)).toBe(true);
    expect(await getSharedMeeting(share.token)).toBeNull();
    expect(await listActiveShares(WORKSPACE_ID, MEETING_ID)).toEqual([]);
  });

  it("enforces workspace ownership and revocation", async () => {
    await expect(createMeetingShare(OTHER_WORKSPACE_ID, MEETING_ID)).rejects.toBeInstanceOf(SharingValidationError);
    const share = await createMeetingShare(WORKSPACE_ID, MEETING_ID);
    expect(await revokeMeetingShare(OTHER_WORKSPACE_ID, share.id)).toBe(false);
    expect(await getSharedMeeting(share.token)).not.toBeNull();
    expect(await revokeMeetingShare(WORKSPACE_ID, share.id)).toBe(true);
    expect(await getSharedMeeting(share.token)).toBeNull();
    expect(await revokeMeetingShare(WORKSPACE_ID, share.id)).toBe(false);
  });

  it("only revokes a link through the note it belongs to", async () => {
    const share = await createMeetingShare(WORKSPACE_ID, MEETING_ID);
    expect(await revokeMeetingShare(WORKSPACE_ID, share.id, "some-other-meeting")).toBe(false);
    expect(await getSharedMeeting(share.token)).not.toBeNull();
    expect(await revokeMeetingShare(WORKSPACE_ID, share.id, MEETING_ID)).toBe(true);
  });

  it("bounds finite share expiry to 1-365 days, allows 90, and rejects expired links", async () => {
    await expect(createMeetingShare(WORKSPACE_ID, MEETING_ID, 0)).rejects.toBeInstanceOf(SharingValidationError);
    expect((await createMeetingShare(WORKSPACE_ID, MEETING_ID, 90)).expiresAt).not.toBeNull();
    await expect(createMeetingShare(WORKSPACE_ID, MEETING_ID, 366)).rejects.toBeInstanceOf(SharingValidationError);
    const share = await createMeetingShare(WORKSPACE_ID, MEETING_ID, 1);
    await prisma.meetingShareToken.update({ where: { id: share.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    expect(await getSharedMeeting(share.token)).toBeNull();
  });

  it("caps active links per note so the list and public surface stay bounded", async () => {
    const now = Date.now();
    await prisma.meetingShareToken.createMany({
      data: Array.from({ length: MAX_ACTIVE_SHARES_PER_MEETING }, (_, index) => ({
        workspaceId: WORKSPACE_ID, meetingId: MEETING_ID, tokenHash: `cap-${index}`, expiresAt: new Date(now + 86_400_000), createdAt: new Date(now - index),
      })),
    });
    await expect(createMeetingShare(WORKSPACE_ID, MEETING_ID)).rejects.toThrow(`already has ${MAX_ACTIVE_SHARES_PER_MEETING} active links`);
    expect(await listActiveShares(WORKSPACE_ID, MEETING_ID)).toHaveLength(MAX_ACTIVE_SHARES_PER_MEETING);
    // Revoked and expired links don't count against the cap.
    const [first, second] = await prisma.meetingShareToken.findMany({ where: { meetingId: MEETING_ID }, take: 2, select: { id: true } });
    await revokeMeetingShare(WORKSPACE_ID, first!.id);
    await prisma.meetingShareToken.update({ where: { id: second!.id }, data: { expiresAt: new Date(now - 1_000) } });
    expect((await createMeetingShare(WORKSPACE_ID, MEETING_ID)).token).toBeTruthy();
    expect((await createMeetingShare(WORKSPACE_ID, MEETING_ID)).token).toBeTruthy();
    await expect(createMeetingShare(WORKSPACE_ID, MEETING_ID)).rejects.toBeInstanceOf(SharingValidationError);
  });
});
