import { prisma } from "./db";
import { TrialGrantLimitError } from "./trialGrants";
import { randomBytes } from "node:crypto";
import { hashPassword, verifyPassword, DUMMY_PASSWORD_HASH } from "./passwords";
import { isPlausibleEmail, normalizeEmail } from "./email";
import { MAX_PASSWORD_LENGTH, passwordProblem, type PasswordProblem } from "./passwordPolicy";
import {
  clearLoginFailures,
  clearThrottleKeys,
  loginThrottleStatus,
  recordLoginFailure,
  recordSignupAttempt,
  recordThrottleHit,
  signupThrottleStatus,
  throttleStatus,
  type ThrottleRule,
} from "./loginThrottle";
import { emailVerificationRequired, signupAvailability, CURRENT_TERMS_VERSION } from "./signupPolicy";
import { emailDeliveryMode } from "./mailer";
import { sendVerificationEmail, type DeliveredLink } from "./authEmails";
import { consumeAuthToken, peekAuthToken } from "./authTokens";
import { revokeAllApiTokens } from "./apiTokens";
import { cleanupExpiredAuth } from "./sessions";
import { createHostedWorkspaceWithOwner, createUserFromInvite, joinWorkspaceFromInvite, resolveActiveWorkspace } from "./workspaces";
import type { RequestContext } from "./requestContext";

const MAX_WORKSPACE_NAME_LENGTH = 100;

// ------------------------------------------------------------ sign-in

export type AuthenticationResult =
  | { ok: true; user: { id: string; email: string; mustChangePassword: boolean } }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "throttled"; retryAfterMs: number }
  | { ok: false; reason: "unverified"; email: string };

/**
 * Shared by the web sign-in action and the extension's /api/v1/auth/login so
 * both enforce identical normalization, throttling, timing defence and
 * verification rules.
 */
export async function authenticateCredentials(input: {
  email: string;
  password: string;
  ip: string | null;
  now?: number;
}): Promise<AuthenticationResult> {
  const email = normalizeEmail(input.email);
  const options = { ip: input.ip, now: input.now };

  const status = await loginThrottleStatus(email, options);
  if (status.blocked) return { ok: false, reason: "throttled", retryAfterMs: status.retryAfterMs };

  const user = email ? await prisma.user.findUnique({ where: { email } }) : null;
  // A very long password never reaches scrypt (cheap DoS), but still counts as a failure.
  const tooLong = input.password.length > MAX_PASSWORD_LENGTH;
  // Always pay scrypt's cost, even for an email with no account — otherwise
  // an unknown email returns fast while a known email with a wrong password
  // returns slow, letting an attacker enumerate registered emails by timing.
  const matches = tooLong ? false : await verifyPassword(input.password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
  if (!user || !matches) {
    await recordLoginFailure(email, options);
    return { ok: false, reason: "invalid" };
  }

  // Only after the password is proven: revealing "unverified" earlier would
  // confirm the address has an account.
  if (!user.emailVerifiedAt && emailVerificationRequired()) return { ok: false, reason: "unverified", email };

  await clearLoginFailures(email, { ip: input.ip });
  await cleanupExpiredAuth();
  return { ok: true, user: { id: user.id, email: user.email, mustChangePassword: user.mustChangePassword } };
}

// ------------------------------------------------------------ sign-up

export type SignupError =
  | "signup-disabled"
  | "signup-not-ready"
  | "signup-email-required"
  | "email-invalid"
  | "password-mismatch"
  | "weak-password"
  | "workspace-name"
  | "consent-required"
  | "email-taken";

export type SignupResult =
  | { ok: true; userId: string; workspaceId: string; verificationRequired: boolean; verification: DeliveredLink | null }
  | { ok: false; error: "throttled"; retryAfterMs: number }
  | { ok: false; error: SignupError; problem?: PasswordProblem };

export async function registerHostedAccount(input: {
  email: string;
  password: string;
  confirmPassword: string;
  workspaceName: string;
  acceptedTerms: boolean;
  context: RequestContext;
  now?: number;
}): Promise<SignupResult> {
  const availability = signupAvailability();
  if (!availability.allowed) {
    return {
      ok: false,
      error: availability.reason === "disabled" ? "signup-disabled" : availability.reason === "not-ready" ? "signup-not-ready" : "signup-email-required",
    };
  }
  const throttle = { ip: input.context.ip, now: input.now };
  const status = await signupThrottleStatus(throttle);
  if (status.blocked) return { ok: false, error: "throttled", retryAfterMs: status.retryAfterMs };

  const email = normalizeEmail(input.email);
  const workspaceName = input.workspaceName.normalize("NFC").trim().slice(0, MAX_WORKSPACE_NAME_LENGTH);
  if (!isPlausibleEmail(email)) return { ok: false, error: "email-invalid" };
  if (workspaceName.length < 2) return { ok: false, error: "workspace-name" };
  if (input.password !== input.confirmPassword) return { ok: false, error: "password-mismatch" };
  const problem = passwordProblem(input.password, email);
  if (problem) return { ok: false, error: "weak-password", problem };
  if (!input.acceptedTerms) return { ok: false, error: "consent-required" };

  // From here on the request costs real work (scrypt, DB writes, email).
  await recordSignupAttempt(throttle);

  if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) return { ok: false, error: "email-taken" };

  const verificationRequired = emailVerificationRequired();
  try {
    const passwordHash = await hashPassword(input.password);
    const { userId, workspaceId } = await createHostedWorkspaceWithOwner(email, passwordHash, workspaceName, {
      termsAcceptedAt: new Date(input.now ?? Date.now()),
      termsVersion: CURRENT_TERMS_VERSION,
    });
    let verification: DeliveredLink | null = null;
    // Send when a transport exists even if verification is optional, so the
    // address gets confirmed as soon as its owner clicks.
    if (verificationRequired || emailDeliveryMode() !== "none") {
      verification = await sendVerificationEmail({ userId, email, context: input.context });
    }
    return { ok: true, userId, workspaceId, verificationRequired, verification };
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") return { ok: false, error: "email-taken" };
    if (error instanceof TrialGrantLimitError) return { ok: false, error: "signup-not-ready" };
    throw error;
  }
}

