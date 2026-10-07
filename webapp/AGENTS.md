# webapp/ — Codex guidance

Read [`../CLAUDE.md`](../CLAUDE.md) and [`../AGENTS.md`](../AGENTS.md) before
changing the account, sync and team web app.

The desktop app may sync finalized notes to the authenticated API. Preserve
that optional, token-scoped client contract; local recording and provider
processing must not depend on webapp availability or login.

This app is the project-operated account, sync and team service. Users do not
self-host a backend. Managed workers use server-side provider secrets and
must never expose them to browser bundles or meeting records. Keep ownership
fields and workspace isolation in the schema, and enforce authentication on every route,
including reads; only the health check is public. Read the relevant Next.js
guide under `node_modules/next/dist/docs/` before changing Next APIs.
