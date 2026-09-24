"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { isValidSetupToken } from "@/lib/auth";
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from "@/lib/passwords";
import { createSession, deleteSession } from "@/lib/sessions";
import { createHostedWorkspaceWithOwner, createWorkspaceWithOwner, getDefaultWorkspaceId } from "@/lib/workspaces";
import { safeNextPath } from "@/lib/navigation";
import { clearLoginFailures, isLoginThrottled, recordLoginFailure } from "@/lib/loginThrottle";

const MIN_PASSWORD_LENGTH = 12;
const MAX_WORKSPACE_NAME_LENGTH = 100;

async function hasAnyUser(): Promise<boolean> {
  return (await prisma.user.count()) > 0;
}

async function setSessionCookie(session: { id: string; expiresAt: Date }): Promise<void> {
  const store = await cookies();
  store.set("session", session.id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: session.expiresAt,
  });
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

  const setupToken = String(formData.get("setupToken") ?? "");
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");

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
  const { userId } = await createWorkspaceWithOwner(email, passwordHash);
  const session = await createSession(userId);
  await setSessionCookie(session);

  redirect("/meetings");
}

export async function login(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/meetings");
  // Protocol-relative URLs such as //evil.example also start with `/` but
  // would turn the post-login redirect into an open redirect.
  const safeNext = safeNextPath(next);

  // This instance is on a public URL, so an unlimited guessing loop is worth
  // far more to an attacker than a stolen hash. The same generic error as a
  // wrong password: saying "too many attempts" would confirm the address is
  // worth attacking, which is exactly what the dummy-hash timing defence
  // below exists to avoid leaking.
  if (await isLoginThrottled(email)) {
    redirect(`/login?error=1&next=${encodeURIComponent(safeNext)}`);
  }

  const user = await prisma.user.findUnique({ where: { email } });
  // Always pay scrypt's cost, even for an email with no account — otherwise
  // an unknown email returns fast (skips verifyPassword entirely) while a
  // known email with a wrong password returns slow, letting an attacker
  // enumerate registered emails by timing the response.
  const passwordMatches = await verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
  if (!user || !passwordMatches) {
    await recordLoginFailure(email);
    redirect(`/login?error=1&next=${encodeURIComponent(safeNext)}`);
  }

  await clearLoginFailures(email);
  const session = await createSession(user.id);
  await setSessionCookie(session);

  redirect(safeNext);
}

/** Managed hosting is the only public signup surface. Self-hosted instances
 * remain claimable only through the deployer's AUTH_TOKEN bootstrap flow. */
export async function signup(formData: FormData): Promise<void> {
  if (process.env.MANAGED_HOSTING !== "true") redirect("/login?error=signup-disabled");

  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");
  const workspaceName = String(formData.get("workspaceName") ?? "").trim().slice(0, MAX_WORKSPACE_NAME_LENGTH);
  if (!email || email.length > 320 || workspaceName.length < 2 || password.length < MIN_PASSWORD_LENGTH || password !== confirmPassword) {
    redirect("/login?error=signup");
  }

  try {
    const passwordHash = await hashPassword(password);
    const { userId } = await createHostedWorkspaceWithOwner(email, passwordHash, workspaceName);
    const session = await createSession(userId);
    await setSessionCookie(session);
    redirect("/meetings");
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") redirect("/login?error=signup");
    throw error;
  }
}

/** End the browser session early on a shared or public machine. Deletes
 * the Session row itself, not just the cookie, so a stolen cookie value
 * stops working the moment the real user logs out. */
export async function logout(): Promise<void> {
  const store = await cookies();
  const sessionId = store.get("session")?.value;
  if (sessionId) await deleteSession(sessionId);
  store.delete("session");
  redirect("/login");
}
