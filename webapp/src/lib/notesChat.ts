import { speakerLabel } from "./types";
import { prisma } from "./db";
import { ManagedWorkerError, managedSummaryModel, managedSummaryProvider, providerRequest } from "./managedWorker";
import { releaseChatQuestion, reserveChatQuestion } from "./chatQuota";
import { MAX_QUESTION_LENGTH, buildContext, buildUserPrompt, chatSystemPrompt, citedNumbers, extractTerms, newBoundaryTag, type NoteSource } from "./notesChatContext";

const CANDIDATE_LIMIT = 300;
const TOP_MEETINGS = 12;
const MAX_IN_FLIGHT_PER_WORKSPACE = 3;
const RECENT_FALLBACK = 5;
const EXCERPTS_PER_MEETING = 6;
const ANSWER_MAX_TOKENS = 2_048;

export class InvalidQuestionError extends Error {}
export class ChatProviderError extends Error {}
export class ChatBusyError extends Error {
  constructor() {
    super("Still answering your earlier questions. Wait for them to finish, then ask again.");
    this.name = "ChatBusyError";
  }
}

/**
 * Caps simultaneous provider calls per workspace. A timed-out call is refunded
 * but may still be billed upstream, so unbounded retries must not be possible.
 * Per-instance, which is enough to bound a single client's burst.
 */
const inFlight = new Map<string, number>();

export interface ChatAnswer {
  answer: string;
  sources: { n: number; id: string; title: string; startedAt: string }[];
}

type Insensitive = { contains: string; mode: "insensitive" };

function countHits(text: string, terms: string[]): number {
  const lower = text.toLowerCase();
  return terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0);
}

/**
 * Finds the notes most likely to answer a question, strictly inside one
 * workspace. Retrieval is keyword based (no new database extension, so the
 * one-click self-hosted install is unaffected): meetings whose title, summary,
 * action items or transcript mention the question's terms are ranked by how
 * many terms they hit, with matching transcript lines as evidence. A question
 * with no usable terms ("what happened last week?") falls back to the most
 * recent meetings.
 */
export async function retrieveNotes(workspaceId: string, question: string): Promise<NoteSource[]> {
  const terms = extractTerms(question);
  const include = (filter: Insensitive[]) => ({
    actionItems: { select: { text: true }, take: 10 },
    speakers: { select: { speakerKey: true, displayName: true } },
    transcript: {
      where: filter.length ? { OR: filter.map((contains) => ({ text: contains })) } : undefined,
      orderBy: { order: "asc" as const },
      take: filter.length ? EXCERPTS_PER_MEETING : 0,
      select: { speaker: true, text: true },
    },
  });

  if (terms.length > 0) {
    const filters: Insensitive[] = terms.map((term) => ({ contains: term, mode: "insensitive" }));
    // Phase 1: rank a wide, cheap candidate set (counts only, no transcript text)
    // so an old but highly relevant meeting is not cut off by recency.
    const candidates = await prisma.meeting.findMany({
      where: {
        workspaceId,
        OR: [
          ...filters.map((contains) => ({ title: contains })),
          ...filters.map((contains) => ({ summary: contains })),
          ...filters.map((contains) => ({ actionItems: { some: { text: contains } } })),
          ...filters.map((contains) => ({ transcript: { some: { text: contains } } })),
        ],
      },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: CANDIDATE_LIMIT,
      select: {
        id: true,
        title: true,
        summary: true,
        startedAt: true,
        _count: {
          select: {
            actionItems: { where: { OR: filters.map((contains) => ({ text: contains })) } },
            transcript: { where: { OR: filters.map((contains) => ({ text: contains })) } },
          },
        },
      },
    });
    if (candidates.length > 0) {
      const top = candidates
        .map((row) => ({
          id: row.id,
          score:
            countHits(row.title, terms) * 3 +
            countHits(row.summary, terms) * 2 +
            Math.min(row._count.actionItems, 5) +
            Math.min(row._count.transcript, 10),
          startedAt: row.startedAt.getTime(),
        }))
        .sort((a, b) => b.score - a.score || b.startedAt - a.startedAt)
        .slice(0, TOP_MEETINGS);
      // Phase 2: load evidence for the winners only, keeping rank order.
      const rows = await prisma.meeting.findMany({
        where: { workspaceId, id: { in: top.map((entry) => entry.id) } },
        select: { id: true, title: true, startedAt: true, summary: true, ...include(filters) },
      });
      const byId = new Map(rows.map((row) => [row.id, row]));
      return top.flatMap((entry) => {
        const row = byId.get(entry.id);
        return row ? [toSource(row)] : [];
      });
    }
  }

  const recent = await prisma.meeting.findMany({
    where: { workspaceId },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    take: RECENT_FALLBACK,
    select: { id: true, title: true, startedAt: true, summary: true, ...include([]) },
  });
  return recent.map(toSource);
}

