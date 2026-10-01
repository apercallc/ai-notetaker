# UX overhaul design (2026-09-30)

Four sub-projects, built in this order: (1) webapp foundation and scale,
(4) "Ask your notes" chat, (2) extension UX, (3) marketing polish. Each gets
its own plan; this document covers the shared goals and sub-project 1.

## Goals

- Fewer clicks, less confusion, one clear next action per screen.
- Works on phone, tablet and desktop browsers (≥320 px wide, no horizontal page scroll).
- Open-source assets only (Lucide icons, self-hosted fonts); no runtime CDNs.
- Scales to hundreds of notes: server-side search and pagination, never client-side filtering of everything.
- Keep every non-negotiable constraint: authenticated routes, workspace isolation, BYOK keys never sent to the service.

## Sub-project 1: webapp foundation and scale

1. **Navigation.** Signed-in header keeps brand and sign-out. Primary nav gets
   Lucide icons and becomes a fixed bottom tab bar under 760 px (thumb reach),
   a top pill row above. "Account" is renamed "Settings".
2. **Settings.** `/account` becomes four sections selected by `?tab=`:
   Profile & security (workspace, password, devices), Integrations (extension
   tokens, Google Drive), Data & privacy (export, retention copy), Danger zone
   (leave/delete). Server-rendered; side list on desktop, scrolling tab strip on
   phones. Callback params choose the tab (Google result → Integrations,
   forced password change → Profile & security). Only the active section renders.
3. **Team.** Invite form first, then members as a compact list (email, role
   badge, joined date) with row actions in a `<details>` disclosure so the page
   stays calm with many members; pending invites in their own section;
   retention in its own section. The first owner row never offers removal of
   oneself without the existing server checks (server rules unchanged).
4. **Meetings list.** Adds a date-range filter (7/30/90 days, all) preserved
   with search and paging, so 100+ notes stay navigable. Search and pagination
   already run server-side.
5. **Plans & usage** page is unchanged apart from inheriting the new shell.

## Out of scope for sub-project 1

Server action behaviour, auth, billing logic and schema are untouched. Chat,
extension and marketing are separate sub-projects.

## Testing

Pure helpers (tab resolution, range parsing) get unit tests; `listMeetings`
gets a `since` regression test; typecheck, lint and the existing suite must
stay green; responsive layouts are checked in a browser at 375, 768 and 1280 px.
