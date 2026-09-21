import Link from "next/link";

/**
 * Without this, a stale link (or navigating right after deleting a
 * meeting) drops the user onto Next's default unstyled "This page could
 * not be found" screen — no dark mode, no app chrome, no way back except
 * the browser's back button. Jarring on a tool whose whole job is being a
 * trustworthy archive (design review finding, see TODO.md).
 */
export default function NotFound() {
  return (
    <div className="container">
      <div className="empty-state">
        <p>This meeting doesn&apos;t exist — it may have been deleted.</p>
        <Link href="/meetings" className="back-link">
          ← Back to your meetings
        </Link>
      </div>
    </div>
  );
}
