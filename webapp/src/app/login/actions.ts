"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { isValidSetupToken } from "@/lib/auth";
import { hashPassword } from "@/lib/passwords";
import { createSession, deleteSession, setSessionActiveWorkspace } from "@/lib/sessions";
import { createWorkspaceWithOwner, getDefaultWorkspaceId, resolveActiveWorkspace } from "@/lib/workspaces";
import { safeNextPath } from "@/lib/navigation";
import { emailRequestStatus, recordEmailRequest } from "@/lib/loginThrottle";
import { normalizeEmail } from "@/lib/email";
import { MIN_PASSWORD_LENGTH } from "@/lib/passwordPolicy";
import { clearSessionCookie, SESSION_COOKIE, setSessionCookie } from "@/lib/sessionCookie";
import { getRequestContext } from "@/lib/requestContext";
import { emailDeliveryMode } from "@/lib/mailer";
import { sendPasswordResetEmail, sendVerificationEmail } from "@/lib/authEmails";
import { cookies } from "next/headers";
import { getSessionContext } from "@/lib/sessions";
import {
  acceptInviteAsUser,
  acceptInviteWithNewAccount,
  authenticateCredentials,
  completeEmailVerification,
  completePasswordReset,
  registerHostedAccount,
} from "@/lib/accounts";
import { loginUrl } from "./url";

// Responses that must not reveal whether an address has an account take the
// same minimum time whether or not one exists.
const MIN_NEUTRAL_RESPONSE_MS = process.env.NODE_ENV === "test" ? 0 : 800;

async function padTo(startedAt: number): Promise<void> {
  const remaining = MIN_NEUTRAL_RESPONSE_MS - (Date.now() - startedAt);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}

function field(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "");
}

function nextField(formData: FormData): string {
  // Protocol-relative URLs such as //evil.example also start with `/` but
  // would turn the post-login redirect into an open redirect.
  return safeNextPath(field(formData, "next") || "/meetings");
}

async function hasAnyUser(): Promise<boolean> {
  return (await prisma.user.count()) > 0;
}

/** Creates the first account for a freshly deployed self-hosted instance —
 * that user becomes the owner of its pre-created default workspace.
 * No new required environment variable: the deploy-time AUTH_TOKEN doubles
 * as the one-time setup code, so claiming ownership still requires knowing
 * the same secret today's single-session flow required — without this
 * check, the first anonymous visitor to the public URL (not necessarily
 * its owner) could claim the account with an arbitrary email/password.
 */
export async function bootstrap(formData: FormData): Promise<void> {
  if (await hasAnyUser()) redirect("/login");

  const setupToken = field(formData, "setupToken");
  const email = normalizeEmail(field(formData, "email"));
  const password = field(formData, "password");
  const confirmPassword = field(formData, "confirmPassword");

  if (
    !isValidSetupToken(setupToken) ||
    !email ||
    password.length < MIN_PASSWORD_LENGTH ||
    password !== confirmPassword
  ) {
    redirect("/login?error=bootstrap");
  }

  await getDefaultWorkspaceId(); // fails loudly if the migration hasn't run — a 500, not a silent wrong state
  const passwordHash = await hashPassword(password);
  const { userId, workspaceId } = await createWorkspaceWithOwner(email, passwordHash);
  const context = await getRequestContext();
  const session = await createSession(userId, { ...context, activeWorkspaceId: workspaceId });
  await setSessionCookie(session, context);

  redirect("/meetings");
}

export async function login(formData: FormData): Promise<void> {
  const email = field(formData, "email");
  const password = field(formData, "password");
  const safeNext = nextField(formData);
  const context = await getRequestContext();

  const result = await authenticateCredentials({ email, password, ip: context.ip });
  if (!result.ok) {
    if (result.reason === "throttled") {
      redirect(loginUrl({ error: "throttled", retry: Math.ceil(result.retryAfterMs / 1000), next: safeNext }));
    }
    if (result.reason === "unverified") {
      redirect(loginUrl({ error: "unverified", email: result.email, next: safeNext }));
    }
    redirect(loginUrl({ error: "invalid", next: safeNext }));
  }

  const active = await resolveActiveWorkspace(result.user.id);
  if (!active) redirect(loginUrl({ error: "no-workspace", next: safeNext }));

  const session = await createSession(result.user.id, { ...context, activeWorkspaceId: active.workspaceId });
  await setSessionCookie(session, context);

  redirect(result.user.mustChangePassword ? "/account?required=1" : safeNext);
}

/** Managed hosting is the only public signup surface. Self-hosted instances
 * remain claimable only through the deployer's AUTH_TOKEN bootstrap flow. */
export async function signup(formData: FormData): Promise<void> {
  const next = nextField(formData);
  const context = await getRequestContext();
  const result = await registerHostedAccount({
    email: field(formData, "email"),
    password: field(formData, "password"),
    confirmPassword: field(formData, "confirmPassword"),
    workspaceName: field(formData, "workspaceName"),
    acceptedTerms: formData.get("acceptTerms") === "on",
    context,
  });

  if (!result.ok) {
    if (result.error === "throttled") {
      redirect(loginUrl({ tab: "signup", error: "throttled", retry: Math.ceil(result.retryAfterMs / 1000), next }));
    }
    redirect(loginUrl({ tab: "signup", error: result.error, problem: result.problem, next }));
  }

  if (result.verificationRequired) {
    redirect(loginUrl({ notice: "verify-sent", next }));
  }
  const session = await createSession(result.userId, { ...context, activeWorkspaceId: result.workspaceId });
  await setSessionCookie(session, context);
  redirect(next);
}

