import { createHash, randomBytes } from "node:crypto";
import { prisma } from "./db";
import { getMeeting } from "./meetings";
import type { MeetingDetailResponse } from "./types";

export const DEFAULT_SHARE_EXPIRY_DAYS = 7;
export const MAX_SHARE_EXPIRY_DAYS = 30;

export class SharingValidationError extends Error {}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function expiryDate(days: number): Date {
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_SHARE_EXPIRY_DAYS) {
    throw new SharingValidationError(`share expiry must be between 1 and ${MAX_SHARE_EXPIRY_DAYS} days`);
  }
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

export async function createMeetingShare(
  workspaceId: string,
  meetingId: string,
  expiresInDays = DEFAULT_SHARE_EXPIRY_DAYS,
): Promise<{ id: string; token: string; expiresAt: Date }> {
  const meeting = await prisma.meeting.findFirst({ where: { id: meetingId, workspaceId }, select: { id: true } });
  if (!meeting) throw new SharingValidationError("meeting not found");

  const token = randomBytes(32).toString("base64url");
  const expiresAt = expiryDate(expiresInDays);
  const share = await prisma.meetingShareToken.create({
    data: { workspaceId, meetingId, tokenHash: hashToken(token), expiresAt },
    select: { id: true, expiresAt: true },
  });
  return { ...share, token };
}

export async function revokeMeetingShare(workspaceId: string, shareId: string): Promise<boolean> {
  if (!shareId || shareId.length > 128) throw new SharingValidationError("share id is invalid");
  const result = await prisma.meetingShareToken.updateMany({
    where: { id: shareId, workspaceId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count > 0;
}

export async function getSharedMeeting(token: string): Promise<MeetingDetailResponse | null> {
  if (!token || token.length > 128) return null;
  const share = await prisma.meetingShareToken.findFirst({
    where: { tokenHash: hashToken(token), revokedAt: null, expiresAt: { gt: new Date() } },
    select: { workspaceId: true, meetingId: true },
  });
  if (!share) return null;
  return getMeeting(share.workspaceId, share.meetingId);
}
