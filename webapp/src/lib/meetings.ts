import { prisma } from "./db";
import { LOCAL_USER_ID } from "./auth";
import { deleteObject } from "./objectStorage";
import { randomUUID } from "node:crypto";
import type { CaptureSource, CreateMeetingRequest, MeetingDetailResponse, MeetingMode, MeetingSummaryResponse, ProcessingMode } from "./types";
import { MAX_SEARCH_LENGTH } from "./meetingConstants";
import { makeSnippet, type HighlightPart } from "./snippet";
import { utcDateString } from "./actionItems";

export class ValidationError extends Error {}

const MAX_ID_LENGTH = 128;
const MAX_TITLE_LENGTH = 200;
const MAX_SUMMARY_LENGTH = 100_000;
const MAX_TRANSCRIPT_SEGMENTS = 25_000;
const MAX_SEGMENT_TEXT_LENGTH = 20_000;
const MAX_SPEAKER_LENGTH = 100;
const MAX_ACTION_ITEMS = 1_000;
const MAX_ACTION_TEXT_LENGTH = 2_000;
const MAX_OWNER_LENGTH = 200;
const MAX_ACTION_ID_LENGTH = 128;
const MAX_OFFSET = 100_000;
const MAX_TRANSCRIPT_TOTAL_LENGTH = 5_000_000;
const MAX_ACTION_TOTAL_LENGTH = 2_000_000;

function assertValid(input: unknown): CreateMeetingRequest {
  if (typeof input !== "object" || input === null) {
    throw new ValidationError("Request body must be an object");
  }
  const body = input as Record<string, unknown>;

  if (typeof body.id !== "string" || body.id.length === 0 || body.id.length > MAX_ID_LENGTH) {
    throw new ValidationError("id is required");
  }
  if (typeof body.startedAt !== "string" || Number.isNaN(Date.parse(body.startedAt))) {
    throw new ValidationError("startedAt must be an ISO 8601 string");
  }
  if (typeof body.endedAt !== "string" || Number.isNaN(Date.parse(body.endedAt))) {
    throw new ValidationError("endedAt must be an ISO 8601 string");
  }
  if (new Date(body.endedAt).getTime() < new Date(body.startedAt).getTime()) {
    throw new ValidationError("endedAt must not be before startedAt");
  }
  if (typeof body.summary !== "string") {
    throw new ValidationError("summary is required");
  }
  if (body.mode !== undefined && !["general", "standup", "sales", "one_on_one", "interview", "custom"].includes(body.mode as string)) {
    throw new ValidationError("mode is invalid");
  }
  if (body.captureSource !== undefined && !["desktop", "meet"].includes(body.captureSource as string)) {
    throw new ValidationError("captureSource is invalid");
  }
  if (body.processingMode !== undefined && !["local_byok", "managed"].includes(body.processingMode as string)) {
    throw new ValidationError("processingMode is invalid");
  }
  if (body.summary.length > MAX_SUMMARY_LENGTH) {
    throw new ValidationError(`summary must be ${MAX_SUMMARY_LENGTH} characters or fewer`);
  }
  if (!Array.isArray(body.transcript) || body.transcript.length > MAX_TRANSCRIPT_SEGMENTS) {
    throw new ValidationError("transcript must be an array");
  }
  let transcriptLength = 0;
  for (const segment of body.transcript) {
    if (
      typeof segment !== "object" ||
      segment === null ||
      typeof (segment as Record<string, unknown>).speaker !== "string" ||
      typeof (segment as Record<string, unknown>).text !== "string" ||
      typeof (segment as Record<string, unknown>).timestamp !== "string" ||
      (segment as Record<string, string>).speaker.length > MAX_SPEAKER_LENGTH ||
      (segment as Record<string, string>).text.length > MAX_SEGMENT_TEXT_LENGTH ||
      Number.isNaN(Date.parse((segment as Record<string, string>).timestamp))
    ) {
      throw new ValidationError("each transcript segment needs speaker, text, and timestamp");
    }
    transcriptLength += (segment as Record<string, string>).text.length;
    if (transcriptLength > MAX_TRANSCRIPT_TOTAL_LENGTH) {
      throw new ValidationError("transcript is too large");
    }
  }
  if (!Array.isArray(body.actionItems) || body.actionItems.length > MAX_ACTION_ITEMS) {
    throw new ValidationError("actionItems must be an array");
  }
  let actionTextLength = 0;
  for (const item of body.actionItems) {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof (item as Record<string, unknown>).text !== "string" ||
      (item as Record<string, string>).text.length > MAX_ACTION_TEXT_LENGTH ||
      ((item as Record<string, unknown>).id !== undefined &&
        (typeof (item as Record<string, unknown>).id !== "string" ||
          (item as Record<string, string>).id.length === 0 ||
          (item as Record<string, string>).id.length > MAX_ACTION_ID_LENGTH)) ||
      ((item as Record<string, unknown>).status !== undefined &&
        !["open", "done"].includes((item as Record<string, unknown>).status as string)) ||
      ((item as Record<string, unknown>).owner !== undefined &&
        (typeof (item as Record<string, unknown>).owner !== "string" ||
          (item as Record<string, string>).owner.length > MAX_OWNER_LENGTH)) ||
      ((item as Record<string, unknown>).dueAt !== undefined &&
        (item as Record<string, unknown>).dueAt !== null &&
        (typeof (item as Record<string, unknown>).dueAt !== "string" ||
          Number.isNaN(Date.parse((item as Record<string, string>).dueAt)))) ||
      ((item as Record<string, unknown>).completedAt !== undefined &&
        (item as Record<string, unknown>).completedAt !== null &&
        (typeof (item as Record<string, unknown>).completedAt !== "string" ||
          Number.isNaN(Date.parse((item as Record<string, string>).completedAt))))
    ) {
      throw new ValidationError("each action item needs text");
    }
    actionTextLength += (item as Record<string, string>).text.length;
    if (actionTextLength > MAX_ACTION_TOTAL_LENGTH) {
      throw new ValidationError("action items are too large");
    }
  }
  if (body.title !== undefined && (typeof body.title !== "string" || body.title.length > MAX_TITLE_LENGTH)) {
    throw new ValidationError("title must be a string if provided");
  }

  return body as unknown as CreateMeetingRequest;
}

