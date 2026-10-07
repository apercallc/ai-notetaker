import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { prisma } from "./db";
import { getWorkspaceAccess } from "./workspaceAccess";
import { recordAudit } from "./audit";
import { decryptSecret, encryptSecret } from "./secretBox";
import { SafeFetchError, safeRequest, validateOutboundUrl, privateNetworksAllowed } from "./safeFetch";
import { folderPathLabel } from "./libraryTree";
import { speakerLabel } from "./types";
import { parseSummary, type SummaryBlock } from "./summaryFormat";
import type { LibrarySession } from "./library";

/**
 * "Note ready" delivery to outside tools. A signed webhook (which is how Zapier,
 * n8n and Make connect), a Slack incoming webhook, or a Notion page. Owners
 * configure them; secrets are encrypted at rest and never shown again. Each
 * event becomes a delivery row that is retried with backoff; the payload is
 * rebuilt from the note when it is sent, so note text is not copied into the
 * delivery table.
 */
export type IntegrationKind = "webhook" | "slack" | "notion";
const INTEGRATION_KINDS: IntegrationKind[] = ["webhook", "slack", "notion"];
export const MAX_INTEGRATIONS_PER_WORKSPACE = 10;
export const MAX_DELIVERY_ATTEMPTS = 6;
/** Delay before attempt N+1 after attempt N failed. */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000];
const CLAIM_LEASE_MS = 5 * 60_000;
const DELIVERY_RETENTION_MS = 14 * 24 * 3_600_000;
const NOTION_VERSION = "2022-06-28";

export type Fail = { ok: false; error: string };
const fail = (error: string): Fail => ({ ok: false, error });

interface WebhookConfig { url: string; secret: string; includeTranscript: boolean }
interface SlackConfig { webhookUrl: string }
interface NotionConfig { token: string; parentPageId: string }
type Config = WebhookConfig | SlackConfig | NotionConfig;

// ---------------------------------------------------------------- signing

/** `v1=` + hex HMAC-SHA256 of `${timestamp}.${body}`; receivers should also reject old timestamps. */
export function signWebhook(secret: string, timestamp: string, body: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** Constant-time check a receiver can copy; also used by tests and the docs examples. */
export function verifyWebhookSignature(secret: string, timestamp: string, body: string, header: string, toleranceSeconds = 300, now = Date.now()): boolean {
  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt) || Math.abs(now / 1_000 - sentAt) > toleranceSeconds) return false;
  const expected = Buffer.from(signWebhook(secret, timestamp, body));
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// ------------------------------------------------------------ validation

export function parseNotionPageId(input: string): string | null {
  const compact = input.trim().replace(/-/g, "");
  const match = /([0-9a-f]{32})(?:[?#].*)?$/i.exec(compact);
  if (!match) return null;
  const hex = match[1]!.toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const SLACK_URL = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}$/;
const NOTION_TOKEN = /^[A-Za-z0-9_-]{20,200}$/;

function outboundRules() {
  const allowPrivate = privateNetworksAllowed();
  return { allowPrivate, allowHttp: allowPrivate };
}

export interface NewIntegration {
  kind: IntegrationKind;
  name: string;
  url?: string;
  includeTranscript?: boolean;
  slackWebhookUrl?: string;
  notionToken?: string;
  notionPage?: string;
}

function buildConfig(input: NewIntegration): { config: Config; hint: string } | Fail {
  if (input.kind === "webhook") {
    const checked = validateOutboundUrl(input.url ?? "", outboundRules());
    if ("error" in checked) return fail(checked.error);
    return {
      config: { url: checked.url.toString(), secret: `whsec_${randomBytes(24).toString("base64url")}`, includeTranscript: Boolean(input.includeTranscript) },
      hint: checked.url.host,
    };
  }
  if (input.kind === "slack") {
    const url = (input.slackWebhookUrl ?? "").trim();
    if (!SLACK_URL.test(url)) return fail("Paste the Slack incoming webhook URL (it starts with https://hooks.slack.com/services/).");
    return { config: { webhookUrl: url }, hint: "Slack incoming webhook" };
  }
  const token = (input.notionToken ?? "").trim();
  if (!NOTION_TOKEN.test(token)) return fail("Paste your Notion integration token.");
  const pageId = parseNotionPageId(input.notionPage ?? "");
  if (!pageId) return fail("Paste the link to the Notion page where notes should be added.");
  return { config: { token, parentPageId: pageId }, hint: `Notion page …${pageId.slice(-4)}` };
}

// --------------------------------------------------------------- CRUD

export interface IntegrationView {
  id: string;
  kind: IntegrationKind;
  name: string;
  enabled: boolean;
  /** Non-secret description of the destination. */
  hint: string;
  lastStatus: string | null;
  lastError: string | null;
  lastDeliveredAt: Date | null;
}

function describe(kind: string, config: Config | null): string {
  if (!config) return "Needs to be re-entered";
  if (kind === "webhook") {
    try {
      return new URL((config as WebhookConfig).url).host;
    } catch {
      return "Webhook";
    }
  }
  if (kind === "slack") return "Slack incoming webhook";
  return `Notion page …${(config as NotionConfig).parentPageId.slice(-4)}`;
}

function openConfig(row: { configCipher: string }): Config | null {
  try {
    return JSON.parse(decryptSecret(row.configCipher)) as Config;
  } catch {
    return null;
  }
}

export async function listIntegrations(workspaceId: string): Promise<IntegrationView[]> {
  const rows = await prisma.integration.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" } });
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as IntegrationKind,
    name: row.name,
    enabled: row.enabled,
    hint: describe(row.kind, openConfig(row)),
    lastStatus: row.lastStatus,
    lastError: row.lastError,
    lastDeliveredAt: row.lastDeliveredAt,
  }));
}

