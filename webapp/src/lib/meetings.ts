import { prisma } from "./db";
import { LOCAL_USER_ID } from "./auth";
import type { CreateMeetingRequest, MeetingDetailResponse, MeetingSummaryResponse } from "./types";

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
const MAX_OFFSET = 100_000;

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
  if (body.summary.length > MAX_SUMMARY_LENGTH) {
    throw new ValidationError(`summary must be ${MAX_SUMMARY_LENGTH} characters or fewer`);
  }
  if (!Array.isArray(body.transcript) || body.transcript.length > MAX_TRANSCRIPT_SEGMENTS) {
    throw new ValidationError("transcript must be an array");
  }
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
  }
  if (!Array.isArray(body.actionItems) || body.actionItems.length > MAX_ACTION_ITEMS) {
    throw new ValidationError("actionItems must be an array");
  }
  for (const item of body.actionItems) {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof (item as Record<string, unknown>).text !== "string" ||
      (item as Record<string, string>).text.length > MAX_ACTION_TEXT_LENGTH ||
      ((item as Record<string, unknown>).owner !== undefined &&
        (typeof (item as Record<string, unknown>).owner !== "string" ||
          (item as Record<string, string>).owner.length > MAX_OWNER_LENGTH))
    ) {
      throw new ValidationError("each action item needs text");
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

export async function upsertMeeting(rawInput: unknown): Promise<{ id: string; title: string }> {
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
        title,
        startedAt: new Date(input.startedAt),
        endedAt: new Date(input.endedAt),
        summary: input.summary,
      },
      update: {
        title,
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
              meetingId: input.id,
              userId: LOCAL_USER_ID,
              text: item.text,
              owner: item.owner ?? null,
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

const MAX_SEARCH_LENGTH = 200;

export async function listMeetings(
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
    userId: LOCAL_USER_ID,
    ...(query
      ? {
          OR: [
            { title: { contains: query, mode: "insensitive" as const } },
            { summary: { contains: query, mode: "insensitive" as const } },
            { transcript: { some: { text: { contains: query, mode: "insensitive" as const } } } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.meeting.findMany({
      where,
      orderBy: { startedAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.meeting.count({ where }),
  ]);

  return {
    meetings: rows.map((row) => ({
      id: row.id,
      title: row.title,
      startedAt: row.startedAt.toISOString(),
      summaryPreview: row.summary.length > 200 ? `${row.summary.slice(0, 200)}…` : row.summary,
    })),
    total,
  };
}

export async function getMeeting(id: string): Promise<MeetingDetailResponse | null> {
  const row = await prisma.meeting.findFirst({
    where: { id, userId: LOCAL_USER_ID },
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
    transcript: row.transcript.map((segment) => ({
      speaker: segment.speaker,
      text: segment.text,
      timestamp: segment.timestamp.toISOString(),
    })),
    actionItems: row.actionItems.map((item) => ({ text: item.text, owner: item.owner })),
  };
}

export async function deleteMeeting(id: string): Promise<void> {
  await prisma.meeting.deleteMany({ where: { id, userId: LOCAL_USER_ID } });
}