function defaultTitle(startedAt: string): string {
  return `Meeting on ${new Date(startedAt).toISOString().slice(0, 10)}`;
}

export async function upsertMeeting(rawInput: unknown, workspaceId: string, userId = LOCAL_USER_ID): Promise<{ id: string; title: string }> {
  const input = assertValid(rawInput);
  const title = input.title?.trim() ? input.title.trim() : defaultTitle(input.startedAt);
  const captureSource: CaptureSource = input.captureSource ?? "desktop";
  const processingMode: ProcessingMode = input.processingMode ?? "local_byok";

  // IDs originate on clients. Never let a managed client re-use an ID from a
  // different tenant, and do this check before deleting child rows.
  //
  // The ownership check and the writes run in ONE interactive transaction:
  // with the check outside, a meeting created by workspace A after workspace
  // B's read committed let B's upsert take the update branch — overwriting
  // A's meeting and cascading deletes onto A's transcript/action-item rows.
  const isManagedRegistration = input.processingMode === "managed" && input.summary === "" && input.transcript.length === 0 && input.actionItems.length === 0;

  // Client-supplied action-item ids are used as the global primary key. The
  // same id reused by a different meeting (or workspace) violates the unique
  // constraint and aborts the whole sync with a 500. Re-key collisions up
  // front; the meeting's own rows are deleted below, so only foreign owners
  // matter.
  const clientActionIds = input.actionItems.map((item) => item.id).filter((id): id is string => Boolean(id));
  const foreignActionIds = new Set(
    clientActionIds.length > 0
      ? (await prisma.actionItem.findMany({ where: { id: { in: clientActionIds }, meeting: { NOT: { id: input.id } } }, select: { id: true } })).map((row) => row.id)
      : [],
  );

  await prisma.$transaction(async (tx) => {
    const existing = await tx.meeting.findUnique({
      where: { id: input.id },
      select: { workspaceId: true, summary: true, startedAt: true, endedAt: true },
    });
    if (existing && existing.workspaceId !== workspaceId) {
      throw new ValidationError("meeting belongs to another workspace");
    }
    // Registration is deliberately idempotent: a retry must not erase a
    // transcript/summary that was already persisted by an earlier attempt,
    // including a valid result whose summary happens to be empty.
    const preserveExistingContent = Boolean(existing && isManagedRegistration);
    const storedSummary = preserveExistingContent ? existing?.summary ?? "" : input.summary;
    const storedStartedAt = preserveExistingContent ? existing?.startedAt ?? new Date(input.startedAt) : new Date(input.startedAt);
    const storedEndedAt = preserveExistingContent ? existing?.endedAt ?? new Date(input.endedAt) : new Date(input.endedAt);

    // Sequential awaits inside the interactive transaction: same atomicity
    // as the old batched form, valid on the tx client.
    if (!preserveExistingContent) {
      await tx.transcriptSegment.deleteMany({ where: { meetingId: input.id } });
      await tx.actionItem.deleteMany({ where: { meetingId: input.id } });
    }
    await tx.meeting.upsert({
      where: { id: input.id },
      create: {
        id: input.id,
        userId,
        workspaceId,
        title,
        mode: input.mode ?? "general",
        captureSource,
        processingMode,
        startedAt: storedStartedAt,
        endedAt: storedEndedAt,
        summary: storedSummary,
      },
      update: {
        title,
        mode: input.mode ?? "general",
        ...(input.captureSource ? { captureSource } : {}),
        ...(input.processingMode ? { processingMode } : {}),
        startedAt: storedStartedAt,
        endedAt: storedEndedAt,
        summary: storedSummary,
      },
    });
    if (!preserveExistingContent && input.transcript.length > 0) {
      await tx.transcriptSegment.createMany({
        data: input.transcript.map((segment, index) => ({
          meetingId: input.id,
          userId,
          speaker: segment.speaker,
          text: segment.text,
          timestamp: new Date(segment.timestamp),
          order: index,
        })),
      });
    }
    if (!preserveExistingContent && input.actionItems.length > 0) {
      await tx.actionItem.createMany({
        data: input.actionItems.map((item) => ({
          id: item.id && !foreignActionIds.has(item.id) ? item.id : randomUUID(),
          meetingId: input.id,
          userId,
          text: item.text,
          owner: item.owner ?? null,
          status: item.status ?? "open",
          dueAt: item.dueAt ? new Date(item.dueAt) : null,
          completedAt: item.completedAt ? new Date(item.completedAt) : null,
        })),
      });
    }
  });

  return { id: input.id, title };
}

