# Webapp Multi-User Auth & Workspace Sharing Design

Date: 2026-09-22
Status: Approved, implementation in progress

## Problem

TODO.md sub-project 5 lists: "Multi-user auth for the webapp (team/workspace
sharing) — schema already supports this per sub-project 1; build the auth +
sharing UI." Today the webapp has exactly one tenant: every row is written
and read under a hardcoded `LOCAL_USER_ID = "local"` constant
(`src/lib/meetings.ts`), and the browser UI's "session" is just the raw
deploy-time `AUTH_TOKEN` sitting in a cookie (`src/lib/auth.ts`,
`src/proxy.ts`). There is no concept of more than one person using an
instance.

## Goals

- Real per-person login (email + password) for the browser UI, so a team
  can share one self-hosted instance without sharing one secret.
- Workspace-scoped data: everyone in a workspace sees the same shared
  meetings; the schema's existing `workspaceId` column (present since
  sub-project 1, per `prisma/schema.prisma`'s own comment) becomes the
  real access-control boundary instead of a forward-compatible no-op.
- Preserve the one-click Railway deploy: no new required environment
  variable, no SMTP/email dependency.
- Zero change to the `/api/*` ingestion contract
  (`docs/webapp-api.md`, the desktop helper's sync) — the Bearer
  `AUTH_TOKEN` keeps working exactly as documented.

## Non-goals

- Granular permissions/roles beyond `owner` and `member`. Two tiers is
  enough for "the person who deployed it" vs. "everyone they added" —
  YAGNI beyond that until a real ask for finer control shows up.
- Email-based invites or password reset. No outbound email
  infrastructure exists or should be added (would violate "keep the
  one-click template simple" from `webapp/CLAUDE.md`) — an owner creates
  a teammate's account directly and hands them the one-time password
  out of band (Slack, in person, whatever they already use).
- OAuth / third-party identity providers. Adds an external dependency and
  a new outbound network requirement to a project whose whole premise is
  self-hosted and BYOK; a hashed local password is enough for "a handful
  of teammates share one instance."
- Multiple workspaces per deployment. One self-hosted instance = one
  team = one workspace. A user with access to more than one *deployment*
  just logs into each separately, same as today.

## Architecture

### Two separate identities, deliberately not unified

The single `AUTH_TOKEN` Bearer contract (helper → webapp meeting sync)
and the new per-user login (person → webapp browser UI) solve different
problems and stay separate:

- **Ingestion (`/api/*`, Bearer `AUTH_TOKEN`):** unchanged. One
  deployment still has one token. A meeting synced this way is assigned
  to the deployment's single default workspace (below) — there is no
  concept of "which teammate recorded this" at the protocol level today,
  and inventing one is out of scope (the helper has no login of its own,
  by design — see the root `CLAUDE.md`'s "no accounts, no login" rule for
  the *extension*; that rule doesn't extend to the webapp, which
  `webapp/CLAUDE.md` already flagged as future multi-user scope).
- **Browsing (`/login`, everything else, session cookie):** becomes real
  per-user auth. Everyone who logs in and belongs to the workspace sees
  the same shared meetings ingested by the one deployment token.

### Data model additions

```prisma
model User {
  id           String   @id @default(uuid())
  email        String   @unique
  passwordHash String
  createdAt    DateTime @default(now())

  memberships WorkspaceMembership[]
  sessions    Session[]
}

model Workspace {
  id        String   @id @default(uuid())
  name      String
  isDefault Boolean  @default(false)
  createdAt DateTime @default(now())

  memberships WorkspaceMembership[]

  // Exactly one workspace has isDefault = true — the ingestion target for
  // every meeting synced via the AUTH_TOKEN Bearer contract, and the
  // workspace the first bootstrapped user automatically owns.
  @@index([isDefault])
}

model WorkspaceMembership {
  id          String   @id @default(uuid())
  userId      String
  workspaceId String
  role        String   // "owner" | "member"
  createdAt   DateTime @default(now())

  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  @@unique([userId, workspaceId])
  @@index([workspaceId])
}

model Session {
  id        String   @id @default(uuid())
  userId    String
  expiresAt DateTime
  createdAt DateTime @default(now())

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@index([expiresAt])
}
```

`Meeting.workspaceId` (already present, nullable) becomes the real
scoping key for every browser-facing read. `Meeting.userId`,
`TranscriptSegment.userId`, and `ActionItem.userId` keep their existing
`"local"` sentinel value for old rows and are **not** repurposed for
access control — `workspaceId` is the only access-control boundary this
design adds. Changing that would be a second, unrelated migration.

### Migration for existing deployments

A running self-hosted instance must not break on upgrade:

1. Create the four new tables.
2. Insert exactly one `Workspace` row with `isDefault = true` (name:
   `"My Workspace"` — a self-hosted single-team default, renamable
   later since `Workspace.name` is just a display field with no other
   code depending on its value).
3. Backfill: `UPDATE "Meeting" SET "workspaceId" = '<default-id>' WHERE "workspaceId" IS NULL`.
4. Do **not** create a `User` row — there's no real email/password to
   invent. The bootstrap flow (below) creates the first real one.

### Bootstrap flow (preserves one-click deploy)

`/login` checks whether any `User` row exists:

- **Zero users:** render "Create the first account" (setup code + email +
  password + confirm). The setup code must match the deploy-time
  `AUTH_TOKEN` (checked via `isValidSetupToken`, the same fail-closed,
  constant-time comparison `isAuthorizedBearer` already uses) — without
  this, the first anonymous visitor to a public Railway URL, not
  necessarily its owner, could claim the account with an arbitrary
  email/password and zero secret knowledge (an earlier draft of this
  design missed this and was caught by
  `notetaker-guardrails-reviewer`). Submitting creates the `User`, hashes
  the password (`node:crypto`'s `scrypt`, no new dependency — matches
  this file's existing hand-rolled `timingSafeEqual` convention rather
  than adding `bcrypt`/`argon2`), gives them an `owner`
  `WorkspaceMembership` in the default workspace, creates a `Session`,
  and logs them in immediately.
- **One or more users exist:** render the normal email + password sign-in
  form.

No new required environment variable — `AUTH_TOKEN` already exists and is
already required; it now doubles as the one-time setup code. The trust
model is genuinely equivalent to today's flow: claiming the instance
requires knowing the same deploy-time secret either way, not just being
first to load the URL.

### Session mechanics

The cookie's value becomes an opaque `Session.id` (a UUID), not a secret
value compared directly — looked up in the database on every
non-`/api/*` request in `src/proxy.ts`. This is a deliberate, acknowledged
change from today's zero-database-call `isAuthorizedSession`: **you
cannot validate a revocable, per-user session without state**, and a
database is the state this project already has. `Session` rows expire
after 30 days (matching today's cookie `maxAge`) and are deleted outright
on logout (not just the cookie) so a stolen cookie value stops working
the moment the real user logs out — today's design can't do that (the raw
token *is* the secret, logout only clears one browser's copy of it).

### Team management

A new owner-only `/team` page:

- Lists current members (email, role, joined date).
- **Add member:** owner enters an email; the page generates a random
  one-time password, creates the `User` + `member` `WorkspaceMembership`,
  and displays the password once (never stored in plaintext, never
  emailed — the owner copies it to the new teammate through whatever
  channel they already use).
- Only an `owner` can reach this page or its server actions — enforced in
  the page/action itself (`proxy.ts` only knows "logged in or not", not
  roles; role checks belong to the specific server action that needs
  them, same pattern Next.js Server Actions already use elsewhere in this
  app for input validation).

### Data-layer changes (`src/lib/meetings.ts`)

Every browser-facing read (`listMeetings`, `getMeeting`, `deleteMeeting`,
`listActionItems`, `updateActionItem`) changes its Prisma `where` clause
from `userId: LOCAL_USER_ID` to `workspaceId: <the caller's workspace id>`,
threaded in from the authenticated session (resolved once per request,
not re-queried per function call). `upsertMeeting` (the `/api/meetings`
ingestion path, still Bearer-authenticated, no session) keeps writing
`userId: LOCAL_USER_ID` for the existing audit-trail field and additionally
sets `workspaceId` to the default workspace's id.

## Testing

Real Postgres via the existing `npm run test:with-postgres` runner
(Docker confirmed available in this environment) — no new test
infrastructure needed, following the project's own documented pattern
(`docs/testing.md`) rather than mocking Prisma.

- Migration: applying it against a fresh database creates the default
  workspace; applying it against a database with pre-existing `Meeting`
  rows backfills their `workspaceId`.
- Auth: scrypt hash/verify round-trip, bootstrap-vs-sign-in branching on
  `/login`, wrong-password rejection, session creation/expiry/deletion,
  logout actually deleting the `Session` row (not just the cookie).
- Authorization: a user in workspace A cannot read/delete a meeting in
  workspace B (`getMeeting`/`deleteMeeting` scoped queries return
  nothing rather than leaking).
- Team management: only an `owner` role can reach `/team`'s add-member
  action; a `member` role is rejected.
- `proxy.ts`: unauthenticated request to a protected page redirects to
  `/login`; a valid session cookie passes through; `/api/*` Bearer auth
  is completely unchanged (existing tests for it must still pass
  untouched).

## Rollout

No feature flag — this replaces the single-shared-token browser session
model outright. Existing deployments: the *first* person to load the
webapp after upgrading sees the bootstrap "create the first account"
screen (since no `User` rows exist yet) and becomes that workspace's
owner; their existing meetings are already there, backfilled to the
default workspace by the migration. The `AUTH_TOKEN` env var and the
`/api/*` ingestion contract are completely unaffected, so the desktop
helper needs no changes and keeps syncing meetings exactly as before.
