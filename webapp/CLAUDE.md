# webapp/ — Hosted and Self-Hosted History Service

Next.js + Postgres. It supports both the managed multi-tenant service and a
user-operated one-click self-hosted deployment. Managed hosting adds
authenticated uploads, private object storage, processing jobs, usage, and
billing; self-hosted deployments retain local/BYOK operation. See
`docs/superpowers/specs/2026-09-24-scribbl-dual-mode-product-design.md`.

## Conventions

- **Multi-user auth exists now** (real per-user login, scrypt-hashed
  passwords, DB-backed sessions, an owner/member `WorkspaceMembership`
  model) — see
  `docs/superpowers/specs/2026-09-22-webapp-multi-user-auth-design.md`.
  Self-hosted deployments may remain single-workspace; managed hosting must
  enforce tenant/workspace isolation for every browser, upload, job, object,
  search, sharing, and billing operation.
  The `/api/*` ingestion contract (desktop helper sync) is completely
  separate and still uses the single deploy-time `AUTH_TOKEN` — never
  conflate the two auth mechanisms.
- **The self-hosted Railway "Deploy" template must stay one-click.** Any new required
  environment variable or manual setup step is a regression against the
  "simple, straightforward install" pillar — document it clearly in
  `docs/` if it's unavoidable, but prefer sane defaults over new required
  config.
- **Provider execution is mode-dependent.** Self-hosted/BYOK deployments may
  remain storage/display only. Managed deployments use server-side provider
  adapters and workers with platform-owned credentials; provider keys never
  reach browser bundles or meeting records.
- **Sessions, workspace authorization, signed upload/object access, and
  server-side provider secrets secure managed hosting.** The deploy-time
  `AUTH_TOKEN` continues to secure self-hosted ingestion. Never design a flow
  where a provider key reaches the browser or a meeting record.
- **Every route requires authentication, including reads.** There is no
  "public by default" page or API route — a self-hosted instance sits on a
  public Railway URL, and an unauthenticated read path would expose a
  user's meeting notes to anyone who finds that URL. Enforced in one place
  (`src/proxy.ts`), not re-implemented per route.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