export type ProcessingStatus = "processing" | "complete" | "error";

/** The most recent hosted-processing job for a meeting, in UI terms. */
export interface ProcessingState {
  jobId: string;
  status: ProcessingStatus;
  errorMessage: string | null;
  updatedAt: string;
}

export interface MeetingListItem extends MeetingSummaryResponse {
  processing: ProcessingState | null;
  /** Where the search query matched, when it matched somewhere other than the title. */
  match: { source: "summary" | "action item" | "transcript"; parts: HighlightPart[] } | null;
}

export interface MeetingDetail extends MeetingDetailResponse {
  processing: ProcessingState | null;
}

const LATEST_JOB = {
  orderBy: { createdAt: "desc" as const },
  take: 1,
  select: { id: true, status: true, errorMessage: true, updatedAt: true },
};

function toProcessingState(jobs: { id: string; status: string; errorMessage: string | null; updatedAt: Date }[]): ProcessingState | null {
  const job = jobs[0];
  if (!job) return null;
  // queued/processing are one state to the user: work is in flight.
  const status: ProcessingStatus = job.status === "complete" ? "complete" : job.status === "error" ? "error" : "processing";
  return {
    jobId: job.id,
    status,
    errorMessage: status === "error" ? job.errorMessage : null,
    updatedAt: job.updatedAt.toISOString(),
  };
}

export interface ListMeetingsOptions {
  query?: string;
  limit?: number;
  offset?: number;
}

