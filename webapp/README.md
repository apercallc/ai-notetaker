# AI Notetaker — Self-Hosted History Web App

Optional companion to the AI Notetaker extension/helper. Entirely additive
— the extension works with zero setup using local storage. Deploy this only
if you want persistent, cross-device access to your past meetings.

Most users should begin with the [main getting-started guide](../docs/getting-started.md)
and skip this component. The webapp is an optional server you deploy and own;
it is never required for recording or local meeting history.

You deploy and own this instance yourself. Nothing here is run by the
AI Notetaker project — your meeting notes never touch a server anyone else
controls.

## Deploy with Docker Compose

Docker is an optional deployment path for this history webapp only. It does
not capture microphone/system audio, run the desktop helper, install Chrome,
or receive AI provider keys.

```bash
cp .env.docker.example .env
# Replace both values with URL-safe random values, for example:
#   openssl rand -hex 32
docker compose up -d --build
```

The default bind is `127.0.0.1:3000`; open `http://127.0.0.1:3000/login`
and enter the `AUTH_TOKEN`. Prisma migrations run in the webapp container
before Next.js starts, and Postgres data persists in the
`ai-notetaker-postgres` named volume. Back up that volume and put HTTPS and
network controls in front of the service before exposing it remotely.

To stop the containers without deleting notes:

```bash
docker compose down
```

Do not use `docker compose down -v` unless you intentionally want to delete
the Postgres volume and all stored meeting history.

## Deploy on Railway (recommended)

1. If a published Railway template link is available, open it. Otherwise,
   create a new Railway project, add this repo's `webapp/` directory as a
   service, and add a Postgres database to the same project.
2. Railway links `DATABASE_URL` from its Postgres addon automatically.
3. Set one environment variable yourself: `AUTH_TOKEN` — a long random
   string. Generate one with `openssl rand -hex 32`. This is the token
   you'll paste into the extension's settings and use to log into the
   webapp's UI.
4. Deploy. The start command (`railway.json`) runs pending database
   migrations automatically before starting the server — no manual
   migration step.
5. Open the deployed URL, go to `/login`, and enter your `AUTH_TOKEN`.

That's the whole setup — one token, no other required configuration.

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

- **Every route requires `AUTH_TOKEN`, including reads** — enforced once,
  in `src/proxy.ts` (Next.js 16's replacement for `middleware.ts`), not
  re-implemented per route. The one exception is `GET /api/health`, which
  exists only so the extension's settings page can confirm "is this URL
  even a webapp instance" before asking for a token — see
  `docs/webapp-api.md`.
- Two auth mechanisms for two kinds of client: a `Bearer` token for the
  JSON API (`/api/*`, used by the extension and future mobile clients, per
  `docs/webapp-api.md`), and a session cookie for the browser UI (set once
  via `/login`, so a human isn't retyping the token on every page).
- The Prisma schema carries `userId`/`workspaceId` on every table from day
  one even though v1 has no real multi-user concept — see the architecture
  spec §3.5, §7. All v1 reads/writes use the constant `LOCAL_USER_ID`
  (`src/lib/auth.ts`).
- This app never calls transcription/LLM provider APIs and never needs the
  user's Deepgram/Claude/etc. keys — it only stores and serves finished
  notes the extension/helper already produced.
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