function toSource(row: {
  id: string;
  title: string;
  startedAt: Date;
  summary: string;
  actionItems: { text: string }[];
  transcript: { speaker: string; text: string }[];
  speakers: { speakerKey: string; displayName: string }[];
}): NoteSource {
  const names = Object.fromEntries(row.speakers.map((speaker) => [speaker.speakerKey, speaker.displayName]));
  return {
    id: row.id,
    title: row.title,
    startedAt: row.startedAt.toISOString(),
    summary: row.summary,
    actionItems: row.actionItems.map((item) => item.text),
    excerpts: row.transcript.map((line) => ({ speaker: speakerLabel(line.speaker, names), text: line.text })),
  };
}

function textFromProvider(provider: "openai" | "anthropic", body: unknown): string {
  const root = body as { content?: { type?: string; text?: string }[]; output?: { content?: { type?: string; text?: string }[] }[] };
  const parts =
    provider === "anthropic"
      ? (root.content ?? [])
      : (root.output ?? []).flatMap((item) => item.content ?? []);
  return parts
    .filter((part) => typeof part.text === "string" && (part.type === "text" || part.type === "output_text"))
    .map((part) => part.text as string)
    .join("")
    .trim();
}

async function askProvider(question: string, contextText: string): Promise<string> {
  const tag = newBoundaryTag();
  const system = chatSystemPrompt(tag);
  const provider = managedSummaryProvider();
  const key = provider === "openai" ? process.env.MANAGED_OPENAI_API_KEY : process.env.MANAGED_ANTHROPIC_API_KEY;
  if (!key) throw new ChatProviderError("chat provider is not configured");
  const model = process.env.MANAGED_CHAT_MODEL?.trim() || managedSummaryModel();
  const prompt = buildUserPrompt(question, contextText, tag);
  try {
    const response =
      provider === "openai"
        ? await providerRequest("https://api.openai.com/v1/responses", {
            method: "POST",
            headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
            body: JSON.stringify({ model, instructions: system, input: prompt, max_output_tokens: ANSWER_MAX_TOKENS, reasoning: { effort: "low" }, store: false }),
          }, "OpenAI chat", { timeoutMs: 45_000 })
        : await providerRequest("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
            body: JSON.stringify({ model, max_tokens: ANSWER_MAX_TOKENS, system, messages: [{ role: "user", content: prompt }] }),
          }, "Anthropic chat", { timeoutMs: 45_000 });
    const text = textFromProvider(provider, await response.json());
    if (!text) throw new ChatProviderError("chat provider returned no answer");
    return text;
  } catch (error) {
    if (error instanceof ChatProviderError) throw error;
    if (error instanceof ManagedWorkerError) throw new ChatProviderError(error.message);
    throw error;
  }
}

/**
 * Answers one question from the workspace's notes. Counts against the plan's
 * monthly question cap before any provider spend, and gives the question back
 * if the provider fails. Provider keys never leave the server.
 */
export async function askNotes(workspaceId: string, rawQuestion: string): Promise<ChatAnswer> {
  const question = rawQuestion.trim();
  if (!question) throw new InvalidQuestionError("Type a question first.");
  if (question.length > MAX_QUESTION_LENGTH) throw new InvalidQuestionError(`Keep questions under ${MAX_QUESTION_LENGTH} characters.`);

  if ((inFlight.get(workspaceId) ?? 0) >= MAX_IN_FLIGHT_PER_WORKSPACE) throw new ChatBusyError();
  inFlight.set(workspaceId, (inFlight.get(workspaceId) ?? 0) + 1);
  try {
    return await answer(workspaceId, question);
  } finally {
    const left = (inFlight.get(workspaceId) ?? 1) - 1;
    if (left <= 0) inFlight.delete(workspaceId);
    else inFlight.set(workspaceId, left);
  }
}

async function answer(workspaceId: string, question: string): Promise<ChatAnswer> {
  const reservation = await reserveChatQuestion(workspaceId);
  try {
    const { text, used } = buildContext(await retrieveNotes(workspaceId, question));
    const reply = await askProvider(question, text);
    const sources = citedNumbers(reply, used.length).map((n) => {
      const source = used[n - 1] as NoteSource;
      return { n, id: source.id, title: source.title, startedAt: source.startedAt };
    });
    return { answer: reply, sources };
  } catch (error) {
    await releaseChatQuestion(workspaceId, reservation).catch(() => undefined);
    throw error;
  }
}
