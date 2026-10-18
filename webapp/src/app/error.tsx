"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import * as Sentry from "@sentry/nextjs";
import { useEffect, useRef } from "react";
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
  // The root layout already provides <main>; move focus to the heading so
  // keyboard and screen-reader users land on what happened (no role="alert",
  // which would announce the whole region a second time).
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const copy = errorCopyForPath(pathname);
  return (
    <div className="container error-state">
      <h1 ref={heading} tabIndex={-1}>{copy.title}</h1>
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
    </div>
  );
}