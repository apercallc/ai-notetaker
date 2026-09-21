"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { isAuthorizedSession } from "@/lib/auth";
import { safeNextPath } from "@/lib/navigation";

export async function login(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  const next = String(formData.get("next") ?? "/meetings");

  // Protocol-relative URLs such as //evil.example also start with `/` but
  // would turn the post-login redirect into an open redirect.
  const safeNext = safeNextPath(next);

  if (!isAuthorizedSession(token)) {
    redirect(`/login?error=1&next=${encodeURIComponent(safeNext)}`);
  }

  const store = await cookies();
  store.set("session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days — a self-hosted single-user tool, not worth re-prompting often
  });

  redirect(safeNext);
}

/** End the browser session early on a shared or public machine. */
export async function logout(): Promise<void> {
  const store = await cookies();
  store.delete("session");
  redirect("/login");
}
