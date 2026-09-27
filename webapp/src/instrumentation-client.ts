"use client";

import * as Sentry from "@sentry/nextjs";

// Client SDK init. Gated on the build-time DSN: self-hosted builds set no
// NEXT_PUBLIC_SENTRY_DSN, so this file compiles to a no-op and the browser
// never loads or contacts Sentry. No session replay, no request bodies.
if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || "managed",
    sampleRate: 1,
  });
}
