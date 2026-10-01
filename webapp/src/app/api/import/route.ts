import { NextResponse } from "next/server";
import { apiErrorResponse, jsonError, requestIdFrom } from "@/lib/apiErrors";
import { getBrowserManagedSession, managedUnauthorized } from "@/lib/managedAuth";
import { ManagedUploadQuotaError, ManagedValidationError, readManagedJson } from "@/lib/managedJobs";
import { startImport } from "@/lib/fileImport";

/** Browser-only (cookie session) entry point for importing an audio/video file. */
export async function POST(request: Request) {
  const requestId = requestIdFrom(request);
  const session = await getBrowserManagedSession(request);
  if (!session) return managedUnauthorized(requestId);
  try {
    const body = await readManagedJson(request);
    if (typeof body !== "object" || body === null) throw new ManagedValidationError("request body must be an object");
    const value = body as Record<string, unknown>;
    const started = await startImport(session, {
      meetingId: typeof value.meetingId === "string" ? value.meetingId : "",
      idempotencyKey: typeof value.idempotencyKey === "string" ? value.idempotencyKey : "",
      fileName: typeof value.fileName === "string" ? value.fileName : "",
      totalBytes: typeof value.totalBytes === "number" ? value.totalBytes : NaN,
      ...(typeof value.durationSeconds === "number" ? { durationSeconds: value.durationSeconds } : {}),
      ...(typeof value.title === "string" ? { title: value.title } : {}),
      ...(typeof value.recordedAtMs === "number" ? { recordedAtMs: value.recordedAtMs } : {}),
    });
    return NextResponse.json(started, { status: 201, headers: { "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof ManagedUploadQuotaError) return jsonError(error.message, 429, requestId);
    return apiErrorResponse(error, { requestId });
  }
}