export async function listRecentDeliveries(workspaceId: string, limit = 10) {
  return prisma.integrationDelivery.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { id: true, event: true, status: true, attempts: true, lastError: true, createdAt: true, integration: { select: { name: true } } },
  });
}

const ownersOnly = (session: LibrarySession): Fail | null => (session.role === "owner" ? null : fail("Only a workspace owner can manage integrations."));

export async function createIntegration(session: LibrarySession, input: NewIntegration): Promise<{ ok: true; id: string; secret?: string } | Fail> {
  const denied = ownersOnly(session);
  if (denied) return denied;
  if (!INTEGRATION_KINDS.includes(input.kind)) return fail("Choose Webhook, Slack or Notion.");
  const name = (input.name ?? "").replace(/\s+/g, " ").trim();
  if (!name || name.length > 60) return fail("Give it a name of up to 60 characters.");
  if ((await prisma.integration.count({ where: { workspaceId: session.workspaceId } })) >= MAX_INTEGRATIONS_PER_WORKSPACE) {
    return fail(`A workspace can have ${MAX_INTEGRATIONS_PER_WORKSPACE} integrations. Remove one first.`);
  }
  const built = buildConfig(input);
  if ("ok" in built) return built;
  const row = await prisma.integration.create({
    data: { workspaceId: session.workspaceId, kind: input.kind, name, configCipher: encryptSecret(JSON.stringify(built.config)), createdByUserId: session.userId },
    select: { id: true },
  });
  await recordAudit({ workspaceId: session.workspaceId, actorUserId: session.userId, action: "integration.create", targetType: "integration", targetId: row.id, metadata: { kind: input.kind } });
  return { ok: true, id: row.id, ...(input.kind === "webhook" ? { secret: (built.config as WebhookConfig).secret } : {}) };
}

export async function setIntegrationEnabled(session: LibrarySession, id: string, enabled: boolean): Promise<{ ok: true } | Fail> {
  const denied = ownersOnly(session);
  if (denied) return denied;
  const result = await prisma.integration.updateMany({ where: { id, workspaceId: session.workspaceId }, data: { enabled } });
  if (result.count !== 1) return fail("That integration no longer exists.");
  await recordAudit({ workspaceId: session.workspaceId, actorUserId: session.userId, action: "integration.update", targetType: "integration", targetId: id, metadata: { enabled } });
  return { ok: true };
}

export async function deleteIntegration(session: LibrarySession, id: string): Promise<{ ok: true } | Fail> {
  const denied = ownersOnly(session);
  if (denied) return denied;
  const result = await prisma.integration.deleteMany({ where: { id, workspaceId: session.workspaceId } });
  if (result.count !== 1) return fail("That integration no longer exists.");
  await recordAudit({ workspaceId: session.workspaceId, actorUserId: session.userId, action: "integration.delete", targetType: "integration", targetId: id });
  return { ok: true };
}

