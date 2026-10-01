# Sending notes elsewhere

Owners connect destinations in **Settings → Integrations → Send notes elsewhere**.
When a note is ready (hosted processing finished, an import finished, or a finished
note synced from the extension/helper) each enabled destination receives it once.
Failed deliveries retry after 1 min, 5 min, 30 min, 2 h and 6 h (6 attempts), then
stop and show the error in Settings. Up to 10 destinations per workspace. Secrets are
stored encrypted (AES-256-GCM) and shown only once; deliveries keep ids and status,
not note text, and are pruned after 14 days.

## Webhook (and Zapier, Make, n8n)

Use **Webhooks by Zapier → Catch Hook** (or the equivalent) and paste its URL.
Requests are `POST` with JSON:

```json
{
  "id": "<delivery id>", "event": "note.ready", "createdAt": "2026-09-30T16:01:00.000Z",
  "note": {
    "id": "…", "title": "Acme renewal", "startedAt": "…", "endedAt": "…", "template": "sales",
    "folder": "Clients / Acme", "url": "https://notes.example.com/meetings/…",
    "summaryMarkdown": "…", "actionItems": [{ "text": "…", "owner": "Sam", "dueAt": null, "status": "open" }]
  }
}
```

`transcript` (speaker names applied) is added only if you tick "Include the full
transcript". `event` is `test` for the Send test button. Headers:
`X-Notetaker-Event`, `X-Notetaker-Delivery` (the `id`), `X-Notetaker-Timestamp`
(Unix seconds) and `X-Notetaker-Signature: v1=<hex>`, where the hex is
HMAC-SHA256 of `"<timestamp>.<raw body>"` keyed with your `whsec_…` secret.
Reject requests whose timestamp is more than 5 minutes old and compare in constant time:

```js
import { createHmac, timingSafeEqual } from "node:crypto";
function verify(secret, headers, rawBody) {
  const ts = headers["x-notetaker-timestamp"];
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const expected = Buffer.from("v1=" + createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex"));
  const given = Buffer.from(headers["x-notetaker-signature"] ?? "");
  return expected.length === given.length && timingSafeEqual(expected, given);
}
```

Reply with any 2xx to acknowledge; redirects are not followed. Destinations must be
public https URLs. Addresses on private networks, loopback and cloud metadata are
refused, including when a public name resolves to one. A self-hosted operator who
deliberately targets their own network sets `INTEGRATIONS_ALLOW_PRIVATE_NETWORKS=true`
(this also permits plain http).

## Slack

Create an incoming webhook for a channel in Slack and paste its
`https://hooks.slack.com/services/…` URL. Each note posts its title (linked when
`APP_URL` is set), the start of the summary and up to five open action items.

## Notion

Create an internal integration in Notion, share a page with it, then paste the
integration token and the page link. Each note becomes a sub-page with the
summary and action items as to-dos.

## Configuration

`INTEGRATIONS_ENCRYPTION_KEY` (32 random bytes, base64) encrypts stored secrets.
When unset it is derived from `AUTH_TOKEN`, so no setup is needed; rotating
`AUTH_TOKEN` without setting the dedicated key makes saved destinations unreadable
and they must be re-created. `APP_URL` makes links in payloads absolute.
