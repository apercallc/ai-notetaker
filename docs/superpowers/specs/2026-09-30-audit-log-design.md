# Activity log for Team (2026-09-30)

Status: implemented (foundation in `lib/audit.ts`, viewer in `lib/auditLog.ts`).

- **Who:** workspace owners, at **Team → Activity log** (`/team/audit`). On the hosted service it
  is a Hosted Team feature (other plans see an upgrade card); self-hosted instances always have it.
- **What is recorded:** member adds/invites/removals/role changes/resets, retention changes,
  notes created/edited/imported/moved/trashed/restored/deleted/regenerated, folders, Trash
  emptying and automatic purges, share links, integrations (including secret rotation and
  tests) and API tokens. Every action has a label and a category; a test fails if one is added
  without them. Events hold ids and small facts only; credential- and content-like keys are
  always dropped, so the log never contains note text or secrets.
- **Viewer:** newest first, 50 per page (keyset paging, stable with identical timestamps),
  filter by category and by member or "System", note titles linked while the note still exists.
  A former member shows as "Former member", so their address stops appearing once they leave.
- **CSV:** `GET /team/audit/export` (owner only, same filters, up to 10,000 rows, cells that
  start with `= + - @` are defused against spreadsheet formulas).
- **Retention:** 400 days, purged by the worker heartbeat; events go with the workspace.

## Not built
- Search within the log, date-range filters, streaming to a SIEM, tamper-evident chaining,
  per-note access ("who viewed this note") and sign-in events.