/** New signing secret for a webhook; the old one stops working immediately. Shown once. */
export async function rotateWebhookSecret(session: LibrarySession, id: string): Promise<{ ok: true; secret: string } | Fail> {
  const denied = ownersOnly(session);
  if (denied) return denied;
  const row = await prisma.integration.findFirst({ where: { id, workspaceId: session.workspaceId, kind: "webhook" } });
  const config = row ? openConfig(row) : null;
  if (!row || !config) return fail("That webhook needs to be created again.");
  const secret = `whsec_${randomBytes(24).toString("base64url")}`;
  await prisma.integration.update({ where: { id }, data: { configCipher: encryptSecret(JSON.stringify({ ...(config as WebhookConfig), secret })) } });
  await recordAudit({ workspaceId: session.workspaceId, actorUserId: session.userId, action: "integration.rotate_secret", targetType: "integration", targetId: id });
  return { ok: true, secret };
}

// ----------------------------------------------------------- payloads

export interface NotePayload {
  id: string;
  title: string;
  startedAt: string;
  endedAt: string;
  template: string;
  folder: string | null;
  url: string | null;
  summaryMarkdown: string;
  actionItems: Array<{ text: string; owner: string | null; dueAt: string | null; status: string }>;
  transcript?: Array<{ speaker: string; text: string; timestamp: string | null }>;
}

function appUrl(): string | null {
  const configured = process.env.APP_URL?.trim() || process.env.NEXT_PUBLIC_APP_URL?.trim();
  return configured ? configured.replace(/\/+$/, "") : null;
}

/** The note as a receiver sees it, with chosen speaker names applied. Null when the note is gone. */
export async function buildNotePayload(workspaceId: string, meetingId: string, includeTranscript: boolean): Promise<NotePayload | null> {
  const meeting = await prisma.meeting.findFirst({
    where: { id: meetingId, workspaceId, deletedAt: null },
    include: {
      actionItems: true,
      speakers: { select: { speakerKey: true, displayName: true } },
      ...(includeTranscript ? { transcript: { orderBy: { order: "asc" as const } } } : {}),
    },
  });
  if (!meeting) return null;
  const names = Object.fromEntries(meeting.speakers.map((speaker) => [speaker.speakerKey, speaker.displayName]));
  const base = appUrl();
  const folders = meeting.folderId ? await prisma.folder.findMany({ where: { workspaceId, deletedAt: null }, select: { id: true, parentId: true, name: true } }) : [];
  const transcript = (meeting as { transcript?: Array<{ speaker: string; text: string; timestamp: Date | null }> }).transcript;
  return {
    id: meeting.id,
    title: meeting.title,
    startedAt: meeting.startedAt.toISOString(),
    endedAt: meeting.endedAt.toISOString(),
    template: meeting.mode,
    folder: meeting.folderId ? folderPathLabel(folders, meeting.folderId) || null : null,
    url: base ? `${base}/meetings/${meeting.id}` : null,
    summaryMarkdown: meeting.summary,
    actionItems: meeting.actionItems.map((item) => ({ text: item.text, owner: item.owner, dueAt: item.dueAt?.toISOString() ?? null, status: item.status })),
    ...(includeTranscript && transcript
      ? { transcript: transcript.map((line) => ({ speaker: speakerLabel(line.speaker, names), text: line.text, timestamp: line.timestamp?.toISOString() ?? null })) }
      : {}),
  };
}

function testPayload(): NotePayload {
  const now = new Date().toISOString();
  return {
    id: "test-note",
    title: "Test note from AI Notetaker",
    startedAt: now,
    endedAt: now,
    template: "general",
    folder: null,
    url: appUrl(),
    summaryMarkdown: "This is a test delivery. If you can read this, the connection works.",
    actionItems: [{ text: "Nothing to do", owner: null, dueAt: null, status: "open" }],
  };
}