// ------------------------------------------------- Google sign-in

export type GoogleSignInResult =
  | { ok: true; userId: string; workspaceId: string; created: boolean; mustChangePassword: boolean }
  | { ok: false; error: "google-email-unverified" | "google-account-unconfirmed" | "google-account-provisioned" | "google-no-account" | "no-workspace" | "consent-required" | SignupError }
  | { ok: false; error: "throttled"; retryAfterMs: number };

/**
 * Signs in (or, in `signup` mode, creates) the account for an email Google
 * vouches for.
 *
 * Linking rules — all deliberate:
 * - Google's `email_verified` must be true; anything else is refused.
 * - An existing account whose own email is verified is signed into directly.
 * - An existing account that never confirmed its email is REFUSED, not taken
 *   over. Otherwise someone could pre-register a victim's address with a
 *   password they know and inherit the victim's Google sign-in later.
 * - An account an owner provisioned for that address is refused for the same
 *   reason: someone else holds its password.
 * - `signin` never creates an account: terms consent is collected on our own
 *   page before the redirect, so a new user is sent to the sign-up form.
 * - New accounts get the same workspace, trial and terms record as email
 *   sign-ups. Their password is random and unknowable; "Forgot your
 *   password?" lets them set one.
 */
export async function resolveGoogleAccount(input: {
  email: string;
  emailVerified: boolean;
  mode: "signin" | "signup";
  termsAccepted: boolean;
  workspaceName?: string;
  context: RequestContext;
  now?: number;
}): Promise<GoogleSignInResult> {
  if (!input.emailVerified) return { ok: false, error: "google-email-unverified" };
  const email = normalizeEmail(input.email);
  if (!isPlausibleEmail(email)) return { ok: false, error: "email-invalid" };

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true, emailVerifiedAt: true, mustChangePassword: true, ownerProvisioned: true } });
  if (existing) {
    if (!existing.emailVerifiedAt) return { ok: false, error: "google-account-unconfirmed" };
    // A workspace owner created this account with a password they chose. The
    // real mailbox holder never proved the address, so Google must not sign
    // them into it (the owner would keep a working password).
    if (existing.ownerProvisioned) return { ok: false, error: "google-account-provisioned" };
    const active = await resolveActiveWorkspace(existing.id);
    if (!active) return { ok: false, error: "no-workspace" };
    return { ok: true, userId: existing.id, workspaceId: active.workspaceId, created: false, mustChangePassword: existing.mustChangePassword };
  }

  if (input.mode !== "signup") return { ok: false, error: "google-no-account" };
  const availability = signupAvailability();
  // Google already proved the mailbox, so a missing email transport is not a blocker here.
  if (!availability.allowed && availability.reason !== "email-required") {
    return { ok: false, error: availability.reason === "disabled" ? "signup-disabled" : "signup-not-ready" };
  }
  if (!input.termsAccepted) return { ok: false, error: "consent-required" };
  const throttle = { ip: input.context.ip, now: input.now };
  const status = await signupThrottleStatus(throttle);
  if (status.blocked) return { ok: false, error: "throttled", retryAfterMs: status.retryAfterMs };
  await recordSignupAttempt(throttle);

  const requested = (input.workspaceName ?? "").normalize("NFC").trim().slice(0, MAX_WORKSPACE_NAME_LENGTH);
  const workspaceName = requested.length >= 2 ? requested : `${email.split("@")[0]}'s workspace`.slice(0, MAX_WORKSPACE_NAME_LENGTH);
  try {
    const passwordHash = await hashPassword(randomBytes(32).toString("base64url"));
    const now = new Date(input.now ?? Date.now());
    const { userId, workspaceId } = await createHostedWorkspaceWithOwner(email, passwordHash, workspaceName, {
      termsAcceptedAt: now,
      termsVersion: CURRENT_TERMS_VERSION,
      emailVerifiedAt: now,
    });
    return { ok: true, userId, workspaceId, created: true, mustChangePassword: false };
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") return { ok: false, error: "email-taken" };
    if (error instanceof TrialGrantLimitError) return { ok: false, error: "signup-not-ready" };
    throw error;
  }
}

