"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import { errorCopyForPath } from "@/lib/errorCopy";

/**
 * Route-scoped error boundary. The copy matches what actually broke —
 * reading notes is safe to reassure, a billing page is not — and the
 * digest is shown so a user reporting the problem can quote something
 * that maps to a line in our logs.
 *
 * The useEffect reports through the DSN-gated client SDK: a self-hosted
 * build has no NEXT_PUBLIC_SENTRY_DSN, so nothing is sent.
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const pathname = usePathname();
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
      try {
        Sentry.captureException(error, { tags: { path: pathname } });
      } catch {
        // reporting must never worsen the error state
      }
    }
  }, [error, pathname]);
  const copy = errorCopyForPath(pathname);
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