import type { Prisma } from "@prisma/client";
import { prisma } from "./db";

/**
 * Workspace audit trail. One helper, one rule: record who did what to which
 * object, with ids and small non-sensitive facts, and never let a failure to
 * write an event break the action it describes.
 */
export const AUDIT_ACTIONS = [
  "member.add",
  "member.invite",
  "member.invite_revoke",
  "member.remove",
  "member.leave",
  "member.role_change",
  "member.password_reset",
  "workspace.retention_update",
  "meeting.delete",
  "meeting.create",
  "meeting.edit",
  "meeting.move",
  "meeting.trash",
  "meeting.restore",
  "meeting.purge",
  "folder.create",
  "folder.rename",
  "folder.move",
  "folder.trash",
  "folder.restore",
  "folder.purge",
  "trash.empty",
  "trash.purge",
  "meeting.import",
  "meeting.regenerate_notes",
  "meeting.retention_delete",
  "share.create",
  "share.revoke",
  "api_token.create",
  "api_token.revoke",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditInput {
  workspaceId: string;
  /** The signed-in user who acted; omit for system actions. */
  actorUserId?: string | null;
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

/** Keep the log small and free of anything a reader should not see in an admin page. */
export const AUDIT_RETENTION_DAYS = 400;
const MAX_METADATA_KEYS = 12;
const MAX_VALUE_LENGTH = 200;
// Content and credentials never belong in an audit row, whatever a caller passes.
const FORBIDDEN_KEY = /token|secret|password|passwd|key|cookie|authorization|content|text|transcript|summary|body|note/iu;

/** Scalars only, bounded, with sensitive-looking keys dropped. Returns undefined when nothing is left. */
export function sanitizeAuditMetadata(metadata: Record<string, unknown> | undefined): Prisma.InputJsonObject | undefined {
  if (!metadata) return undefined;
  const clean: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (Object.keys(clean).length >= MAX_METADATA_KEYS) break;
    if (FORBIDDEN_KEY.test(key) || key.length > 60) continue;
    if (value === null || typeof value === "boolean") clean[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) clean[key] = value;
    else if (typeof value === "string") clean[key] = value.slice(0, MAX_VALUE_LENGTH);
  }
  return Object.keys(clean).length > 0 ? clean : undefined;
}

type AuditClient = Pick<typeof prisma, "auditEvent">;

/**
 * Best-effort write. Returns false (and logs a safe line) instead of throwing:
 * an audit hiccup must not turn a successful delete or role change into an error.
 */
export async function recordAudit(input: AuditInput, client: AuditClient = prisma): Promise<boolean> {
  try {
    const metadata = sanitizeAuditMetadata(input.metadata);
    await client.auditEvent.create({
      data: {
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId ?? null,
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId?.slice(0, 128) ?? null,
        ...(metadata ? { metadata } : {}),
      },
    });
    return true;
  } catch (error) {
    console.error("audit event could not be recorded", {
      action: input.action,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

const PURGE_INTERVAL_MS = 60 * 60 * 1_000;
const PURGE_BATCH = 1_000;
let lastPurgeAt = 0;

/**
 * Deletes events past retention, a bounded batch at most once an hour per
 * process, so the always-on worker can call it from its poll without load.
 */
export async function purgeExpiredAuditEvents(now = new Date(), force = false): Promise<number> {
  if (!force && now.getTime() - lastPurgeAt < PURGE_INTERVAL_MS) return 0;
  lastPurgeAt = now.getTime();
  const cutoff = new Date(now.getTime() - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1_000);
  const expired = await prisma.auditEvent.findMany({ where: { createdAt: { lt: cutoff } }, select: { id: true }, take: PURGE_BATCH });
  if (expired.length === 0) return 0;
  const result = await prisma.auditEvent.deleteMany({ where: { id: { in: expired.map((event) => event.id) } } });
  return result.count;
}
