# webapp/ — Optional Self-Hosted History App

Next.js + Postgres, deployed by each user to their own Railway account via
a one-click template. This package is **never operated by the project
itself** — see `docs/superpowers/specs/2026-09-21-notetaker-architecture-design.md`
(§3.5) for why: a centrally-hosted instance would reintroduce the hosting
cost and data-liability problem the whole BYOK/no-subscription design
exists to avoid.

## Conventions

- **Multi-user auth exists now** (real per-user login, scrypt-hashed
  passwords, DB-backed sessions, an owner/member `WorkspaceMembership`
  model) — see
  `docs/superpowers/specs/2026-09-22-webapp-multi-user-auth-design.md`.
  One deployment supports exactly one workspace/team; there is no
  multi-workspace or invite-by-email flow, by design (YAGNI until asked).
  The `/api/*` ingestion contract (desktop helper sync) is completely
  separate and still uses the single deploy-time `AUTH_TOKEN` — never
  conflate the two auth mechanisms.
- **The Railway "Deploy" template must stay one-click.** Any new required
  environment variable or manual setup step is a regression against the
  "simple, straightforward install" pillar — document it clearly in
  `docs/` if it's unavoidable, but prefer sane defaults over new required
  config.
- **This app never calls transcription/LLM provider APIs.** It only stores
  and serves finished notes that the extension/helper already produced —
  keeping it a thin storage+display layer means it never needs the user's
  AI provider keys, which reduces its blast radius if the deployment is
  ever compromised.
- **The deploy-time `AUTH_TOKEN` and per-user passwords, not the user's AI
  API keys, are what secure this app.** Never design a flow where a
  Deepgram/Claude/etc. key would need to reach the webapp.
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
