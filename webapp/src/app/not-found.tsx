import Link from "next/link";

/**
 * The root-level fallback for URLs that match no route. It used to assume
 * every 404 was a deleted meeting; with Team, Plans & usage and Account
 * routes the app is no longer meetings-only, so the copy stays neutral
 * while still pointing at the page the user almost certainly wanted.
 */
export default function NotFound() {
  return (
    <div className="container">
      <div className="empty-state">
        <h1>Page not found</h1>
        <p className="muted-copy">This page doesn&apos;t exist — it may have moved, or a meeting it pointed to was deleted.</p>
        <Link href="/meetings" className="back-link">
          ← Back to your meetings
        </Link>
      </div>
    </div>
  );
}