export async function listMeetings(
  workspaceId: string,
  options: ListMeetingsOptions
): Promise<{ meetings: MeetingListItem[]; total: number }> {
  const query = options.query?.trim();
  if (query && query.length > MAX_SEARCH_LENGTH) {
    throw new ValidationError(`query must be ${MAX_SEARCH_LENGTH} characters or fewer`);
  }
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 0)) {
    throw new ValidationError("limit must be a non-negative integer");
  }
  if (options.offset !== undefined && (!Number.isSafeInteger(options.offset) || options.offset < 0 || options.offset > MAX_OFFSET)) {
    throw new ValidationError("offset must be a non-negative integer");
  }
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const offset = options.offset ?? 0;

  const where = {
    workspaceId,
    ...(query
      ? {
          OR: [
            { title: { contains: query, mode: "insensitive" as const } },
            { summary: { contains: query, mode: "insensitive" as const } },
            { transcript: { some: { text: { contains: query, mode: "insensitive" as const } } } },
            { actionItems: { some: { text: { contains: query, mode: "insensitive" as const } } } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.meeting.findMany({
      where,
      // `id` breaks ties. Sorting on `startedAt` alone leaves rows that share
      // a timestamp in whatever order Postgres happens to return, which
      // differs between the two queries that make up a paginated read — so a
      // meeting could appear on two consecutive pages while another is never
      // shown at all. Back-to-back syncs land on the same second often
      // enough for this to be real, not theoretical.
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: limit,
      skip: offset,
      include: {
        actionItems: { where: { status: "open" }, select: { id: true } },
        processingJobs: LATEST_JOB,
      },
    }),
    prisma.meeting.count({ where }),
  ]);

  const matches = query ? await findMatches(rows, query) : new Map<string, MeetingListItem["match"]>();

  return {
    meetings: rows.map((row) => ({
      id: row.id,
      title: row.title,
      startedAt: row.startedAt.toISOString(),
      summaryPreview: row.summary.length > 200 ? `${row.summary.slice(0, 200)}…` : row.summary,
      openActionItems: row.actionItems.length,
      processing: toProcessingState(row.processingJobs),
      match: matches.get(row.id) ?? null,
    })),
    total,
  };
}

/**
 * Excerpts for the search results page. Ranking by relevance would need a
 * generated tsvector column and GIN index (a schema change), so results stay
 * newest-first; what we can do without one is show *why* each result matched.
 * A title match needs no excerpt, and the summary is checked in memory, so
 * only meetings that matched elsewhere cost an extra (batched) query.
 */
async function findMatches(
  rows: { id: string; title: string; summary: string }[],
  query: string,
): Promise<Map<string, MeetingListItem["match"]>> {
  const found = new Map<string, MeetingListItem["match"]>();
  const unresolved: string[] = [];
  for (const row of rows) {
    const parts = makeSnippet(row.summary, query);
    if (parts) found.set(row.id, { source: "summary", parts });
    else if (!row.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())) unresolved.push(row.id);
  }
  if (unresolved.length === 0) return found;

  const insensitive = { contains: query, mode: "insensitive" as const };
  const [actions, segments] = await Promise.all([
    prisma.actionItem.findMany({
      where: { meetingId: { in: unresolved }, text: insensitive },
      distinct: ["meetingId"],
      select: { meetingId: true, text: true },
    }),
    prisma.transcriptSegment.findMany({
      where: { meetingId: { in: unresolved }, text: insensitive },
      orderBy: [{ meetingId: "asc" }, { order: "asc" }],
      distinct: ["meetingId"],
      select: { meetingId: true, text: true },
    }),
  ]);
  for (const action of actions) {
    const parts = makeSnippet(action.text, query);
    if (parts) found.set(action.meetingId, { source: "action item", parts });
  }
  for (const segment of segments) {
    if (found.has(segment.meetingId)) continue;
    const parts = makeSnippet(segment.text, query);
    if (parts) found.set(segment.meetingId, { source: "transcript", parts });
  }
  return found;
}

export async function getMeeting(workspaceId: string, id: string): Promise<MeetingDetail | null> {
  const row = await prisma.meeting.findFirst({
    where: { id, workspaceId },
    include: {
      transcript: { orderBy: { order: "asc" } },
      actionItems: true,
      uploads: { where: { status: "complete" }, select: { chunks: { select: { channel: true } } } },
      processingJobs: LATEST_JOB,
    },
  });
  if (!row) return null;

  return {
    id: row.id,
    title: row.title,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt.toISOString(),
    summary: row.summary,
    mode: row.mode as MeetingMode,
    processing: toProcessingState(row.processingJobs),
    recordingAvailable: Boolean(row.recordingObjectKey) || row.uploads.some((upload) => upload.chunks.length > 0),
    recordingChannels: [...new Set(row.uploads.flatMap((upload) => upload.chunks.map((chunk) => chunk.channel)).filter((channel): channel is "mic" | "speaker" => channel === "mic" || channel === "speaker"))],
    transcript: row.transcript.map((segment) => ({
      speaker: segment.speaker,
      text: segment.text,
      timestamp: segment.timestamp.toISOString(),
    })),
    actionItems: row.actionItems.map((item) => ({
      id: item.id,
      text: item.text,
      owner: item.owner,
      status: item.status as "open" | "done",
      dueAt: item.dueAt?.toISOString() ?? null,
      completedAt: item.completedAt?.toISOString() ?? null,
    })),
  };
}

export const ACTION_ITEMS_PAGE_SIZE = 50;

export interface ListActionItemsOptions {
  status?: "open" | "done";
  /** Only open items already past their due day. Implies status "open". */
  overdue?: boolean;
  /**
   * Items from meetings this user recorded that are unassigned or assigned to
   * them (matched by "you"/"me" or the parts of their email address).
   */
  mine?: { userId: string; names: string[] };
  /** Id of the last item on the previous page. */
  cursor?: string;
  limit?: number;
}

/**
 * The action-item inbox, open items first, then by due date (undated last),
 * paged with a keyset cursor. A single meeting may carry up to
 * MAX_ACTION_ITEMS (1,000), so an archive can hold six figures of rows —
 * never load them all.
 */
export async function listActionItems(workspaceId: string, options: ListActionItemsOptions = {}) {
  const limit = Math.min(Math.max(options.limit ?? ACTION_ITEMS_PAGE_SIZE, 1), 100);
  const status = options.overdue ? "open" : options.status;
  const where = {
    meeting: { workspaceId },
    ...(status ? { status } : {}),
    ...(options.overdue ? { dueAt: { lt: new Date(`${utcDateString()}T00:00:00.000Z`) } } : {}),
    ...(options.mine
      ? {
          userId: options.mine.userId,
          OR: [
            { owner: null },
            ...options.mine.names.map((name) => ({ owner: { equals: name, mode: "insensitive" as const } })),
          ],
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.actionItem.findMany({
      where,
      // "open" sorts after "done" alphabetically, hence desc. `id` makes the
      // order total, which the cursor needs to be stable across pages.
      orderBy: [{ status: "desc" }, { dueAt: { sort: "asc", nulls: "last" } }, { id: "asc" }],
      include: { meeting: { select: { id: true, title: true, startedAt: true } } },
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 0 } : {}),
    }),
    prisma.actionItem.count({ where }),
  ]);
  const items = rows.slice(0, limit);
  return { items, total, nextCursor: rows.length > limit ? rows[limit]!.id : null };
}

