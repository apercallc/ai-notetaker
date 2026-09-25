import { createHash, randomBytes } from "node:crypto";
import { prisma } from "./db";

/**
 * Bearer credentials for the browser extension and other managed clients.
 *
 * Policy (chosen for an MV3 extension that has no background refresh loop):
 * a 90-day SLIDING expiry. Each use inside an active period pushes expiry out
 * another 90 days (at most once an hour, so reads stay write-free), so a
 * device in regular use never signs out mid-meeting, while a lost or
 * abandoned device stops working on its own after 90 idle days. Any token can
 * also be revoked immediately from /account, and changing the password or
 * "sign out everywhere" revokes all of them.
 *
 * Only SHA-256(secret) is stored. The secret is 256 random bits, so a fast
 * hash is appropriate (there is nothing to brute-force) and lookups stay an
 * indexed equality match with no timing side channel worth exploiting.
 */
export const API_TOKEN_PREFIX = "ant_";
export const API_TOKEN_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
export const API_TOKEN_SCOPE = "managed";
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export function hashToken(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function looksLikeApiToken(value: string): boolean {
  return value.startsWith(API_TOKEN_PREFIX);
}

export interface CreatedApiToken {
  id: string;
  token: string;
  expiresAt: Date;
}

export async function createApiToken(
  userId: string,
  options: { label?: string | null; userAgent?: string | null; now?: number } = {},
): Promise<CreatedApiToken> {
  const now = options.now ?? Date.now();
  const token = `${API_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const expiresAt = new Date(now + API_TOKEN_LIFETIME_MS);
  const row = await prisma.apiToken.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      scope: API_TOKEN_SCOPE,
      label: options.label?.trim().slice(0, 80) || null,
      userAgent: options.userAgent?.slice(0, 300) ?? null,
      lastUsedAt: new Date(now),
      expiresAt,
    },
  });
  return { id: row.id, token, expiresAt };
}

export interface ApiTokenUser {
  id: string;
  email: string;
  tokenId: string;
}

/**
 * Resolves a bearer secret to its user, or null when it is unknown, revoked,
 * expired, or its account must first change a temporary password.
 */
export async function resolveApiToken(secret: string, now: number = Date.now()): Promise<ApiTokenUser | null> {
  if (!looksLikeApiToken(secret) || secret.length > 200) return null;
  const row = await prisma.apiToken.findUnique({
    where: { tokenHash: hashToken(secret) },
    include: { user: { select: { id: true, email: true, mustChangePassword: true } } },
  });
  if (!row || row.revokedAt || row.scope !== API_TOKEN_SCOPE) return null;
  if (row.expiresAt.getTime() <= now) {
    await prisma.apiToken.deleteMany({ where: { id: row.id } });
    return null;
  }
  if (row.user.mustChangePassword) return null;

  if (!row.lastUsedAt || row.lastUsedAt.getTime() < now - TOUCH_INTERVAL_MS) {
    await prisma.apiToken.updateMany({
      where: { id: row.id, revokedAt: null },
      data: { lastUsedAt: new Date(now), expiresAt: new Date(now + API_TOKEN_LIFETIME_MS) },
    });
  }
  return { id: row.user.id, email: row.user.email, tokenId: row.id };
}

/** Revokes one token, only if it belongs to `userId`. */
export async function revokeApiToken(userId: string, tokenId: string): Promise<boolean> {
  const result = await prisma.apiToken.deleteMany({ where: { id: tokenId, userId } });
  return result.count > 0;
}

export async function revokeApiTokenBySecret(secret: string): Promise<boolean> {
  if (!looksLikeApiToken(secret)) return false;
  const result = await prisma.apiToken.deleteMany({ where: { tokenHash: hashToken(secret) } });
  return result.count > 0;
}

export async function revokeAllApiTokens(userId: string): Promise<number> {
  return (await prisma.apiToken.deleteMany({ where: { userId } })).count;
}

export async function listApiTokens(userId: string, now: number = Date.now()) {
  return prisma.apiToken.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date(now) } },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    select: { id: true, label: true, userAgent: true, createdAt: true, lastUsedAt: true, expiresAt: true },
  });
}
