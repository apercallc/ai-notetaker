"use client";

import { useState, useTransition, type FormEvent } from "react";
import { createIntegrationAction, deleteIntegrationAction, rotateSecretAction, testIntegrationAction, toggleIntegrationAction, type IntegrationResult } from "./integrationActions";

export interface IntegrationRow {
  id: string;
  kind: "webhook" | "slack" | "notion";
  name: string;
  enabled: boolean;
  hint: string;
  status: string | null;
  error: string | null;
  lastDelivered: string | null;
}

const KIND_LABEL = { webhook: "Webhook", slack: "Slack", notion: "Notion" } as const;

export function NotesDeliveryPanel({ rows, deliveries, canManage }: { rows: IntegrationRow[]; deliveries: Array<{ id: string; name: string; event: string; status: string; attempts: number; error: string | null; when: string }>; canManage: boolean }) {
  const [kind, setKind] = useState<"webhook" | "slack" | "notion">("webhook");
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(action: (formData: FormData) => Promise<IntegrationResult>, formData: FormData, after?: () => void) {
    setMessage(null);
    startTransition(async () => {
      let result: IntegrationResult;
      try {
        result = await action(formData);
      } catch {
        result = { ok: false, error: "Something went wrong. Try again." };
      }
      if (result.ok) {
        if (result.secret) setSecret(result.secret);
        if (result.message) setMessage({ kind: "ok", text: result.message });
        after?.();
      } else {
        setMessage({ kind: "error", text: result.error });
      }
    });
  }

  const byId = (id: string, extra: Record<string, string> = {}) => {
    const formData = new FormData();
    formData.set("id", id);
    for (const [key, value] of Object.entries(extra)) formData.set(key, value);
    return formData;
  };

  function onAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    formData.set("kind", kind);
    run(createIntegrationAction, formData, () => setAdding(false));
  }

  if (!canManage) return <p className="muted-copy">Ask a workspace owner to connect Slack, Notion or a webhook.</p>;

  return (
    <div className="notes-delivery">
      <p className="muted-copy">
        When a note is ready, send it to a signed webhook (use this for Zapier, Make or n8n), a Slack channel, or a Notion page.
        Secrets are stored encrypted and shown only once.
      </p>
      {secret && (
        <div className="callout" role="status">
          <p><strong>Signing secret</strong> (shown once, copy it now):</p>
          <code className="secret-value">{secret}</code>
          <p className="muted-copy">Verify each delivery with <code>X-Notetaker-Signature</code> = HMAC-SHA256 of <code>timestamp.body</code>. See the integrations guide.</p>
          <button type="button" className="button button-secondary button-small" onClick={() => setSecret(null)}>Done</button>
        </div>
      )}
      {message && <p className={message.kind === "error" ? "error-text" : "muted-copy"} role={message.kind === "error" ? "alert" : "status"}>{message.text}</p>}

      {rows.length > 0 && (
        <ul className="integration-list">
          {rows.map((row) => (
            <li key={row.id} className="integration-row">
              <div>
                <strong>{row.name}</strong> <span className="file-type">{KIND_LABEL[row.kind]}</span>
                {!row.enabled && <span className="file-type">Off</span>}
                <div className="muted-copy">{row.hint}</div>
                <div className={row.status === "failed" ? "error-text" : "muted-copy"}>
                  {row.status === "failed" ? `Last attempt failed: ${row.error ?? "unknown error"}` : row.lastDelivered ? `Last delivered ${row.lastDelivered}` : "Nothing sent yet"}
                </div>
              </div>
              <div className="integration-actions">
                <button type="button" className="button button-secondary button-small" disabled={pending} onClick={() => run(testIntegrationAction, byId(row.id))}>Send test</button>
                <button type="button" className="button button-secondary button-small" disabled={pending} onClick={() => run(toggleIntegrationAction, byId(row.id, { enabled: row.enabled ? "0" : "1" }))}>{row.enabled ? "Turn off" : "Turn on"}</button>
                {row.kind === "webhook" && (
                  <button type="button" className="button button-secondary button-small" disabled={pending} onClick={() => { if (window.confirm("Create a new signing secret? The current one stops working immediately.")) run(rotateSecretAction, byId(row.id)); }}>New secret</button>
                )}
                <button type="button" className="button button-secondary button-small" disabled={pending} onClick={() => { if (window.confirm(`Remove "${row.name}"?`)) run(deleteIntegrationAction, byId(row.id)); }}>Remove</button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <form className="integration-form" onSubmit={onAdd}>
          <label htmlFor="int-kind">Type</label>
          <select id="int-kind" className="text-input" value={kind} onChange={(event) => setKind(event.target.value as typeof kind)} disabled={pending}>
            <option value="webhook">Webhook (Zapier, Make, n8n, your server)</option>
            <option value="slack">Slack channel</option>
            <option value="notion">Notion page</option>
          </select>
          <label htmlFor="int-name">Name</label>
          <input id="int-name" name="name" className="text-input" maxLength={60} required disabled={pending} placeholder={kind === "slack" ? "#meetings" : kind === "notion" ? "Meeting notes" : "Zapier"} />
          {kind === "webhook" && (
            <>
              <label htmlFor="int-url">Webhook URL</label>
              <input id="int-url" name="url" className="text-input" type="url" required disabled={pending} placeholder="https://hooks.zapier.com/hooks/catch/…" />
              <label className="inline-check"><input type="checkbox" name="includeTranscript" disabled={pending} /> Include the full transcript</label>
            </>
          )}
          {kind === "slack" && (
            <>
              <label htmlFor="int-slack">Slack incoming webhook URL</label>
              <input id="int-slack" name="slackWebhookUrl" className="text-input" type="url" required disabled={pending} placeholder="https://hooks.slack.com/services/…" autoComplete="off" />
            </>
          )}
          {kind === "notion" && (
            <>
              <label htmlFor="int-notion-token">Notion integration token</label>
              <input id="int-notion-token" name="notionToken" className="text-input" type="password" required disabled={pending} autoComplete="new-password" />
              <label htmlFor="int-notion-page">Notion page link</label>
              <input id="int-notion-page" name="notionPage" className="text-input" required disabled={pending} placeholder="https://www.notion.so/…" />
              <p className="muted-copy">Share that page with your Notion integration first; each note becomes a sub-page.</p>
            </>
          )}
          <div className="integration-actions">
            <button type="submit" className="button button-primary button-small" disabled={pending} aria-busy={pending}>{pending ? "Adding…" : "Add"}</button>
            <button type="button" className="button button-secondary button-small" onClick={() => setAdding(false)} disabled={pending}>Cancel</button>
          </div>
        </form>
      ) : (
        <button type="button" className="button button-secondary button-small" onClick={() => { setAdding(true); setMessage(null); }}>Add an integration</button>
      )}

      {deliveries.length > 0 && (
        <details className="delivery-log">
          <summary>Recent deliveries</summary>
          <ul>
            {deliveries.map((delivery) => (
              <li key={delivery.id} className="muted-copy">
                {delivery.when} · {delivery.name} · {delivery.event} · {delivery.status}{delivery.attempts > 1 ? ` (${delivery.attempts} attempts)` : ""}{delivery.error ? ` — ${delivery.error}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
