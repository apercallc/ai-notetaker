# webapp/ — Codex guidance

Read [`../CLAUDE.md`](../CLAUDE.md) and [`../AGENTS.md`](../AGENTS.md) before
changing the optional self-hosted history app.

This app supports both a user-operated self-hosted history deployment and the
project-operated managed AI service. Self-hosted BYOK deployments may remain
storage/display-only; managed workers use server-side provider secrets and
must never expose them to browser bundles or meeting records. Keep ownership
fields and workspace isolation in the schema, keep the one-click self-hosted
deployment path practical, and enforce authentication on every route,
including reads; only the health check is public. Read the relevant Next.js
guide under `node_modules/next/dist/docs/` before changing Next APIs.