// ------------------------------------------------- verification / reset

export async function completeEmailVerification(token: string): Promise<{ ok: true; email: string } | { ok: false }> {
  const record = await consumeAuthToken(token, "verify_email");
  if (!record?.userId) return { ok: false };
  await prisma.user.updateMany({ where: { id: record.userId, emailVerifiedAt: null }, data: { emailVerifiedAt: new Date() } });
  return { ok: true, email: record.email };
}

export async function isResetTokenValid(token: string): Promise<boolean> {
  return (await peekAuthToken(token, "reset_password")) !== null;
}

export type ResetResult = { ok: true } | { ok: false; reason: "invalid-token" | "weak-password" | "mismatch"; problem?: PasswordProblem };

/**
 * Sets a new password from a reset link. The password is validated BEFORE the
 * token is spent so a typo does not burn the link. Success revokes every
 * browser session and API token, since a reset usually means "someone else
 * may have had access".
 */
export async function completePasswordReset(token: string, password: string, confirmPassword: string): Promise<ResetResult> {
  const peeked = await peekAuthToken(token, "reset_password");
  if (!peeked?.userId) return { ok: false, reason: "invalid-token" };
  if (password !== confirmPassword) return { ok: false, reason: "mismatch" };
  const problem = passwordProblem(password, peeked.email);
  if (problem) return { ok: false, reason: "weak-password", problem };

  const record = await consumeAuthToken(token, "reset_password");
  if (!record?.userId) return { ok: false, reason: "invalid-token" };

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.findUnique({ where: { id: record.userId }, select: { id: true, email: true, emailVerifiedAt: true } });
  if (!user || normalizeEmail(user.email) !== normalizeEmail(record.email)) return { ok: false, reason: "invalid-token" };
  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      // Following an emailed link also proves the mailbox.
      data: { passwordHash, mustChangePassword: false, emailVerifiedAt: user.emailVerifiedAt ?? new Date() },
    }),
    prisma.session.deleteMany({ where: { userId: user.id } }),
  ]);
  await revokeAllApiTokens(user.id);
  await clearThrottleKeys([`login:email:${normalizeEmail(user.email)}`]);
  return { ok: true };
}

// ------------------------------------------------------ change password

export type ChangePasswordResult =
  | { ok: true }
  | { ok: false; reason: "wrong-password" | "weak-password" | "mismatch" | "same-password" | "throttled"; problem?: PasswordProblem; retryAfterMs?: number };

function changePasswordRule(userId: string): ThrottleRule {
  return { key: `pwchange:user:${userId}`, free: 5, baseDelayMs: 60_000, maxDelayMs: 30 * 60_000, windowMs: 30 * 60_000 };
}

