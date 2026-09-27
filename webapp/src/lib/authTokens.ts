import { randomBytes } from "node:crypto";
import { prisma } from "./db";
import { hashToken } from "./apiTokens";
import { normalizeEmail } from "./email";

/**
 * Single-use, expiring tokens for email verification, password reset and
 * workspace invitations. Only SHA-256(token) is stored; the raw value exists
 * solely in the emailed (or owner-shown) link. Consumption is one atomic
 * conditional UPDATE, so two concurrent requests with the same link cannot
 * both succeed.
 */
export type AuthTokenPurpose = "verify_email" | "reset_password" | "invite";

const HOUR = 60 * 60 * 1000;
export const AUTH_TOKEN_TTL_MS: Record<AuthTokenPurpose, number> = {
  verify_email: 24 * HOUR,
  reset_password: 1 * HOUR,
  invite: 7 * 24 * HOUR,
};

export interface IssueAuthTokenInput {
  purpose: AuthTokenPurpose;
  email: string;
  userId?: string | null;
  workspaceId?: string | null;
  role?: "owner" | "member" | null;
  invitedById?: string | null;
  now?: number;
}

export interface AuthTokenRecord {
  id: string;
  purpose: AuthTokenPurpose;
  userId: string | null;
  email: string;
  workspaceId: string | null;
  role: string | null;
  invitedById: string | null;
  expiresAt: Date;
}

/** Issues a fresh token and invalidates any earlier unused one for the same subject. */
export async function issueAuthToken(input: IssueAuthTokenInput): Promise<{ token: string; expiresAt: Date }> {
  const now = input.now ?? Date.now();
  const email = normalizeEmail(input.email);
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now + AUTH_TOKEN_TTL_MS[input.purpose]);

  const supersede =
    input.purpose === "invite"
      ? { purpose: "invite", workspaceId: input.workspaceId ?? null, email }
      : { purpose: input.purpose, userId: input.userId ?? null, email };

  await prisma.$transaction([
    prisma.authToken.deleteMany({ where: { ...supersede, usedAt: null } }),
    prisma.authToken.create({
      data: {
        tokenHash: hashToken(token),
        purpose: input.purpose,
        email,
        userId: input.userId ?? null,
        workspaceId: input.workspaceId ?? null,
        role: input.role ?? null,
        invitedById: input.invitedById ?? null,
        expiresAt,
      },
    }),
  ]);
  return { token, expiresAt };
}

function toRecord(row: {
  id: string; purpose: string; userId: string | null; email: string; workspaceId: string | null;
  role: string | null; invitedById: string | null; expiresAt: Date;
}): AuthTokenRecord {
  return { ...row, purpose: row.purpose as AuthTokenPurpose };
}

/** Reads a token without spending it — used to render the confirmation page. */
export async function peekAuthToken(token: string, purpose: AuthTokenPurpose, now: number = Date.now()): Promise<AuthTokenRecord | null> {
  if (!token || token.length > 128) return null;
  const row = await prisma.authToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!row || row.purpose !== purpose || row.usedAt || row.expiresAt.getTime() <= now) return null;
  return toRecord(row);
}

/** Atomically spends a token; returns its record exactly once. */
export async function consumeAuthToken(token: string, purpose: AuthTokenPurpose, now: number = Date.now()): Promise<AuthTokenRecord | null> {
  if (!token || token.length > 128) return null;
  const tokenHash = hashToken(token);
  const spent = await prisma.authToken.updateMany({
    where: { tokenHash, purpose, usedAt: null, expiresAt: { gt: new Date(now) } },
    data: { usedAt: new Date(now) },
  });
  if (spent.count !== 1) return null;
  const row = await prisma.authToken.findUnique({ where: { tokenHash } });
  return row ? toRecord(row) : null;
}

export async function revokeInvites(workspaceId: string, inviteId: string): Promise<boolean> {
  const result = await prisma.authToken.deleteMany({ where: { id: inviteId, workspaceId, purpose: "invite", usedAt: null } });
  return result.count > 0;
}

export async function listPendingInvites(workspaceId: string, now: number = Date.now()) {
  return prisma.authToken.findMany({
    where: { workspaceId, purpose: "invite", usedAt: null, expiresAt: { gt: new Date(now) } },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    select: { id: true, email: true, role: true, createdAt: true, expiresAt: true },
  });
}
