import { createHash, randomBytes } from "node:crypto";
import { hashToken } from "./apiTokens";
import { prisma } from "./db";
import { getMeeting } from "./meetings";
import type { MeetingDetailResponse } from "./types";

export interface ActiveShare {
  id: string;
  createdAt: string;
  /** null = never expires */
  expiresAt: string | null;
}

const DEFAULT_SHARE_EXPIRY_DAYS = 7;
const MAX_SHARE_EXPIRY_DAYS = 365;
/** Active links per note. Keeps the note page's list (and the public surface) bounded. */
export const MAX_ACTIVE_SHARES_PER_MEETING = 25;

/** `null` means the link never expires. */
export type ShareExpiry = number | null;

const stillValid = () => ({ OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] });

export class SharingValidationError extends Error {}

function expiryDate(days: number): Date {
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_SHARE_EXPIRY_DAYS) {
    throw new SharingValidationError(`Choose a link that expires in 1 to ${MAX_SHARE_EXPIRY_DAYS} days.`);
  }
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

export async function createMeetingShare(
  workspaceId: string,
  meetingId: string,
  expiresInDays: ShareExpiry = DEFAULT_SHARE_EXPIRY_DAYS,
): Promise<{ id: string; token: string; expiresAt: Date | null }> {
  const expiresAt = expiresInDays === null ? null : expiryDate(expiresInDays);
  const meeting = await prisma.meeting.findFirst({ where: { id: meetingId, workspaceId, deletedAt: null }, select: { id: true } });
  if (!meeting) throw new SharingValidationError("This note no longer exists.");
  const active = await prisma.meetingShareToken.count({ where: { workspaceId, meetingId, revokedAt: null, ...stillValid() } });
  if (active >= MAX_ACTIVE_SHARES_PER_MEETING) {
    throw new SharingValidationError(`This note already has ${MAX_ACTIVE_SHARES_PER_MEETING} active links. Revoke one you no longer need first.`);
  }

  const token = randomBytes(32).toString("base64url");
  const share = await prisma.meetingShareToken.create({
    data: { workspaceId, meetingId, tokenHash: hashToken(token), expiresAt },
    select: { id: true, expiresAt: true },
  });
  return { ...share, token };
}

export async function revokeMeetingShare(workspaceId: string, shareId: string, meetingId?: string): Promise<boolean> {
  if (!shareId || shareId.length > 128) throw new SharingValidationError("That link is no longer valid.");
  const result = await prisma.meetingShareToken.updateMany({
    // When the caller names the note (the UI always does), the link must belong to it.
    where: { id: shareId, workspaceId, revokedAt: null, ...(meetingId ? { meetingId } : {}) },
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
    where: { workspaceId, meetingId, revokedAt: null, ...stillValid() },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: MAX_ACTIVE_SHARES_PER_MEETING,
    select: { id: true, createdAt: true, expiresAt: true },
  });
  return rows.map((row) => ({ id: row.id, createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt?.toISOString() ?? null }));
}

/**
 * The public view of a meeting. Deliberately narrower than the owner's view:
 * processing state and provider error text are internal and never leave.
 */
export async function getSharedMeeting(token: string): Promise<MeetingDetailResponse | null> {
  if (!token || token.length > 128) return null;
  const share = await prisma.meetingShareToken.findFirst({
    where: { tokenHash: hashToken(token), revokedAt: null, ...stillValid() },
    select: { workspaceId: true, meetingId: true },
  });
  if (!share) return null;
  const meeting = await getMeeting(share.workspaceId, share.meetingId);
  if (!meeting) return null;
  // Internal processing details never reach a share link's reader.
  const { processing: _processing, processingMode: _mode, notesRegenerations: _regenerations, folderId: _folder, language: _language, version: _version, summaryEditedAt: _edited, hasPreviousSummary: _previous, isManual: _manual, ...publicView } = meeting;
  void [_language, _processing, _mode, _regenerations, _folder, _version, _edited, _previous, _manual];
  return publicView;
}
