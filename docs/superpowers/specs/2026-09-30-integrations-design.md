# Export and integrations (2026-09-30)

Status: implemented in the webapp. User guide: [`docs/integrations.md`](../../integrations.md).

- **Event:** `note.ready`, announced once per note (`Meeting.readyNotifiedAt`) when hosted
  processing or an import finishes with speech, or a finished note syncs in with a summary.
  Regeneration, hand edits and hand-written notes do not re-announce.
- **Destinations (owner-managed, max 10):** signed webhook (Zapier/Make/n8n connect through
  it), Slack incoming webhook (fixed host `hooks.slack.com`), Notion sub-page under a page
  shared with the user's integration (fixed host `api.notion.com`). Markdown export already
  exists on the note page (task-list action items).
- **Secrets:** AES-256-GCM (`secretBox.ts`), key from `INTEGRATIONS_ENCRYPTION_KEY` or derived
  from `AUTH_TOKEN`; webhook signing secrets are shown once and can be rotated. Audit events
  record kind and ids only.
- **SSRF defence (`safeFetch.ts`):** https only, no credentials in URLs, private names and
  literals refused, the connected address (not just the name) must be public so DNS rebinding
  fails, no redirects, 10 s timeout, 64 KB response cap. Self-hosted operators can opt in to
  private networks with `INTEGRATIONS_ALLOW_PRIVATE_NETWORKS=true`.
- **Delivery:** `IntegrationDelivery` rows hold ids and status only; the payload is rebuilt
  from the note when sent (so deleted notes are skipped and no note text is duplicated). First
  attempt immediately, then 1 m, 5 m, 30 m, 2 h, 6 h (6 attempts). A lease on claim prevents
  double sends; the worker poll and Library page loads run retries; rows are pruned after 14
  days. Webhook payloads are signed `v1=HMAC-SHA256(timestamp.body)`.

## Not built
- OAuth app installs for Slack/Notion, per-folder routing, event types beyond `note.ready`,
  a delivery log page with filters, Slack/Notion update-in-place on edits.
