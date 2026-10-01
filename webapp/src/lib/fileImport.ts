import { prisma } from "./db";
import { recordAudit } from "./audit";
import { getEntitlements } from "./usageLedger";
import { completeManagedUpload, createManagedUpload, enqueueManagedJob, getUpload, ManagedValidationError } from "./managedJobs";
import { dispatchManagedJob } from "./managedDispatch";
import { upsertMeeting } from "./meetings";
import { IMPORT_CHUNK_BYTES, IMPORT_MAX_BYTES, importFormatFromName } from "./importFormats";
import { mediaToolsAvailable } from "./mediaDecode";
import { estimateImportSeconds, isManagedPlan, PLAN_IMPORT_MAX_SECONDS } from "./plans";
import type { ManagedSession } from "./managedAuth";

const MAX_TITLE_LENGTH = 200;
const MAX_FILE_NAME_LENGTH = 300;
const TEN_YEARS_MS = 10 * 365 * 24 * 3_600 * 1_000;

export interface StartImportInput {
  meetingId: string;
  idempotencyKey: string;
  fileName: string;
  totalBytes: number;
  /** Duration the browser read from the file; an estimate only. */
  durationSeconds?: number;
  title?: string;
  /** File's last-modified time, used as the meeting date when plausible. */
  recordedAtMs?: number;
}

export function importUploadChunks(totalBytes: number): number {
  return Math.max(1, Math.ceil(totalBytes / IMPORT_CHUNK_BYTES));
}

/**
 * Whether this deployment can import, and what the caller's plan allows. Used
 * by the /import page to decide between the form and an explanation.
 */
export async function getImportCapability(workspaceId: string) {
  const entitlements = await getEntitlements(workspaceId);
  const maxSeconds = isManagedPlan(entitlements.plan) ? PLAN_IMPORT_MAX_SECONDS[entitlements.plan] : 0;
  const toolsReady = await mediaToolsAvailable();
  return {
    toolsReady,
    plan: entitlements.plan,
    planLabel: entitlements.planLabel,
    canProcess: entitlements.canProcess,
    maxSeconds,
    audioRemainingSeconds: entitlements.audio.remainingSeconds,
    audioLimitSeconds: entitlements.audio.limitSeconds,
    meetingsRemaining: entitlements.remaining,
  };
}

/**
 * Registers the meeting and a metered upload manifest for one imported file.
 * Idempotent on `idempotencyKey`, so a reloaded page resumes the same upload
 * and skips chunks the server already holds.
 */
export async function startImport(session: ManagedSession, input: StartImportInput) {
  if (!(await mediaToolsAvailable())) throw new ManagedValidationError("File import isn't available on this server.");
  const fileName = typeof input.fileName === "string" ? input.fileName.slice(0, MAX_FILE_NAME_LENGTH) : "";
  const format = importFormatFromName(fileName);
  if (!format) throw new ManagedValidationError("This file type isn't supported. Use an mp3, m4a, wav, ogg, flac, webm, mp4, mov or mkv file.");
  if (!Number.isSafeInteger(input.totalBytes) || input.totalBytes < 1) throw new ManagedValidationError("file size is invalid");
  if (input.totalBytes > IMPORT_MAX_BYTES) throw new ManagedValidationError("this file is too large to import");
  if (input.title !== undefined && (typeof input.title !== "string" || input.title.length > MAX_TITLE_LENGTH)) {
    throw new ManagedValidationError(`title must be ${MAX_TITLE_LENGTH} characters or fewer`);
  }

  const now = Date.now();
  const recordedAt = typeof input.recordedAtMs === "number" && Number.isFinite(input.recordedAtMs) && input.recordedAtMs <= now && input.recordedAtMs >= now - TEN_YEARS_MS
    ? new Date(input.recordedAtMs)
    : new Date(now);
  const declared = typeof input.durationSeconds === "number" && Number.isFinite(input.durationSeconds) && input.durationSeconds >= 1
    ? Math.ceil(input.durationSeconds)
    : undefined;

  // Check the plan before registering anything, so a refused import leaves no empty meeting behind.
  const capability = await getImportCapability(session.workspaceId);
  if (!capability.canProcess || capability.maxSeconds <= 0) {
    throw new ManagedValidationError("Your plan has no hosted processing left. See Plans & usage.");
  }

  const existed = Boolean(await prisma.meeting.findFirst({ where: { id: input.meetingId, workspaceId: session.workspaceId }, select: { id: true } }));
  await upsertMeeting(
    {
      id: input.meetingId,
      startedAt: recordedAt.toISOString(),
      endedAt: recordedAt.toISOString(),
      summary: "",
      transcript: [],
      actionItems: [],
      captureSource: "import",
      processingMode: "managed",
      ...(input.title?.trim() ? { title: input.title.trim() } : {}),
    },
    session.workspaceId,
    session.userId,
  );

  let upload;
  try {
    upload = await createManagedUpload(session.workspaceId, {
      meetingId: input.meetingId,
      idempotencyKey: input.idempotencyKey,
      totalChunks: importUploadChunks(input.totalBytes),
      totalBytes: input.totalBytes,
      kind: "import",
      sourceFormat: format,
      ...(declared !== undefined ? { declaredDurationSeconds: declared } : {}),
    });
  } catch (error) {
    // A refused import (plan limit, staging cap, bad duration) must not leave
    // the empty meeting it just registered in the user's list.
    if (!existed) {
      await prisma.meeting.deleteMany({
        where: { id: input.meetingId, workspaceId: session.workspaceId, captureSource: "import", summary: "", uploads: { none: {} }, processingJobs: { none: {} } },
      });
    }
    throw error;
  }
  if (!existed) {
    await recordAudit({ workspaceId: session.workspaceId, actorUserId: session.userId, action: "meeting.import", targetType: "meeting", targetId: input.meetingId, metadata: { format } });
  }
  return {
    uploadId: upload.id,
    meetingId: upload.meetingId,
    totalChunks: upload.totalChunks,
    chunkBytes: IMPORT_CHUNK_BYTES,
    receivedChunks: upload.chunks.map((chunk) => chunk.chunkIndex),
    estimatedSeconds: estimateImportSeconds(upload.totalBytes, upload.declaredDurationSeconds),
  };
}

/** Throws unless `uploadId` is an import upload in this workspace. */
export async function assertImportUpload(workspaceId: string, uploadId: string) {
  const upload = await getUpload(workspaceId, uploadId);
  if (!upload || upload.kind !== "import") throw new ManagedValidationError("upload not found");
  return upload;
}

/** Seals the upload, reserves usage, queues the job and nudges the worker. */
export async function finishImport(session: ManagedSession, uploadId: string) {
  const upload = await assertImportUpload(session.workspaceId, uploadId);
  const completed = await completeManagedUpload(session.workspaceId, uploadId);
  const job = await enqueueManagedJob(session.workspaceId, completed.meetingId, uploadId, `import:${uploadId}`);
  if (job.status === "queued") dispatchManagedJob(job.id, session.workspaceId);
  return { meetingId: upload.meetingId, jobId: job.id, status: job.status };
}

/** Test and cleanup helper: the import's meeting row, workspace-scoped. */
export async function findImportMeeting(workspaceId: string, meetingId: string) {
  return prisma.meeting.findFirst({ where: { id: meetingId, workspaceId, captureSource: "import" } });
}
