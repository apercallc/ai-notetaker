"use client";

// This screen replaces the root layout entirely (it defines its own
// <html>/<body>) when the layout itself throws, so it doesn't inherit
// layout.tsx's globals.css import — without this it would render in
// unstyled default browser chrome at the worst possible moment.
import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import "./globals.css";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
      try {
        Sentry.captureException(error, { tags: { boundary: "global-error" } });
      } catch {
        // reporting must never worsen the error state
      }
    }
  }, [error]);
  return (
    <html lang="en">
      <body>
        <main className="container error-state" role="alert">
          <h1>AI Notetaker needs to restart this view</h1>
          <p className="muted-copy">Nothing was deleted. Reload the app or try again.</p>
          {error.digest && (
            <p className="muted-copy">
              Reference: <code>{error.digest}</code>
            </p>
          )}
          <button type="button" className="button button-primary" onClick={() => reset()}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}