/**
 * Changes the signed-in user's password. The current password is required
 * (a stolen cookie alone must not be enough to lock the owner out) and its
 * guesses are throttled. Every OTHER session and all API tokens are revoked;
 * the session making the request survives.
 */
export async function changePassword(input: {
  userId: string;
  keepSessionId: string;
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
  now?: number;
}): Promise<ChangePasswordResult> {
  const rule = changePasswordRule(input.userId);
  const status = await throttleStatus([rule], input.now);
  if (status.blocked) return { ok: false, reason: "throttled", retryAfterMs: status.retryAfterMs };

  const user = await prisma.user.findUnique({ where: { id: input.userId } });
  if (!user) return { ok: false, reason: "wrong-password" };
  const valid = input.currentPassword.length <= MAX_PASSWORD_LENGTH && (await verifyPassword(input.currentPassword, user.passwordHash));
  if (!valid) {
    await recordThrottleHit([rule], input.now);
    return { ok: false, reason: "wrong-password" };
  }
  if (input.newPassword !== input.confirmPassword) return { ok: false, reason: "mismatch" };
  if (input.newPassword === input.currentPassword) return { ok: false, reason: "same-password" };
  const problem = passwordProblem(input.newPassword, user.email);
  if (problem) return { ok: false, reason: "weak-password", problem };

  const passwordHash = await hashPassword(input.newPassword);
  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { passwordHash, mustChangePassword: false } }),
    prisma.session.deleteMany({ where: { userId: user.id, id: { not: input.keepSessionId } } }),
  ]);
  await revokeAllApiTokens(user.id);
  await clearThrottleKeys([rule.key]);
  return { ok: true };
}

// ------------------------------------------------------------- invites

export type InviteAcceptanceResult =
  | { ok: true; userId: string; workspaceId: string }
  | { ok: false; reason: "invalid-token" | "email-mismatch" | "already-member" | "workspace-gone" | "weak-password" | "mismatch" | "consent-required" | "account-exists"; problem?: PasswordProblem };

/** Existing user accepts an invite while signed in as the invited address. */
export async function acceptInviteAsUser(token: string, user: { id: string; email: string }): Promise<InviteAcceptanceResult> {
  const peeked = await peekAuthToken(token, "invite");
  if (!peeked?.workspaceId) return { ok: false, reason: "invalid-token" };
  // A signed-in person for a DIFFERENT address must not burn the link.
  if (normalizeEmail(user.email) !== peeked.email) return { ok: false, reason: "email-mismatch" };
  const record = await consumeAuthToken(token, "invite");
  if (!record?.workspaceId) return { ok: false, reason: "invalid-token" };
  const joined = await joinWorkspaceFromInvite(user.id, user.email, { email: record.email, workspaceId: record.workspaceId, role: record.role });
  return joined.ok ? joined : { ok: false, reason: joined.reason };
}

/** Invitee with no account creates one; possession of the link proves the mailbox. */
export async function acceptInviteWithNewAccount(input: {
  token: string;
  password: string;
  confirmPassword: string;
  acceptedTerms: boolean;
}): Promise<InviteAcceptanceResult> {
  const peeked = await peekAuthToken(input.token, "invite");
  if (!peeked?.workspaceId) return { ok: false, reason: "invalid-token" };
  if (await prisma.user.findUnique({ where: { email: peeked.email }, select: { id: true } })) return { ok: false, reason: "account-exists" };
  if (input.password !== input.confirmPassword) return { ok: false, reason: "mismatch" };
  const problem = passwordProblem(input.password, peeked.email);
  if (problem) return { ok: false, reason: "weak-password", problem };
  if (!input.acceptedTerms) return { ok: false, reason: "consent-required" };

  const record = await consumeAuthToken(input.token, "invite");
  if (!record?.workspaceId) return { ok: false, reason: "invalid-token" };
  try {
    const passwordHash = await hashPassword(input.password);
    const created = await createUserFromInvite(
      { email: record.email, workspaceId: record.workspaceId, role: record.role },
      passwordHash,
      { termsAcceptedAt: new Date(), termsVersion: CURRENT_TERMS_VERSION },
    );
    return { ok: true, ...created };
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") return { ok: false, reason: "account-exists" };
    if (error instanceof Error && error.message === "workspace no longer exists") return { ok: false, reason: "workspace-gone" };
    throw error;
  }
}