function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A compact Slack message: title (linked), the start of the summary, and open actions. */
export function slackMessage(note: NotePayload): { text: string; blocks: unknown[] } {
  const title = escapeSlack(note.title).slice(0, 150);
  const headline = note.url ? `*<${note.url}|${title}>*` : `*${title}*`;
  const summary = parseSummary(note.summaryMarkdown)
    .map((block) => (block.type === "list" ? block.items.map((item) => `• ${item}`).join("\n") : block.text))
    .join("\n")
    .trim();
  const excerpt = escapeSlack(summary.length > 700 ? `${summary.slice(0, 700).trimEnd()}…` : summary);
  const open = note.actionItems.filter((item) => item.status !== "done").slice(0, 5);
  const actions = open.map((item) => `• ${escapeSlack(item.text).slice(0, 200)}${item.owner ? ` (${escapeSlack(item.owner)})` : ""}`).join("\n");
  const blocks: unknown[] = [{ type: "section", text: { type: "mrkdwn", text: `${headline}${excerpt ? `\n${excerpt}` : ""}`.slice(0, 2_900) } }];
  if (actions) blocks.push({ type: "section", text: { type: "mrkdwn", text: `*Action items*\n${actions}`.slice(0, 2_900) } });
  return { text: `Notes ready: ${note.title}`.slice(0, 300), blocks };
}

const NOTION_TEXT_LIMIT = 2_000;
const NOTION_MAX_BLOCKS = 95;

function notionText(text: string): Array<{ type: "text"; text: { content: string } }> {
  const parts: Array<{ type: "text"; text: { content: string } }> = [];
  for (let offset = 0; offset < text.length && parts.length < 90; offset += NOTION_TEXT_LIMIT) {
    parts.push({ type: "text", text: { content: text.slice(offset, offset + NOTION_TEXT_LIMIT) } });
  }
  return parts.length > 0 ? parts : [{ type: "text", text: { content: " " } }];
}

/** The note as Notion page children: headings, paragraphs, bullets, and action items as to-dos. */
export function notionBlocks(note: NotePayload): unknown[] {
  const blocks: unknown[] = [];
  const add = (block: unknown) => {
    if (blocks.length < NOTION_MAX_BLOCKS) blocks.push(block);
  };
  if (note.url) add({ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: "Open in AI Notetaker", link: { url: note.url } } }] } });
  const summaryBlocks: SummaryBlock[] = parseSummary(note.summaryMarkdown);
  for (const block of summaryBlocks) {
    if (block.type === "heading") add({ object: "block", type: "heading_2", heading_2: { rich_text: notionText(block.text) } });
    else if (block.type === "paragraph") add({ object: "block", type: "paragraph", paragraph: { rich_text: notionText(block.text) } });
    else for (const item of block.items) add(block.ordered
      ? { object: "block", type: "numbered_list_item", numbered_list_item: { rich_text: notionText(item) } }
      : { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: notionText(item) } });
  }
  if (note.actionItems.length > 0) {
    add({ object: "block", type: "heading_2", heading_2: { rich_text: notionText("Action items") } });
    for (const item of note.actionItems) {
      add({ object: "block", type: "to_do", to_do: { rich_text: notionText(`${item.text}${item.owner ? ` (${item.owner})` : ""}`), checked: item.status === "done" } });
    }
  }
  return blocks;
}

// ------------------------------------------------------------- sending

export interface SendResult {
  ok: boolean;
  status: number | null;
  /** Short and safe to show to the owner. */
  error?: string;
}

export type Sender = (kind: IntegrationKind, config: Config, event: string, deliveryId: string, note: NotePayload) => Promise<SendResult>;

function statusError(status: number): string {
  if (status === 401 || status === 403) return "The destination rejected the credentials (HTTP " + status + ").";
  if (status === 404) return "The destination wasn't found (HTTP 404). Check the URL.";
  if (status >= 300 && status < 400) return "The destination redirected the request, which isn't followed.";
  if (status === 429) return "The destination is rate limiting requests (HTTP 429).";
  return `The destination answered HTTP ${status}.`;
}

async function transport(request: Parameters<typeof safeRequest>[0]): Promise<SendResult> {
  try {
    const response = await safeRequest(request);
    return response.status >= 200 && response.status < 300 ? { ok: true, status: response.status } : { ok: false, status: response.status, error: statusError(response.status) };
  } catch (error) {
    return { ok: false, status: null, error: error instanceof SafeFetchError ? error.message : "The request failed." };
  }
}

