import type { Metadata } from "next";
import { cookies } from "next/headers";
import "./globals.css";
import { AppHeader } from "@/components/AppHeader";
import { managedHostingEnabled } from "@/lib/managedAuth";
import { SESSION_COOKIE } from "@/lib/sessionCookie";
import { getSessionUser } from "@/lib/sessions";
import { getUserDefaultWorkspaceId, getUserRole } from "@/lib/workspaces";

export const metadata: Metadata = {
  title: { default: "AI Notetaker", template: "%s · AI Notetaker" },
  description: "Private meeting notes, transcripts and action items from AI Notetaker.",
};

/**
 * Who is looking, for the header only. Pages still authorize themselves with
 * requireSession(); a failure here must never take the page down, so it just
 * means no header.
 */
async function headerRole(): Promise<"owner" | "member" | null> {
  try {
    const store = await cookies();
    const user = await getSessionUser(store.get(SESSION_COOKIE)?.value);
    if (!user) return null;
    const workspaceId = await getUserDefaultWorkspaceId(user.id);
    return workspaceId ? await getUserRole(user.id, workspaceId) : null;
  } catch (error) {
    console.error("header session lookup failed", error instanceof Error ? error.message : String(error));
    return null;
  }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const role = await headerRole();
  return (
    <html lang="en">
      <body>
        <a href="#main" className="skip-link">Skip to content</a>
        {role && <AppHeader role={role} managed={managedHostingEnabled()} />}
        <main id="main" tabIndex={-1}>{children}</main>
      </body>
    </html>
  );
}
