import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import "./globals.css";
import { AppHeader } from "@/components/AppHeader";
import { getAppUrl } from "@/lib/deploymentConfig";
import { managedHostingEnabled } from "@/lib/managedAuth";
import { SESSION_COOKIE } from "@/lib/sessionCookie";
import { getSessionContextForRequest, resolveWorkspaceForRequest } from "@/lib/currentUser";
import { MARKETING_HEADER } from "@/marketing/paths";

/** Absolute URLs in canonical/OG metadata need the public origin; only the managed site publishes any. */
function metadataBase(): URL | undefined {
  if (!managedHostingEnabled()) return undefined;
  try {
    return new URL(getAppUrl());
  } catch {
    return undefined;
  }
}

export const metadata: Metadata = {
  metadataBase: metadataBase(),
  title: { default: "AI Notetaker", template: "%s · AI Notetaker" },
  description: "Private meeting notes, transcripts and action items from AI Notetaker.",
  icons: { icon: "/ai-notetaker-mark.svg" },
};

/**
 * Who is looking, for the header only. Pages still authorize themselves with
 * requireSession(); a failure here must never take the page down, so it just
 * means no header.
 */
async function headerRole(): Promise<"owner" | "member" | null> {
  try {
    const store = await cookies();
    const session = await getSessionContextForRequest(store.get(SESSION_COOKIE)?.value);
    if (!session || session.user.mustChangePassword) return null;
    const active = await resolveWorkspaceForRequest(session.user.id, session.activeWorkspaceId);
    return active?.role ?? null;
  } catch (error) {
    console.error("header session lookup failed", error instanceof Error ? error.message : String(error));
    return null;
  }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Set only by the proxy, for the public marketing routes. Those pages bring
  // their own header, <main> and footer, so the app chrome steps aside.
  const marketing = (await headers()).get(MARKETING_HEADER) === "1";
  if (marketing) {
    return (
      <html lang="en">
        <body>{children}</body>
      </html>
    );
  }
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
