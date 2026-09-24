import { randomUUID } from "node:crypto";
import { prisma } from "./db";
import { getObject } from "./objectStorage";
import { releaseMeetingProcessing } from "./usageLedger";
import { expireManagedMeetings, expireManagedUploads } from "./managedJobs";

export class ManagedWorkerError extends Error {}

export interface ManagedTranscript {
  speaker: "you" | "them";
  text: string;
}

export interface ManagedSummary {
  summary: string;
  actionItems: { text: string; owner?: string }[];
}

export interface ManagedJobClaim {
  jobId: string;
  workspaceId: string;
}

/** A crashed worker must not strand a hosted meeting forever. */
export const MANAGED_JOB_LEASE_MS = 15 * 60 * 1_000;
const PROVIDER_REQUEST_TIMEOUT_MS = 60_000;
const PROVIDER_MAX_ATTEMPTS = 3;

function providerRetryable(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function providerRetryDelay(response: Response | undefined, attempt: number): number {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 5_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), 5_000);
  }
  return Math.min(250 * 2 ** attempt, 2_000);
}

function waitForProviderRetry(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Provider calls are bounded and retried only for transient failures. */
export async function providerRequest(input: string, init: RequestInit, label: string): Promise<Response> {
  for (let attempt = 0; attempt < PROVIDER_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROVIDER_REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(input, { ...init, signal: controller.signal });
    } catch (error) {
      clearTimeout(timer);
      if (attempt === PROVIDER_MAX_ATTEMPTS - 1) {
        throw new ManagedWorkerError(error instanceof Error && error.name === "AbortError" ? `${label} provider request timed out` : `${label} provider request failed`);
      }
      await waitForProviderRetry(providerRetryDelay(undefined, attempt));
      continue;
    }
    clearTimeout(timer);
    if (response.ok) return response;
    if (!providerRetryable(response.status) || attempt === PROVIDER_MAX_ATTEMPTS - 1) {
      throw new ManagedWorkerError(`${label} provider returned ${response.status}`);
    }
    await waitForProviderRetry(providerRetryDelay(response, attempt));
  }
  throw new ManagedWorkerError(`${label} provider request failed`);
}

export function parseDeepgramTranscript(value: unknown, speaker: "you" | "them"): ManagedTranscript | null {
  if (typeof value !== "object" || value === null) return null;
  const root = value as { results?: { channels?: { alternatives?: { transcript?: unknown }[] }[] } };
  const text = root.results?.channels?.[0]?.alternatives?.[0]?.transcript;
  if (typeof text !== "string" || !text.trim()) return null;
  return { speaker, text: text.trim() };
}

export function parseSummary(value: unknown): ManagedSummary {
  if (typeof value !== "object" || value === null) throw new ManagedWorkerError("summary response is not an object");
  const root = value as { summary?: unknown; actionItems?: unknown };
  if (typeof root.summary !== "string") throw new ManagedWorkerError("summary response is missing summary text");
  const actionItems = Array.isArray(root.actionItems)
    ? root.actionItems.flatMap((item) => {
        if (typeof item !== "object" || item === null || typeof (item as { text?: unknown }).text !== "string") return [];
        const owner = (item as { owner?: unknown }).owner;
        return [{ text: (item as { text: string }).text.slice(0, 2_000), ...(typeof owner === "string" ? { owner: owner.slice(0, 200) } : {}) }];
      })
    : [];
  return { summary: root.summary.slice(0, 100_000), actionItems: actionItems.slice(0, 1_000) };
}

async function transcribe(bytes: Uint8Array, speaker: "you" | "them"): Promise<ManagedTranscript | null> {
  const key = process.env.MANAGED_DEEPGRAM_API_KEY;
  if (!key) throw new ManagedWorkerError("MANAGED_DEEPGRAM_API_KEY is not configured");
  const response = await providerRequest("https://api.deepgram.com/v1/listen?model=nova-3&encoding=linear16&sample_rate=48000&channels=1&diarize=true", {
    method: "POST",
    headers: { Authorization: `Token ${key}`, "Content-Type": "audio/l16" },
    body: bytes.buffer as ArrayBuffer,
  }, "transcription");
  return parseDeepgramTranscript(await response.json(), speaker);
}

async function summarize(transcript: ManagedTranscript[]): Promise<ManagedSummary> {
  const key = process.env.MANAGED_ANTHROPIC_API_KEY;
  if (!key) throw new ManagedWorkerError("MANAGED_ANTHROPIC_API_KEY is not configured");
  const response = await providerRequest("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.MANAGED_SUMMARY_MODEL ?? "claude-3-5-haiku-latest",
      max_tokens: 2_000,
      system: "Return only JSON with keys summary (string) and actionItems (array of objects with text and optional owner).",
      messages: [{ role: "user", content: transcript.map((segment) => `${segment.speaker}: ${segment.text}`).join("\n") }],
    }),
  }, "summary");
  const body = (await response.json()) as { content?: { text?: unknown }[] };
  const text = body.content?.map((item) => (typeof item.text === "string" ? item.text : "")).join("").trim();
  if (!text) throw new ManagedWorkerError("summary provider returned no text");
  return parseSummary(JSON.parse(text.replace(/^```json\s*|\s*```$/g, "")));
}

/**
 * Returns the oldest queued job for an external scheduler. The final claim is
 * still performed by `runManagedJob`, so multiple scheduler requests remain
 * safe and only one can execute provider calls for a job.
 */
