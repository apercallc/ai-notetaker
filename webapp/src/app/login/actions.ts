"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/passwords";
import { createSession, deleteSession } from "@/lib/sessions";
import { createWorkspaceWithOwner, getDefaultWorkspaceId } from "@/lib/workspaces";
import { safeNextPath } from "@/lib/navigation";

const MIN_PASSWORD_LENGTH = 12;

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

/** Creates the first account for a freshly deployed instance — that user
 * becomes the owner of the single default workspace this project supports.
 * No new required environment variable: whoever reaches the URL first
 * controls the instance, the same trust model as today's AUTH_TOKEN flow.
 */
export async function bootstrap(formData: FormData): Promise<void> {
  if (await hasAnyUser()) redirect("/login");

  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");

  if (!email || password.length < MIN_PASSWORD_LENGTH || password !== confirmPassword) {
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

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    redirect(`/login?error=1&next=${encodeURIComponent(safeNext)}`);
  }

  const session = await createSession(user.id);
  await setSessionCookie(session);

  redirect(safeNext);
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