/**
 * "Forgot password". Always answers the same way for known and unknown
 * addresses, in the same time, so it cannot be used to discover accounts.
 */
export async function requestPasswordReset(formData: FormData): Promise<void> {
  const startedAt = Date.now();
  const email = normalizeEmail(field(formData, "email"));
  const next = nextField(formData);
  const context = await getRequestContext();

  if (emailDeliveryMode() === "none") redirect(loginUrl({ tab: "forgot", error: "email-not-configured", next }));

  const status = await emailRequestStatus("reset", email, { ip: context.ip });
  if (status.blocked) {
    redirect(loginUrl({ tab: "forgot", error: "throttled", retry: Math.ceil(status.retryAfterMs / 1000), next }));
  }
  if (email) {
    await recordEmailRequest("reset", email, { ip: context.ip });
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true } });
    if (user) await sendPasswordResetEmail({ userId: user.id, email: user.email, context });
  }
  await padTo(startedAt);
  redirect(loginUrl({ tab: "forgot", notice: "reset-sent", next }));
}

/** Resends the verification link for an unverified account; neutral like reset. */
export async function resendVerification(formData: FormData): Promise<void> {
  const startedAt = Date.now();
  const email = normalizeEmail(field(formData, "email"));
  const next = nextField(formData);
  const context = await getRequestContext();

  if (emailDeliveryMode() === "none") redirect(loginUrl({ error: "email-not-configured", next }));
  const status = await emailRequestStatus("verify", email, { ip: context.ip });
  if (status.blocked) {
    redirect(loginUrl({ error: "throttled", retry: Math.ceil(status.retryAfterMs / 1000), next }));
  }
  if (email) {
    await recordEmailRequest("verify", email, { ip: context.ip });
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true, emailVerifiedAt: true } });
    if (user && !user.emailVerifiedAt) await sendVerificationEmail({ userId: user.id, email: user.email, context });
  }
  await padTo(startedAt);
  redirect(loginUrl({ notice: "verify-sent", next }));
}

/** Spends an email-verification link. A POST on purpose: mail scanners that
 * prefetch links with GET must not be able to consume a single-use token. */
export async function verifyEmail(formData: FormData): Promise<void> {
  const result = await completeEmailVerification(field(formData, "token"));
  if (!result.ok) redirect(loginUrl({ error: "token-invalid" }));
  redirect(loginUrl({ notice: "verified" }));
}

export async function resetPassword(formData: FormData): Promise<void> {
  const token = field(formData, "token");
  const result = await completePasswordReset(token, field(formData, "password"), field(formData, "confirmPassword"));
  if (!result.ok) {
    if (result.reason === "invalid-token") redirect(loginUrl({ error: "token-invalid" }));
    redirect(loginUrl({
      tab: "reset",
      token,
      error: result.reason === "mismatch" ? "password-mismatch" : "weak-password",
      problem: result.problem,
    }));
  }
  redirect(loginUrl({ notice: "password-reset" }));
}

/** A signed-in user joins the workspace an invite email names. */
export async function acceptInvite(formData: FormData): Promise<void> {
  const token = field(formData, "token");
  const store = await cookies();
  const context = await getSessionContext(store.get(SESSION_COOKIE)?.value);
  if (!context) redirect(loginUrl({ next: `/login?tab=invite&token=${encodeURIComponent(token)}` }));

  const result = await acceptInviteAsUser(token, { id: context.user.id, email: context.user.email });
  if (!result.ok) {
    redirect(loginUrl({
      tab: "invite",
      token: result.reason === "email-mismatch" ? token : undefined,
      error: result.reason === "already-member" ? "invite-already-member" : result.reason === "email-mismatch" ? "invite-email-mismatch" : "token-invalid",
    }));
  }
  await setSessionActiveWorkspace(context.sessionId, result.workspaceId);
  redirect("/meetings");
}

/** An invitee with no account creates one and joins in a single step. */
export async function acceptInviteNewAccount(formData: FormData): Promise<void> {
  const token = field(formData, "token");
  const result = await acceptInviteWithNewAccount({
    token,
    password: field(formData, "password"),
    confirmPassword: field(formData, "confirmPassword"),
    acceptedTerms: formData.get("acceptTerms") === "on",
  });
  if (!result.ok) {
    if (result.reason === "invalid-token" || result.reason === "workspace-gone") redirect(loginUrl({ error: "token-invalid" }));
    if (result.reason === "account-exists") redirect(loginUrl({ tab: "invite", token }));
    redirect(loginUrl({
      tab: "invite",
      token,
      error: result.reason === "mismatch" ? "password-mismatch" : result.reason === "consent-required" ? "consent-required" : "weak-password",
      problem: result.problem,
    }));
  }
  const context = await getRequestContext();
  const session = await createSession(result.userId, { ...context, activeWorkspaceId: result.workspaceId });
  await setSessionCookie(session, context);
  redirect("/meetings");
}

/** End the browser session early on a shared or public machine. Deletes
 * the Session row itself, not just the cookie, so a stolen cookie value
 * stops working the moment the real user logs out. */
export async function logout(): Promise<void> {
  const store = await cookies();
  const sessionId = store.get(SESSION_COOKIE)?.value;
  if (sessionId) await deleteSession(sessionId);
  await clearSessionCookie();
  redirect("/login");
}