const defaultSender: Sender = async (kind, config, event, deliveryId, note) => {
  if (kind === "webhook") {
    const webhook = config as WebhookConfig;
    const body = JSON.stringify({ id: deliveryId, event, createdAt: new Date().toISOString(), note });
    const timestamp = String(Math.floor(Date.now() / 1_000));
    return transport({
      url: webhook.url,
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "user-agent": "AI-Notetaker-Webhooks/1",
        "x-notetaker-event": event,
        "x-notetaker-delivery": deliveryId,
        "x-notetaker-timestamp": timestamp,
        "x-notetaker-signature": signWebhook(webhook.secret, timestamp, body),
      },
      ...outboundRules(),
    });
  }
  if (kind === "slack") {
    return transport({ url: (config as SlackConfig).webhookUrl, method: "POST", body: JSON.stringify(slackMessage(note)), headers: { "content-type": "application/json" }, allowPrivate: false });
  }
  const notion = config as NotionConfig;
  return transport({
    url: "https://api.notion.com/v1/pages",
    method: "POST",
    headers: { authorization: `Bearer ${notion.token}`, "notion-version": NOTION_VERSION, "content-type": "application/json" },
    body: JSON.stringify({
      parent: { page_id: notion.parentPageId },
      properties: { title: { title: notionText(note.title.slice(0, 200)) } },
      children: notionBlocks(note),
    }),
    allowPrivate: false,
  });
};

// ------------------------------------------------------------ delivery

/**
 * Announces a note once. Safe to call from every path that can make a note
 * ready: only the first call per note creates deliveries.
 */
export async function notifyNoteReady(workspaceId: string, meetingId: string, send: Sender = defaultSender): Promise<number> {
  const integrations = await prisma.integration.findMany({ where: { workspaceId, enabled: true }, select: { id: true } });
  if (integrations.length === 0) return 0;
  // Integrations are a paid feature: nothing is sent from a read-only workspace.
  if (!(await getWorkspaceAccess(workspaceId)).writable) return 0;
  const claimed = await prisma.meeting.updateMany({ where: { id: meetingId, workspaceId, readyNotifiedAt: null, deletedAt: null }, data: { readyNotifiedAt: new Date() } });
  if (claimed.count !== 1) return 0;
  await prisma.integrationDelivery.createMany({
    data: integrations.map((integration) => ({ id: randomUUID(), integrationId: integration.id, workspaceId, event: "note.ready", meetingId })),
  });
  // First attempt straight away; anything that fails is picked up by the retry schedule.
  void processDeliveries({ send }).catch((error: unknown) => {
    console.error("integration delivery failed", { error: error instanceof Error ? error.message : String(error) });
  });
  return integrations.length;
}

export interface ProcessOptions {
  now?: Date;
  limit?: number;
  send?: Sender;
}

