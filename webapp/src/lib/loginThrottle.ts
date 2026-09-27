import { prisma } from "@/lib/db";
import { normalizeEmail } from "@/lib/email";

/**
 * Abuse throttling kept in Postgres rather than process memory, so several
 * web replicas share one budget and a redeploy cannot reset it.
 *
 * Every protected action checks several independent keys at once. A request
 * is blocked as soon as ANY key is over budget:
 *
 *   pair  (ip + email)  tight budget — stops one machine guessing one account
 *   ip                  wide budget  — stops one machine spraying many accounts
 *   email               loose budget — backstop when the attacker rotates IPs
 *                        (or forges proxy headers); kept loose so an attacker
 *                        cannot cheaply lock a victim out
 *
 * Instead of a hard lockout, delay escalates: once a key passes its free
 * attempts the next attempt must wait `base * 2^n` (capped), measured from the
 * last failure. A correct password clears the pair and email keys.
 */

export interface ThrottleRule {
  key: string;
  /** Attempts allowed before any delay applies. */
  free: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Counters that see no activity for this long start over. */
  windowMs: number;
}

export interface ThrottleStatus {
  blocked: boolean;
  retryAfterMs: number;
}

const MINUTE = 60_000;
const CLEANUP_AGE_MS = 2 * 60 * MINUTE;

export function delayFor(failures: number, rule: ThrottleRule): number {
  if (failures <= rule.free) return 0;
  const exponent = Math.min(failures - rule.free - 1, 30);
  return Math.min(rule.baseDelayMs * 2 ** exponent, rule.maxDelayMs);
}

export async function throttleStatus(rules: ThrottleRule[], now: number = Date.now()): Promise<ThrottleStatus> {
  if (rules.length === 0) return { blocked: false, retryAfterMs: 0 };
  const rows = await prisma.loginThrottle.findMany({ where: { emailKey: { in: rules.map((rule) => rule.key) } } });
  let retryAfterMs = 0;
  for (const rule of rules) {
    const row = rows.find((candidate) => candidate.emailKey === rule.key);
    if (!row) continue;
    const lastAt = row.updatedAt.getTime();
    if (lastAt <= now - rule.windowMs) continue;
    const delay = delayFor(row.failures, rule);
    if (delay === 0) continue;
    const remaining = lastAt + delay - now;
    if (remaining > retryAfterMs) retryAfterMs = remaining;
  }
  return { blocked: retryAfterMs > 0, retryAfterMs };
}

/**
 * Atomically counts one hit per rule. `ON CONFLICT` serializes concurrent
 * replicas on the primary key so no increment is lost, and an idle counter
 * restarts at 1 inside the same statement.
 */
export async function recordThrottleHit(rules: ThrottleRule[], now: number = Date.now()): Promise<void> {
  const timestamp = new Date(now);
  await prisma.loginThrottle.deleteMany({ where: { updatedAt: { lte: new Date(now - CLEANUP_AGE_MS) } } });
  for (const rule of rules) {
    const windowStart = new Date(now - rule.windowMs);
    await prisma.$executeRaw`
      INSERT INTO "LoginThrottle" ("emailKey", "failures", "firstFailureAt", "updatedAt")
      VALUES (${rule.key}, 1, ${timestamp}, ${timestamp})
      ON CONFLICT ("emailKey") DO UPDATE
      SET "failures" = CASE WHEN "LoginThrottle"."updatedAt" <= ${windowStart} THEN 1 ELSE "LoginThrottle"."failures" + 1 END,
          "firstFailureAt" = CASE WHEN "LoginThrottle"."updatedAt" <= ${windowStart} THEN ${timestamp} ELSE "LoginThrottle"."firstFailureAt" END,
          "updatedAt" = ${timestamp}
    `;
  }
}

export async function clearThrottleKeys(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await prisma.loginThrottle.deleteMany({ where: { emailKey: { in: keys } } });
}

