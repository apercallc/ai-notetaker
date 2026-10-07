"use server";

import { requireSession } from "@/lib/currentUser";
import { issueAuthToken } from "@/lib/authTokens";
import { managedHostingEnabled } from "@/lib/managedAuth";

export type ConnectCodeResult = { ok: true; code: string; minutes: number } | { ok: false; error: string };

/** Creates a one-time code that signs the desktop app in as the person using this page, however they signed in here. */
export async function createDesktopConnectCode(): Promise<ConnectCodeResult> {
  if (!managedHostingEnabled()) return { ok: false, error: "The desktop app connects to the hosted service." };
  const session = await requireSession();
  try {
    const { token } = await issueAuthToken({ purpose: "desktop_connect", email: session.email, userId: session.userId, workspaceId: session.workspaceId });
    return { ok: true, code: token, minutes: 10 };
  } catch (error) {
    console.error("desktop connect code failed", { error: error instanceof Error ? error.message : String(error) });
    return { ok: false, error: "Could not create a code. Try again in a moment." };
  }
}