export async function updateActionItem(
  workspaceId: string,
  id: string,
  changes: { status?: "open" | "done"; dueAt?: string | null },
): Promise<boolean> {
  if (!id || id.length > MAX_ACTION_ID_LENGTH) throw new ValidationError("action item id is invalid");
  if (changes.status !== undefined && changes.status !== "open" && changes.status !== "done") {
    throw new ValidationError("status must be open or done");
  }
  if (changes.dueAt !== undefined && changes.dueAt !== null && Number.isNaN(Date.parse(changes.dueAt))) {
    throw new ValidationError("dueAt must be an ISO 8601 string");
  }
  const result = await prisma.actionItem.updateMany({
    where: { id, meeting: { workspaceId } },
    data: {
      ...(changes.status ? { status: changes.status, completedAt: changes.status === "done" ? new Date() : null } : {}),
      ...(changes.dueAt !== undefined ? { dueAt: changes.dueAt ? new Date(changes.dueAt) : null } : {}),
    },
  });
  return result.count > 0;
}

export async function renameMeeting(workspaceId: string, id: string, title: string): Promise<boolean> {
  const trimmed = title.trim();
  if (!trimmed) throw new ValidationError("title is required");
  if (trimmed.length > MAX_TITLE_LENGTH) throw new ValidationError(`title must be ${MAX_TITLE_LENGTH} characters or fewer`);
  const result = await prisma.meeting.updateMany({ where: { id, workspaceId }, data: { title: trimmed } });
  return result.count > 0;
}

export async function deleteMeeting(workspaceId: string, id: string): Promise<void> {
  const meeting = await prisma.meeting.findFirst({
    where: { id, workspaceId },
    select: {
      recordingObjectKey: true,
      uploads: { select: { objectKey: true, chunks: { select: { objectKey: true } } } },
    },
  });
  if (!meeting) return;

  const objectKeys = [
    meeting.recordingObjectKey,
    ...meeting.uploads.flatMap((upload) => [upload.objectKey, ...upload.chunks.map((chunk) => chunk.objectKey)]),
  ].filter((key): key is string => Boolean(key));

  // Delete the database record first so a successful user-visible delete can
  // never leave a recoverable meeting behind. Object storage is separate from
  // Postgres, so clean it up after the cascading delete and log any orphaned
  // object for operator repair rather than turning a completed delete into a
  // misleading 500 response.
  await prisma.meeting.deleteMany({ where: { id, workspaceId } });
  const cleanup = await Promise.allSettled(objectKeys.map((key) => deleteObject(key)));
  const failures = cleanup.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length) {
    console.error("meeting object cleanup failed", {
      meetingId: id,
      workspaceId,
      failedObjects: failures.length,
      firstError: failures[0]?.reason instanceof Error ? failures[0].reason.message : String(failures[0]?.reason),
    });
  }
}
