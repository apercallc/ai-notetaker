import { createHash, randomBytes } from "node:crypto";
import { prisma } from "./db";
import { getMeeting } from "./meetings";
import type { MeetingDetailResponse } from "./types";

export interface ActiveShare {
  id: string;
  createdAt: string;
  expiresAt: string;
}

const DEFAULT_SHARE_EXPIRY_DAYS = 7;
const MAX_SHARE_EXPIRY_DAYS = 30;

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

/**
 * Links that still work. Tokens are stored only as a hash, so an existing
 * link's URL cannot be reconstructed here: the owner sees it once, at
 * creation. This list exists so they can see and revoke what is out there.
 */
export async function listActiveShares(workspaceId: string, meetingId: string): Promise<ActiveShare[]> {
  const rows = await prisma.meetingShareToken.findMany({
    where: { workspaceId, meetingId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
    select: { id: true, createdAt: true, expiresAt: true },
  });
  return rows.map((row) => ({ id: row.id, createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString() }));
}

/**
 * The public view of a meeting. Deliberately narrower than the owner's view:
 * processing state and provider error text are internal and never leave.
 */
export async function getSharedMeeting(token: string): Promise<MeetingDetailResponse | null> {
  if (!token || token.length > 128) return null;
  const share = await prisma.meetingShareToken.findFirst({
    where: { tokenHash: hashToken(token), revokedAt: null, expiresAt: { gt: new Date() } },
    select: { workspaceId: true, meetingId: true },
  });
  if (!share) return null;
  const meeting = await getMeeting(share.workspaceId, share.meetingId);
  if (!meeting) return null;
  const { processing: _internal, ...publicView } = meeting;
  void _internal;
  return publicView;
}
