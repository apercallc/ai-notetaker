"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { isAuthorizedSession } from "@/lib/auth";

export async function login(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  const next = String(formData.get("next") ?? "/meetings");

  if (!isAuthorizedSession(token)) {
    redirect(`/login?error=1&next=${encodeURIComponent(next)}`);
  }

  const store = await cookies();
  store.set("session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days — a self-hosted single-user tool, not worth re-prompting often
  });

  redirect(next.startsWith("/") ? next : "/meetings");
}

/**
 * The session cookie is 30 days (see login() above) with no in-app way to
 * end it sooner — a real gap on a self-hosted instance that "sits on a
 * public Railway URL" per webapp/CLAUDE.md, e.g. a shared or public
 * machine. Doesn't need to be prominent, just needs to exist.
 */
export async function logout(): Promise<void> {
  const store = await cookies();
  store.delete("session");
  redirect("/login");
}
