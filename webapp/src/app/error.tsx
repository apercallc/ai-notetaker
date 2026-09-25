"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { errorCopyForPath } from "@/lib/errorCopy";

/**
 * Route-scoped error boundary. The copy matches what actually broke —
 * reading notes is safe to reassure, a billing page is not — and the
 * digest is shown so a user reporting the problem can quote something
 * that maps to a line in our logs.
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const copy = errorCopyForPath(usePathname());
  return (
    <main className="container error-state" role="alert">
      <h1>{copy.title}</h1>
      <p className="muted-copy">{copy.body}</p>
      {error.digest && (
        <p className="muted-copy">
          Reference: <code>{error.digest}</code>
        </p>
      )}
      <div className="detail-actions">
        <button type="button" className="button button-primary" onClick={() => reset()}>
          Try again
        </button>
        <Link href={copy.backHref} className="button button-secondary">
          {copy.backLabel}
        </Link>
      </div>
    </main>
  );
}