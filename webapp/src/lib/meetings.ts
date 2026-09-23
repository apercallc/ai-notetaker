import { prisma } from "./db";
import { LOCAL_USER_ID } from "./auth";
import { randomUUID } from "node:crypto";
import type { CreateMeetingRequest, MeetingDetailResponse, MeetingMode, MeetingSummaryResponse } from "./types";

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

export async function upsertMeeting(rawInput: unknown, workspaceId: string): Promise<{ id: string; title: string }> {
  const input = assertValid(rawInput);
  const title = input.title?.trim() ? input.title.trim() : defaultTitle(input.startedAt);

  await prisma.$transaction([
    prisma.transcriptSegment.deleteMany({ where: { meetingId: input.id } }),
    prisma.actionItem.deleteMany({ where: { meetingId: input.id } }),
    prisma.meeting.upsert({
      where: { id: input.id },
      create: {
        id: input.id,
        userId: LOCAL_USER_ID,
        workspaceId,
        title,
        mode: input.mode ?? "general",
        startedAt: new Date(input.startedAt),
        endedAt: new Date(input.endedAt),
        summary: input.summary,
      },
      update: {
        title,
        mode: input.mode ?? "general",
        startedAt: new Date(input.startedAt),
        endedAt: new Date(input.endedAt),
        summary: input.summary,
      },
    }),
    ...(input.transcript.length > 0
      ? [
          prisma.transcriptSegment.createMany({
            data: input.transcript.map((segment, index) => ({
              meetingId: input.id,
              userId: LOCAL_USER_ID,
              speaker: segment.speaker,
              text: segment.text,
              timestamp: new Date(segment.timestamp),
              order: index,
            })),
          }),
        ]
      : []),
    ...(input.actionItems.length > 0
      ? [
          prisma.actionItem.createMany({
            data: input.actionItems.map((item) => ({
              id: item.id ?? randomUUID(),
              meetingId: input.id,
              userId: LOCAL_USER_ID,
              text: item.text,
              owner: item.owner ?? null,
              status: item.status ?? "open",
              dueAt: item.dueAt ? new Date(item.dueAt) : null,
              completedAt: item.completedAt ? new Date(item.completedAt) : null,
            })),
          }),
        ]
      : []),
  ]);

  return { id: input.id, title };
}

export interface ListMeetingsOptions {
  query?: string;
  limit?: number;
  offset?: number;
}

export const MAX_SEARCH_LENGTH = 200;

export async function listMeetings(
  workspaceId: string,
  options: ListMeetingsOptions
): Promise<{ meetings: MeetingSummaryResponse[]; total: number }> {
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
      include: { actionItems: { where: { status: "open" }, select: { id: true } } },
    }),
    prisma.meeting.count({ where }),
  ]);

  return {
    meetings: rows.map((row) => ({
      id: row.id,
      title: row.title,
      startedAt: row.startedAt.toISOString(),
      summaryPreview: row.summary.length > 200 ? `${row.summary.slice(0, 200)}…` : row.summary,
      openActionItems: row.actionItems.length,
    })),
    total,
  };
}

export async function getMeeting(workspaceId: string, id: string): Promise<MeetingDetailResponse | null> {
  const row = await prisma.meeting.findFirst({
    where: { id, workspaceId },
    include: {
      transcript: { orderBy: { order: "asc" } },
      actionItems: true,
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

/**
 * A single meeting may carry up to MAX_ACTION_ITEMS (1,000), so an archive
 * of a few hundred meetings can hold six figures of rows — all of which the
 * unbounded version of this query loaded into memory and rendered as one
 * un-paginated list. The cap keeps the page responsive; the inbox is a
 * working list, not the archive, and the filter links narrow it further.
 */
export const MAX_ACTION_ITEMS_PER_PAGE = 500;

export async function listActionItems(workspaceId: string, status?: "open" | "done") {
  return prisma.actionItem.findMany({
    where: { meeting: { workspaceId }, ...(status ? { status } : {}) },
    orderBy: [{ status: "asc" }, { dueAt: "asc" }, { id: "asc" }],
    include: { meeting: { select: { id: true, title: true, startedAt: true } } },
    take: MAX_ACTION_ITEMS_PER_PAGE,
  });
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

export async function deleteMeeting(workspaceId: string, id: string): Promise<void> {
  await prisma.meeting.deleteMany({ where: { id, workspaceId } });
}
