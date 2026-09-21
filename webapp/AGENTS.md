# webapp/ — Codex guidance

Read [`../CLAUDE.md`](../CLAUDE.md) and [`../AGENTS.md`](../AGENTS.md) before
changing the optional self-hosted history app.

This app is deployed by each user to their own Railway account. It never
calls AI providers and must not become a project-operated backend. Keep
ownership fields in the schema, keep the one-click deployment path practical,
and enforce the auth token on every route, including reads; only the health
check is public. Do not move AI provider keys into this app. Read the relevant
Next.js guide under `node_modules/next/dist/docs/` before changing Next APIs.