/** Sends due deliveries. Each is claimed with a lease first, so concurrent workers never double-send. */
export async function processDeliveries(options: ProcessOptions = {}): Promise<{ delivered: number; failed: number; retried: number; skipped: number }> {
  const now = options.now ?? new Date();
  const send = options.send ?? defaultSender;
  const due = await prisma.integrationDelivery.findMany({
    where: { status: "pending", nextAttemptAt: { lte: now } },
    orderBy: { nextAttemptAt: "asc" },
    take: options.limit ?? 25,
  });
  const tally = { delivered: 0, failed: 0, retried: 0, skipped: 0 };
  for (const delivery of due) {
    const claim = await prisma.integrationDelivery.updateMany({
      where: { id: delivery.id, status: "pending", nextAttemptAt: delivery.nextAttemptAt },
      data: { nextAttemptAt: new Date(now.getTime() + CLAIM_LEASE_MS), attempts: { increment: 1 } },
    });
    if (claim.count !== 1) continue;
    const attempts = delivery.attempts + 1;
    const integration = await prisma.integration.findUnique({ where: { id: delivery.integrationId } });
    const config = integration && integration.enabled ? openConfig(integration) : null;
    if (!integration || !integration.enabled) {
      await prisma.integrationDelivery.update({ where: { id: delivery.id }, data: { status: "skipped", lastError: "The integration was turned off or removed." } });
      tally.skipped += 1;
      continue;
    }
    if (!config) {
      await prisma.integrationDelivery.update({ where: { id: delivery.id }, data: { status: "failed", lastError: "The saved credentials couldn't be read. Re-create this integration." } });
      await prisma.integration.update({ where: { id: integration.id }, data: { lastStatus: "failed", lastError: "The saved credentials couldn't be read. Re-create this integration." } });
      tally.failed += 1;
      continue;
    }
    const includeTranscript = integration.kind === "webhook" && (config as WebhookConfig).includeTranscript;
    const note = delivery.meetingId ? await buildNotePayload(delivery.workspaceId, delivery.meetingId, includeTranscript) : testPayload();
    if (!note) {
      await prisma.integrationDelivery.update({ where: { id: delivery.id }, data: { status: "skipped", lastError: "The note no longer exists." } });
      tally.skipped += 1;
      continue;
    }
    let result: SendResult;
    try {
      result = await send(integration.kind as IntegrationKind, config, delivery.event, delivery.id, note);
    } catch {
      result = { ok: false, status: null, error: "The request failed." };
    }
    if (result.ok) {
      await prisma.integrationDelivery.update({ where: { id: delivery.id }, data: { status: "delivered", responseStatus: result.status, deliveredAt: new Date(), lastError: null } });
      await prisma.integration.update({ where: { id: integration.id }, data: { lastStatus: "ok", lastError: null, lastDeliveredAt: new Date() } });
      tally.delivered += 1;
      continue;
    }
    const error = (result.error ?? "The request failed.").slice(0, 300);
    const exhausted = attempts >= MAX_DELIVERY_ATTEMPTS;
    await prisma.integrationDelivery.update({
      where: { id: delivery.id },
      data: {
        status: exhausted ? "failed" : "pending",
        responseStatus: result.status,
        lastError: error,
        nextAttemptAt: new Date(now.getTime() + (RETRY_DELAYS_MS[attempts - 1] ?? RETRY_DELAYS_MS.at(-1)!)),
      },
    });
    await prisma.integration.update({ where: { id: integration.id }, data: { lastStatus: "failed", lastError: error } });
    if (exhausted) tally.failed += 1;
    else tally.retried += 1;
  }
  return tally;
}

/** Sends one synthetic delivery and reports the outcome to the owner. */
export async function sendTestDelivery(session: LibrarySession, id: string, send: Sender = defaultSender): Promise<{ ok: true; message: string } | Fail> {
  const denied = ownersOnly(session);
  if (denied) return denied;
  const integration = await prisma.integration.findFirst({ where: { id, workspaceId: session.workspaceId } });
  if (!integration) return fail("That integration no longer exists.");
  const config = openConfig(integration);
  if (!config) return fail("The saved credentials couldn't be read. Re-create this integration.");
  const deliveryId = randomUUID();
  let result: SendResult;
  try {
    result = await send(integration.kind as IntegrationKind, config, "test", deliveryId, testPayload());
  } catch {
    result = { ok: false, status: null, error: "The request failed." };
  }
  await prisma.integration.update({
    where: { id },
    data: result.ok ? { lastStatus: "ok", lastError: null, lastDeliveredAt: new Date() } : { lastStatus: "failed", lastError: (result.error ?? "The request failed.").slice(0, 300) },
  });
  await recordAudit({ workspaceId: session.workspaceId, actorUserId: session.userId, action: "integration.test", targetType: "integration", targetId: id, metadata: { ok: result.ok } });
  return result.ok ? { ok: true, message: "Test delivered." } : fail(result.error ?? "The test failed.");
}

const MAINTENANCE_INTERVAL_MS = 60_000;
const PURGE_INTERVAL_MS = 3_600_000;
let lastMaintenanceAt = 0;
let lastPurgeAt = 0;

/** Retries due deliveries and prunes old ones. Throttled, so the worker poll and page loads can both call it. */
export async function runIntegrationMaintenance(now = new Date(), force = false): Promise<void> {
  if (!force && now.getTime() - lastMaintenanceAt < MAINTENANCE_INTERVAL_MS) return;
  lastMaintenanceAt = now.getTime();
  await processDeliveries({ now });
  if (force || now.getTime() - lastPurgeAt >= PURGE_INTERVAL_MS) {
    lastPurgeAt = now.getTime();
    await prisma.integrationDelivery.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - DELIVERY_RETENTION_MS) } } });
  }
}
