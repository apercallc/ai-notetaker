# AI Notetaker — Account, Sync and Team Web App

The web app behind AI Notetaker accounts. It is operated by the project; users
do not run their own copy. Recording and local notes never need it: the desktop
app works with no account and the user's own provider keys (BYOK).

- **Free account:** sign in, manage devices and your data.
- **Subscription:** cloud sync of notes and team sync (shared workspaces).

Most users should begin with the [main getting-started guide](../docs/getting-started.md).
The extension and desktop app never receive provider secrets or server-side
credentials.

## Deploy on Railway (project operator)

1. If a published Railway template link is available, open it. Otherwise,
   create a new Railway project, add this repo's `webapp/` directory as a
   service, and add a Postgres database to the same project.
2. Railway links `DATABASE_URL` from its Postgres addon automatically.
3. Set `AUTH_TOKEN` — a long random string. Generate one with `openssl rand
   -hex 32`. This is the token for the legacy extension ingestion route, kept only for
   already-installed extensions.
4. For project-operated multi-tenant hosting, also set `MANAGED_HOSTING=true`
   and configure the managed worker/provider, private R2 or S3-compatible
   temporary audio staging, and Stripe secrets from `.env.example`; hosted visitors can then
   create isolated workspaces from `/login`. Leave it `false` only for local
   development. See
   [`docs/hosted-deployment.md`](../docs/hosted-deployment.md) for the
   acceptance and operations checklist.
5. Deploy. The start command (`railway.json`) runs pending database
   migrations automatically before starting the server — no manual
   migration step. For managed Google sign-in and Drive export, set
   `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and a base64-encoded
   32-byte `GOOGLE_OAUTH_ENCRYPTION_KEY` (for example, `openssl rand -base64 32`),
   then register `https://ai-notetaker.apercallc.com/api/google/oauth/callback`
   as the Google OAuth redirect URI. These values stay server-side; they must
   never be added to the extension.
6. For managed hosting, create a second Railway service from the same
   `webapp/` source and select `railway-worker.json` as its Railway config.
   Give it the same `DATABASE_URL`, `AUTH_TOKEN`, and `MANAGED_WORKER_TOKEN`,
   plus `MANAGED_WORKER_WEBAPP_URL` pointing at the webapp service. Its start
   command is `npm run managed:worker`; without this worker, hosted jobs stay
   queued.
7. Open the deployed URL and use `/login` for the web history UI. Workspace
   owners can manage hosted payment from `/billing` when Stripe is configured.

Production additionally requires the worker service, provider/object-storage
secrets, and Stripe configuration described above.

## Local development

Requires Node.js 20.9+ and a Postgres instance.

```bash
cp .env.example .env
# edit .env: set DATABASE_URL to your local Postgres, and AUTH_TOKEN to
# any value for local testing

npm install
npm run db:migrate:dev
npm run dev
```

A throwaway local Postgres via Docker:

```bash
docker run -d --name ai-notetaker-dev-pg \
  -e POSTGRES_PASSWORD=devpass -e POSTGRES_DB=ainotetaker \
  -p 5432:5432 postgres:16-alpine
```

## Running tests

Tests are real integration tests against a live Postgres (not mocked). If
Docker is available, the repository-managed command creates and removes an
isolated throwaway database automatically:

```bash
npm run test:with-postgres
```

To use an existing database instead, set `DATABASE_URL` in `.env` and run
`npm test` directly. The Docker helper uses port `5499`; override it with
`AI_NOTETAKER_TEST_DB_PORT` if that port is occupied.

Test files run sequentially (see `vitest.config.ts`) because they share one
database and each resets its own tables in `beforeEach` — running them in
parallel would let one file's cleanup race another's assertions.

## Architecture notes

- **Every route requires authentication, including reads** — enforced once,
  in `src/proxy.ts` (Next.js 16's replacement for `middleware.ts`), not
  re-implemented per route. `/api/health` is public and reports managed
  readiness when `MANAGED_HOSTING=true`; legacy `/api/*` uses
  `AUTH_TOKEN`, managed `/api/v1/*` uses a per-user session, and expiring
  `/share/*` links are bearer capabilities — see `docs/webapp-api.md`. The
  `/internal/admin/*` namespace uses its own `AI_NOTETAKER_ADMIN_API_TOKEN`
  bearer credential in every route handler and returns only account metadata
  and signup aggregates; meeting content is never returned.
- Two auth mechanisms for two kinds of client: a `Bearer` token for the
  JSON API (`/api/*`, used by the extension and future mobile clients, per
  `docs/webapp-api.md`), and a session cookie for the browser UI (set once
  via `/login`, so a human isn't retyping the token on every page).
- Managed hosting uses real per-user sessions and workspace-scoped reads and
  writes; each hosted signup receives an isolated owner workspace. The legacy
  `AUTH_TOKEN` ingestion contract and single default workspace remain only for
  already-installed extensions.
- In local/BYOK mode this app only stores and serves finished notes. In managed
  mode the worker defaults to Groq Whisper Large V3 Turbo and OpenAI GPT-6
  Luna using server-side secrets after an authenticated, checksummed upload.
  Deepgram and Anthropic remain selectable alternatives. Groq's budget profile
  labels the remote audio as `Them` without individual diarization; Deepgram
  can retain individual remote-speaker labels. Provider requests have bounded
  cancellation and transient retry behavior. Managed audio uploads use private
  temporary R2 or S3-compatible staging and are deleted after processing or
  within 24 hours. Local development can use the filesystem
  backend.
- The authenticated `/actions` page is a cross-meeting action-item inbox. It
  supports open/completed filtering, completion toggles, and due dates, while
  keeping the meeting detail page as the source context for each item.

## What's verified vs. not (as of this build)

Verified locally against a real Postgres for the data-layer/API tests (not
just unit tests against mocks):

- All CRUD operations (`upsertMeeting`/`listMeetings`/`getMeeting`/
  `deleteMeeting`) including idempotent upsert, search, and pagination.
- The auth proxy: every `/api/*` route rejects missing/wrong tokens except
  `/api/health`; UI routes redirect to `/login` without a valid session
  cookie.
- Production build (`npm run build`) is clean with no type errors. Browser
  rendering and screenshot proof still require a real browser pass.

Not verified in this build (needs a real deploy to confirm):

- The actual "Deploy on Railway" one-click button/template — this repo
  ships `railway.json`, but clicking through a real Railway deploy with a
  fresh Postgres addon wasn't exercised here.
- Behavior under real concurrent multi-request load (all testing here was
  single-session, sequential).
- A live R2 bucket has not been exercised in this workspace; managed mode can
  use either R2 or an existing private S3-compatible bucket for temporary
  processing staging.
