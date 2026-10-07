import Link from "next/link";
import { requireSession } from "@/lib/currentUser";
import { managedHostingEnabled } from "@/lib/managedAuth";
import { ConnectDesktopForm } from "./ConnectDesktopForm";

export const metadata = { title: "Connect the desktop app", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function ConnectDesktopPage() {
  const session = await requireSession();
  return (
    <div className="container">
      <Link href="/account" className="back-link">← Settings</Link>
      <div className="page-header"><h1>Connect the desktop app</h1></div>
      <p className="muted-copy">
        You are signed in as <strong>{session.email}</strong>. Create a code here and paste it into AI Notetaker on your computer
        (Settings → Processing → Sign in with your browser). It signs the desktop app in to this same account and workspace, whether you
        sign in here with a password or with Google, and turns on sync between this web app and your other devices.
      </p>
      {managedHostingEnabled() ? <ConnectDesktopForm /> : <p className="muted-copy">This deployment is self-hosted. Use a desktop sync token from Settings → Integrations instead.</p>}
    </div>
  );
}
