import { prisma } from "./db";
import { AUDIT_ACTIONS, type AuditAction } from "./audit";
import { managedHostingEnabled } from "./managedAuth";

/**
 * Reading the workspace audit trail. Events hold ids and small facts only (see
 * audit.ts); this turns them into sentences for owners. Who acted is shown
 * only for current members: a former member appears as such, so removing
 * someone also stops their address being displayed here.
 */
export const AUDIT_PAGE_SIZE = 50;
export const AUDIT_EXPORT_LIMIT = 10_000;

export const AUDIT_CATEGORIES = [
  { id: "members", label: "Members and access" },
  { id: "notes", label: "Notes" },
  { id: "library", label: "Folders and Trash" },
  { id: "sharing", label: "Sharing" },
  { id: "integrations", label: "Integrations" },
  { id: "tokens", label: "API tokens" },
  { id: "settings", label: "Settings" },
] as const;
export type AuditCategoryId = (typeof AUDIT_CATEGORIES)[number]["id"];

export const AUDIT_ACTION_INFO: Record<AuditAction, { label: string; category: AuditCategoryId }> = {
  "member.add": { label: "Added a member", category: "members" },
  "member.invite": { label: "Invited someone", category: "members" },
  "member.invite_revoke": { label: "Cancelled an invitation", category: "members" },
  "member.remove": { label: "Removed a member", category: "members" },
  "member.leave": { label: "Left the workspace", category: "members" },
  "member.role_change": { label: "Changed a member's role", category: "members" },
  "member.password_reset": { label: "Sent a password reset", category: "members" },
  "workspace.retention_update": { label: "Changed the retention policy", category: "settings" },
  "workspace.export": { label: "Exported all notes", category: "settings" },
  "workspace.language_update": { label: "Changed vocabulary or summary language", category: "settings" },
  "meeting.delete": { label: "Deleted a note", category: "notes" },
  "meeting.create": { label: "Created a note", category: "notes" },
  "meeting.edit": { label: "Edited a note", category: "notes" },
  "meeting.move": { label: "Moved notes", category: "library" },
  "meeting.trash": { label: "Moved a note to Trash", category: "library" },
  "meeting.restore": { label: "Restored a note", category: "library" },
  "meeting.purge": { label: "Deleted a note forever", category: "library" },
  "meeting.import": { label: "Imported a recording", category: "notes" },
  "meeting.regenerate_notes": { label: "Regenerated a note's text", category: "notes" },
  "meeting.retention_delete": { label: "Notes removed by the retention policy", category: "settings" },
  "folder.create": { label: "Created a folder", category: "library" },
  "folder.rename": { label: "Renamed a folder", category: "library" },
  "folder.move": { label: "Moved a folder", category: "library" },
  "folder.trash": { label: "Moved a folder to Trash", category: "library" },
  "folder.restore": { label: "Restored a folder", category: "library" },
  "folder.purge": { label: "Deleted a folder forever", category: "library" },
  "trash.empty": { label: "Emptied the Trash", category: "library" },
  "trash.purge": { label: "Trash cleared automatically after 30 days", category: "library" },
  "share.create": { label: "Created a share link", category: "sharing" },
  "share.revoke": { label: "Revoked a share link", category: "sharing" },
  "integration.create": { label: "Added an integration", category: "integrations" },
  "integration.update": { label: "Turned an integration on or off", category: "integrations" },
  "integration.delete": { label: "Removed an integration", category: "integrations" },
  "integration.test": { label: "Sent an integration test", category: "integrations" },
  "integration.rotate_secret": { label: "Rotated a webhook secret", category: "integrations" },
  "api_token.create": { label: "Created an API token", category: "tokens" },
  "api_token.revoke": { label: "Revoked an API token", category: "tokens" },
};

export function isAuditCategory(value: string | undefined): value is AuditCategoryId {
  return AUDIT_CATEGORIES.some((category) => category.id === value);
}

function actionsIn(category: AuditCategoryId): AuditAction[] {
  return AUDIT_ACTIONS.filter((action) => AUDIT_ACTION_INFO[action].category === category);
}

/** The audit log is a Team feature on the hosted service; self-hosted instances always have it. */
export async function auditLogAvailable(workspaceId: string): Promise<boolean> {
  if (!managedHostingEnabled()) return true;
  const subscription = await prisma.workspaceSubscription.findUnique({ where: { workspaceId }, select: { plan: true, status: true } });
  return subscription?.plan === "hosted_team" && (subscription.status === "active" || subscription.status === "trialing" || subscription.status === "past_due");
}

export interface AuditFilters {
  category?: AuditCategoryId;
  /** A member's user id, or "system". */
  actor?: string;
}

