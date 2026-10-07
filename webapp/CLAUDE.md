# webapp/ — Account, Sync and Team Service

Next.js + Postgres. It is the project-operated multi-tenant service; users do not self-host a
backend. It provides accounts, cloud note sync and team workspaces (sync and
team are the paid subscription), plus authenticated uploads, private object
storage, usage, and billing. See
`docs/superpowers/specs/2026-09-24-dual-mode-product-design.md`.
The desktop client migration is defined in
`docs/superpowers/specs/2026-10-03-desktop-first-product-design.md`; the
webapp is an optional authenticated notes destination for local-BYOK users,
not a required login or processing dependency.

## Conventions

- **Multi-user auth exists now** (real per-user login, scrypt-hashed
  passwords, DB-backed sessions, an owner/member `WorkspaceMembership`
  model) — see
  `docs/superpowers/specs/2026-09-22-webapp-multi-user-auth-design.md`.
  Managed hosting must
  enforce tenant/workspace isolation for every browser, upload, job, object,
  search, sharing, and billing operation.
  Desktop sync uses `/api/v1/desktop-sync/*` and a revocable
  `desktop_notes_sync` API token bound to one workspace. The legacy
  `/api/meetings` contract (installed extensions only) still uses the deploy-time `AUTH_TOKEN`.
  Never conflate these auth mechanisms.
- **BYOK provider calls happen on the desktop.** The web app stores and syncs
  notes. Server-side provider adapters and workers (platform-owned
  credentials) are not the product's paid offer; provider keys never reach
  browser bundles or meeting records.
- **Sessions, workspace authorization, signed upload/object access, and
  server-side provider secrets secure managed hosting.** User API tokens are
  hashed, scoped, revocable, and workspace-bound for desktop sync. The
  deploy-time `AUTH_TOKEN` continues to secure legacy extension ingestion.
  Never design a flow where a provider key reaches the browser or a meeting
  record.
- **Every route requires authentication, including reads.** There is no
  "public by default" page or API route — the service sits on a
  public URL, and an unauthenticated read path would expose a
  user's meeting notes to anyone who finds that URL. Enforced in one place
  (`src/proxy.ts`), not re-implemented per route. **One narrow exception:** the
  project-operated managed site's static marketing pages (the exact paths in
  `src/marketing/paths.ts`) are public, but only when `MANAGED_HOSTING=true`,
  by exact-path allowlist, and they never read or render user data. See `docs/marketing-site.md`.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