export function formatRetryAfter(retryAfterMs: number): string {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  if (seconds < 90) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------- sign-in

export interface ThrottleOptions {
  ip?: string | null;
  now?: number;
}

function loginRules(email: string, ip: string | null | undefined): ThrottleRule[] {
  const normalized = normalizeEmail(email);
  const rules: ThrottleRule[] = [
    { key: `login:email:${normalized}`, free: 10, baseDelayMs: 30_000, maxDelayMs: 15 * MINUTE, windowMs: 30 * MINUTE },
  ];
  if (ip) {
    rules.push(
      { key: `login:pair:${ip}|${normalized}`, free: 5, baseDelayMs: 15_000, maxDelayMs: 15 * MINUTE, windowMs: 30 * MINUTE },
      { key: `login:ip:${ip}`, free: 30, baseDelayMs: 30_000, maxDelayMs: 15 * MINUTE, windowMs: 30 * MINUTE },
    );
  }
  return rules;
}

export async function loginThrottleStatus(email: string, options: ThrottleOptions = {}): Promise<ThrottleStatus> {
  return throttleStatus(loginRules(email, options.ip), options.now);
}

/** True when this email/ip combination must wait before trying again. */
export async function isLoginThrottled(email: string, options: ThrottleOptions = {}): Promise<boolean> {
  return (await loginThrottleStatus(email, options)).blocked;
}

export async function recordLoginFailure(email: string, options: ThrottleOptions = {}): Promise<void> {
  await recordThrottleHit(loginRules(email, options.ip), options.now);
}

/** A correct password clears the pair and email budgets, never the shared IP one. */
export async function clearLoginFailures(email: string, options: { ip?: string | null } = {}): Promise<void> {
  const keys = loginRules(email, options.ip)
    .map((rule) => rule.key)
    .filter((key) => !key.startsWith("login:ip:"));
  await clearThrottleKeys(keys);
}

// ---------------------------------------------------------------- sign-up

function signupRules(ip: string | null | undefined): ThrottleRule[] {
  const rules: ThrottleRule[] = [
    // A whole deployment creating hundreds of workspaces an hour is abuse.
    { key: "signup:global", free: 200, baseDelayMs: MINUTE, maxDelayMs: 30 * MINUTE, windowMs: 60 * MINUTE },
  ];
  if (ip) rules.push({ key: `signup:ip:${ip}`, free: 5, baseDelayMs: 2 * MINUTE, maxDelayMs: 60 * MINUTE, windowMs: 60 * MINUTE });
  return rules;
}

export async function signupThrottleStatus(options: ThrottleOptions = {}): Promise<ThrottleStatus> {
  return throttleStatus(signupRules(options.ip), options.now);
}

/** Counts every signup attempt, successful or not. */
export async function recordSignupAttempt(options: ThrottleOptions = {}): Promise<void> {
  await recordThrottleHit(signupRules(options.ip), options.now);
}

// ------------------------------------------- reset / verification emails

function emailRequestRules(kind: string, email: string, ip: string | null | undefined): ThrottleRule[] {
  const normalized = normalizeEmail(email);
  const rules: ThrottleRule[] = [
    { key: `${kind}:email:${normalized}`, free: 3, baseDelayMs: 5 * MINUTE, maxDelayMs: 60 * MINUTE, windowMs: 60 * MINUTE },
  ];
  if (ip) rules.push({ key: `${kind}:ip:${ip}`, free: 10, baseDelayMs: 5 * MINUTE, maxDelayMs: 60 * MINUTE, windowMs: 60 * MINUTE });
  return rules;
}

export async function emailRequestStatus(kind: "reset" | "verify" | "invite", email: string, options: ThrottleOptions = {}): Promise<ThrottleStatus> {
  return throttleStatus(emailRequestRules(kind, email, options.ip), options.now);
}

export async function recordEmailRequest(kind: "reset" | "verify" | "invite", email: string, options: ThrottleOptions = {}): Promise<void> {
  await recordThrottleHit(emailRequestRules(kind, email, options.ip), options.now);
}