export interface AuditRow {
  id: string;
  at: Date;
  action: string;
  label: string;
  /** Email of a current member, "System", or "Former member". */
  actor: string;
  targetType: string | null;
  targetId: string | null;
  /** Title of a note that still exists, for owners' convenience. */
  targetTitle: string | null;
  details: string;
}

function detailText(metadata: unknown): string {
  if (typeof metadata !== "object" || metadata === null) return "";
  return Object.entries(metadata as Record<string, unknown>).map(([key, value]) => `${key}: ${String(value)}`).join(", ");
}

function where(workspaceId: string, filters: AuditFilters) {
  return {
    workspaceId,
    ...(filters.category ? { action: { in: actionsIn(filters.category) } } : {}),
    ...(filters.actor === "system" ? { actorUserId: null } : filters.actor ? { actorUserId: filters.actor } : {}),
  };
}

async function present(workspaceId: string, events: Array<{ id: string; createdAt: Date; action: string; actorUserId: string | null; targetType: string | null; targetId: string | null; metadata: unknown }>): Promise<AuditRow[]> {
  const actorIds = [...new Set(events.flatMap((event) => (event.actorUserId ? [event.actorUserId] : [])))];
  const members = actorIds.length
    ? await prisma.workspaceMembership.findMany({ where: { workspaceId, userId: { in: actorIds } }, select: { user: { select: { id: true, email: true } } } })
    : [];
  const emails = new Map(members.map((member) => [member.user.id, member.user.email]));
  const noteIds = [...new Set(events.filter((event) => event.targetType === "meeting" && event.targetId).map((event) => event.targetId!))];
  const notes = noteIds.length ? await prisma.meeting.findMany({ where: { workspaceId, id: { in: noteIds }, deletedAt: null }, select: { id: true, title: true } }) : [];
  const titles = new Map(notes.map((note) => [note.id, note.title]));
  return events.map((event) => ({
    id: event.id,
    at: event.createdAt,
    action: event.action,
    label: AUDIT_ACTION_INFO[event.action as AuditAction]?.label ?? event.action,
    actor: event.actorUserId === null ? "System" : emails.get(event.actorUserId) ?? "Former member",
    targetType: event.targetType,
    targetId: event.targetId,
    targetTitle: event.targetId ? titles.get(event.targetId) ?? null : null,
    details: detailText(event.metadata),
  }));
}

/** Newest first, keyset-paged on (createdAt, id). Returns the cursor for the next page, if any. */
export async function listAuditEvents(workspaceId: string, filters: AuditFilters = {}, cursor?: string | null): Promise<{ rows: AuditRow[]; nextCursor: string | null }> {
  const parsed = cursor ? /^(\d{10,16})_([0-9a-f-]{36})$/.exec(cursor) : null;
  const before = parsed ? { at: new Date(Number(parsed[1])), id: parsed[2]! } : null;
  const events = await prisma.auditEvent.findMany({
    where: {
      ...where(workspaceId, filters),
      ...(before ? { OR: [{ createdAt: { lt: before.at } }, { createdAt: before.at, id: { lt: before.id } }] } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: AUDIT_PAGE_SIZE + 1,
  });
  const page = events.slice(0, AUDIT_PAGE_SIZE);
  const last = page.at(-1);
  return { rows: await present(workspaceId, page), nextCursor: events.length > AUDIT_PAGE_SIZE && last ? `${last.createdAt.getTime()}_${last.id}` : null };
}

/** A CSV cell that spreadsheets cannot run as a formula. */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export async function auditCsv(workspaceId: string, filters: AuditFilters = {}): Promise<string> {
  const events = await prisma.auditEvent.findMany({ where: where(workspaceId, filters), orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: AUDIT_EXPORT_LIMIT });
  const rows: AuditRow[] = [];
  for (let offset = 0; offset < events.length; offset += 500) rows.push(...(await present(workspaceId, events.slice(offset, offset + 500))));
  const header = ["time_utc", "actor", "action", "description", "target_type", "target_id", "details"];
  const lines = rows.map((row) => [row.at.toISOString(), row.actor, row.action, row.label, row.targetType ?? "", row.targetId ?? "", row.details].map(csvCell).join(","));
  return [header.join(","), ...lines].join("\r\n") + "\r\n";
}

export async function auditActors(workspaceId: string): Promise<Array<{ id: string; email: string }>> {
  const members = await prisma.workspaceMembership.findMany({ where: { workspaceId }, select: { user: { select: { id: true, email: true } } }, orderBy: { createdAt: "asc" } });
  return members.map((member) => member.user);
}
