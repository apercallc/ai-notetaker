# webapp/ — Optional Self-Hosted History App

Next.js + Postgres, deployed by each user to their own Railway account via
a one-click template. This package is **never operated by the project
itself** — see `docs/superpowers/specs/2026-09-21-notetaker-architecture-design.md`
(§3.5) for why: a centrally-hosted instance would reintroduce the hosting
cost and data-liability problem the whole BYOK/no-subscription design
exists to avoid.

## Conventions

- **Single-user by default, but the schema carries `user_id`/`workspace_id`
  from day one.** MVP auth is a simple token the user generates on deploy —
  don't build multi-user auth now, but don't paint the data model into a
  single-user corner either, since team/workspace sharing is documented
  future scope (spec §2, item 5).
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
- **Auth token, not the user's AI API keys, is what secures this app.**
  Never design a flow where a Deepgram/Claude/etc. key would need to reach
  the webapp.
