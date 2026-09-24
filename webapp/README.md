# AI Notetaker — History and Managed Processing Web App

Optional companion to the AI Notetaker extension/helper. Entirely additive:
the extension works with zero setup using local BYOK storage. Deploy this for
persistent, cross-device history, or configure managed processing for signed-in
workspaces.

Most users should begin with the [main getting-started guide](../docs/getting-started.md)
and skip this component. The webapp is an optional server you deploy and own;
it is never required for recording or local meeting history.

Self-hosted deployments remain user-owned and BYOK. A managed operator can run
the same app with server-side provider credentials, private object storage,
worker credentials, and Stripe billing; the extension never receives provider
secrets.

## Deploy with the prebuilt container image

Release tags publish the history webapp image to GitHub Container Registry:

```bash
mkdir -p ai-notetaker-webapp && cd ai-notetaker-webapp
curl -fsSLo docker-compose.registry.yml https://raw.githubusercontent.com/apercallc/ai-notetaker/main/webapp/docker-compose.registry.yml
curl -fsSLo .env.docker.example https://raw.githubusercontent.com/apercallc/ai-notetaker/main/webapp/.env.docker.example
cp .env.docker.example .env
docker compose -f docker-compose.registry.yml --env-file .env pull
docker compose -f docker-compose.registry.yml --env-file .env up -d
```

Set `AI_NOTETAKER_WEBAPP_IMAGE` if you use a versioned tag or a Docker Hub
mirror, for example
`docker.io/your-namespace/ai-notetaker-webapp:0.1.0`. The image contains only
the optional authenticated history webapp; it does not capture audio or run the
desktop helper.

For managed processing with the prebuilt image, include the worker profile:

```bash
docker compose -f docker-compose.registry.yml --env-file .env --profile managed up -d
```

To update a registry deployment without rebuilding locally:

```bash
docker compose -f docker-compose.registry.yml --env-file .env pull
docker compose -f docker-compose.registry.yml --env-file .env up -d
```

Add `--profile managed` to both commands when running hosted processing.

The entrypoint applies pending Prisma migrations before the server starts.
Back up the Postgres volume before upgrades. The registry Compose file passes
the managed worker, provider, Stripe, and S3-compatible storage variables from
`.env`; leave managed variables blank for a local/BYOK-only deployment.

Managed API CORS is restricted to the fixed Chrome extension origin by
default. Set `MANAGED_EXTENSION_ORIGIN` only when using a controlled extension
fork with a different manifest key; arbitrary origins are rejected.

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

For managed processing, start the first-party worker profile as well:

```bash
docker compose --profile managed up -d --build
```

The worker polls the authenticated job endpoint and is not started for the
default local/BYOK-only profile. It shares the webapp image but does not
publish an HTTP port.

Managed API sign-in, billing, entitlement, and worker routes are also disabled
unless `MANAGED_HOSTING=true`; leaving that flag unset keeps this deployment a
self-hosted history/BYOK service even if unrelated Stripe variables exist.

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
3. Set `AUTH_TOKEN` — a long random string. Generate one with `openssl rand
   -hex 32`. This is the token for self-hosted extension sync.
4. For project-operated multi-tenant hosting, also set `MANAGED_HOSTING=true`
   and configure the managed worker/provider, private S3-compatible object
   storage, and Stripe secrets from `.env.example`; hosted visitors can then
   create isolated workspaces from `/login`. Leave it `false` for the
   one-workspace self-hosted flow. See
   [`docs/hosted-deployment.md`](../docs/hosted-deployment.md) for the
   acceptance and operations checklist.
5. Deploy. The start command (`railway.json`) runs pending database
   migrations automatically before starting the server — no manual
   migration step.
6. For managed hosting, create a second Railway service from the same
   `webapp/` source and select `railway-worker.json` as its Railway config.
   Give it the same `DATABASE_URL`, `AUTH_TOKEN`, and `MANAGED_WORKER_TOKEN`,
   plus `MANAGED_WORKER_WEBAPP_URL` pointing at the webapp service. Its start
   command is `npm run managed:worker`; without this worker, hosted jobs stay
   queued.
7. Open the deployed URL and use `/login` for the web history UI. Workspace
   owners can manage hosted payment from `/billing` when Stripe is configured.

For self-hosted history, that's the whole setup — one token and the linked
Postgres addon. Managed hosting additionally requires the worker service,
provider/object-storage secrets, and Stripe configuration described above.

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
  `/share/*` links are bearer capabilities — see `docs/webapp-api.md`.
- Two auth mechanisms for two kinds of client: a `Bearer` token for the
  JSON API (`/api/*`, used by the extension and future mobile clients, per
  `docs/webapp-api.md`), and a session cookie for the browser UI (set once
  via `/login`, so a human isn't retyping the token on every page).
- Managed hosting uses real per-user sessions and workspace-scoped reads and
  writes; each hosted signup receives an isolated owner workspace. Self-hosted
  deployments retain the legacy single default workspace and `AUTH_TOKEN`
  ingestion contract.
- In local/BYOK mode this app only stores and serves finished notes. In managed
  mode the worker calls the configured Deepgram/Anthropic providers using
  server-side secrets after an authenticated, checksummed upload. Provider
  requests have bounded cancellation and transient retry behavior. Managed
  uploads use the configured private S3-compatible bucket when `S3_BUCKET` is
  set; otherwise they use the local filesystem backend for single-node
  self-hosted/Docker deployments.
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
- A real S3-compatible bucket has not been exercised in this workspace; set
  `S3_BUCKET`, `S3_REGION`, optional `S3_ENDPOINT`, and the server-side
  credentials before using a multi-instance managed deployment.