export async function nextManagedJob(): Promise<ManagedJobClaim | null> {
  // The worker is the always-on managed process, so use its poll as the
  // bounded cleanup heartbeat for abandoned private audio uploads as well.
  await expireManagedUploads();
  await expireManagedMeetings();
  const staleBefore = new Date(Date.now() - MANAGED_JOB_LEASE_MS);
  const job = await prisma.processingJob.findFirst({
    where: {
      OR: [
        { status: "queued" },
        { status: "processing", startedAt: { lt: staleBefore } },
        { status: "processing", startedAt: null },
      ],
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, workspaceId: true },
  });
  return job ? { jobId: job.id, workspaceId: job.workspaceId } : null;
}

export async function runManagedJob(workspaceId: string, jobId: string): Promise<void> {
  // Claim in the database before reading any objects. The request dispatcher,
  // a retry worker, and a second web instance may all observe the same queued
  // job. The advisory lock closes the small race between two transactions
  // reading the same queued row; the conditional update handles a later
  // retry after the first transaction has committed.
  const staleBefore = new Date(Date.now() - MANAGED_JOB_LEASE_MS);
  const leaseToken = randomUUID();
  const claimedAt = new Date();
  const job = await prisma.$transaction(async (tx) => {
    const lock = await tx.$queryRaw<Array<{ locked: boolean }>>`
      SELECT pg_try_advisory_xact_lock(hashtextextended(${jobId}, 0)) AS locked
    `;
    if (!lock[0]?.locked) return null;
    const claimed = await tx.processingJob.updateMany({
      // Failed jobs are re-queued by enqueueManagedJob after a bounded retry
      // decision. Do not claim `error` here: a fast provider failure could
      // otherwise let a second concurrent poll immediately start the same
      // job again after the first worker records its error.
      where: {
        id: jobId,
        workspaceId,
        OR: [
          { status: "queued" },
          { status: "processing", startedAt: { lt: staleBefore } },
          { status: "processing", startedAt: null },
        ],
      },
      data: { status: "processing", startedAt: claimedAt, leaseToken, errorMessage: null },
    });
    if (claimed.count !== 1) return null;
    return tx.processingJob.findUnique({
      where: { id: jobId },
      include: {
        meeting: { select: { userId: true } },
        upload: { include: { chunks: { orderBy: { chunkIndex: "asc" } } } },
      },
    });
  });
  if (!job) throw new ManagedWorkerError("job not found or already running");
  try {
    const channelBytes = new Map<string, Uint8Array>();
    for (const channel of ["mic", "speaker"]) {
      const chunks = job.upload.chunks.filter((chunk) => chunk.channel === channel);
      const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        const bytes = await getObject(chunk.objectKey);
        merged.set(bytes, offset);
        offset += bytes.byteLength;
      }
      channelBytes.set(channel, merged);
    }
    const transcript = (await Promise.all([
      channelBytes.get("mic")?.byteLength ? transcribe(channelBytes.get("mic")!, "you") : Promise.resolve(null),
      channelBytes.get("speaker")?.byteLength ? transcribe(channelBytes.get("speaker")!, "them") : Promise.resolve(null),
    ])).filter((segment): segment is ManagedTranscript => segment !== null);
    const summary = await summarize(transcript);
    await prisma.$transaction(async (tx) => {
      // Finalize only if this worker still owns the lease. The conditional
      // update is inside the same transaction as the meeting writes, so a
      // reclaimed stale worker cannot overwrite a newer attempt's result.
      const finalized = await tx.processingJob.updateMany({
        where: { id: job.id, workspaceId, status: "processing", leaseToken },
        data: { status: "complete", completedAt: new Date() },
      });
      if (finalized.count !== 1) throw new ManagedWorkerError("managed job lease was lost");
      await tx.transcriptSegment.deleteMany({ where: { meetingId: job.meetingId } });
      await tx.actionItem.deleteMany({ where: { meetingId: job.meetingId } });
      await tx.meeting.update({ where: { id: job.meetingId }, data: { summary: summary.summary, endedAt: new Date(), processingMode: "managed" } });
      if (transcript.length) {
        await tx.transcriptSegment.createMany({ data: transcript.map((segment, order) => ({ meetingId: job.meetingId, userId: job.meeting.userId, speaker: segment.speaker, text: segment.text, timestamp: new Date(), order })) });
      }
      if (summary.actionItems.length) {
        await tx.actionItem.createMany({ data: summary.actionItems.map((item) => ({ meetingId: job.meetingId, userId: job.meeting.userId, text: item.text, owner: item.owner ?? null })) });
      }
    });
  } catch (error) {
    if (error instanceof ManagedWorkerError && error.message === "managed job lease was lost") throw error;
    const message = error instanceof Error ? error.message : "managed processing failed";
    const failed = await prisma.processingJob.updateMany({
      where: { id: job.id, workspaceId, status: "processing", leaseToken },
      data: { status: "error", errorMessage: message },
    });
    if (failed.count !== 1) throw new ManagedWorkerError("managed job lease was lost");
    try {
      await releaseMeetingProcessing(workspaceId, job.idempotencyKey);
    } catch (releaseError) {
      console.error("managed usage release failed", {
        workspaceId,
        jobId: job.id,
        error: releaseError instanceof Error ? releaseError.message : String(releaseError),
      });
    }
    throw error;
  }
}
