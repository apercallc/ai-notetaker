import Link from "next/link";
import { requireSession } from "@/lib/currentUser";
import { prisma } from "@/lib/db";
import { managedHostingEnabled } from "@/lib/managedAuth";
import { hasSyncAccess } from "@/lib/syncAccess";
import { ConnectDesktopForm } from "./ConnectDesktopForm";

export const metadata = { title: "Connect the desktop app", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function ConnectDesktopPage() {
  const session = await requireSession();
  const managed = managedHostingEnabled();
  const [workspace, subscription] = managed
    ? await Promise.all([
        prisma.workspace.findUnique({ where: { id: session.workspaceId }, select: { name: true } }),
        prisma.workspaceSubscription.findUnique({ where: { workspaceId: session.workspaceId }, select: { plan: true, status: true, graceEndsAt: true } }),
      ])
    : [null, null];
  const canSync = hasSyncAccess(subscription);
  return (
    <div className="container">
      <Link href="/account" className="back-link">← Settings</Link>
      <div className="page-header"><h1>Connect the desktop app</h1></div>
      <p className="muted-copy">
        You are signed in as <strong>{session.email}</strong>. Create a code here and paste it into AI Notetaker on your computer
        (Settings → Account & sync → Signed up with Google, or prefer your browser?). It signs the desktop app in to this same account and workspace, whether you
        sign in here with a password or with Google, and, with a Pro or Team plan, turns on sync between this web app and your other devices.
      </p>
      {managed && workspace && (
        <p className={canSync ? "muted-copy" : "error-text"} role="status">
          The app will connect to the workspace <strong>{workspace.name}</strong>.{" "}
          {canSync ? "Sync is active for this workspace." : <>Sync is off for this workspace until it has a Pro or Team plan. <Link href="/billing">See plans</Link>.</>}
        </p>
      )}
      {managed ? <ConnectDesktopForm /> : <p className="muted-copy">Sign-in from the desktop app is not available on this deployment.</p>}
    </div>
  );
}
