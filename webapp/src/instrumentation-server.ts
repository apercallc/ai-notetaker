import * as Sentry from "@sentry/nextjs";

if (process.env.SENTRY_DSN?.trim()) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN.trim(),
    // The managed service is multi-tenant: sample broadly but boundedly, and
    // never record request bodies — they carry transcripts and audio
    // metadata. The traces sampler below is deliberately conservative.
    environment: process.env.SENTRY_ENVIRONMENT?.trim() || (process.env.MANAGED_HOSTING === "true" ? "managed" : "self-hosted"),
    ...(process.env.RAILWAY_GIT_COMMIT_SHA?.trim() ? { release: process.env.RAILWAY_GIT_COMMIT_SHA.trim() } : {}),
    sampleRate: Number(process.env.SENTRY_SAMPLE_RATE) > 0 ? Math.min(Number(process.env.SENTRY_SAMPLE_RATE), 1) : 1,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE) >= 0 ? Math.min(Number(process.env.SENTRY_TRACES_SAMPLE_RATE), 1) : 0,
    // Sessions replay is intentionally absent: meeting notes and transcripts
    // render in the DOM and must never be recorded.
  });
}
