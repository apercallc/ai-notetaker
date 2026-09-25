import { NextResponse } from "next/server";
import { requestIdFrom } from "@/lib/apiErrors";
import { runManagedJob } from "@/lib/managedWorker";
import { managedHostingEnabled } from "@/lib/managedAuth";
import { isValidWorkerToken } from "@/lib/secureCompare";

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const requestId = requestIdFrom(request);
  if (!managedHostingEnabled()) return NextResponse.json({ error: "managed hosting is disabled", requestId }, { status: 404, headers: { "x-request-id": requestId } });
  if (!isValidWorkerToken(request.headers.get("x-worker-token"))) {
    return NextResponse.json({ error: "worker authentication required", requestId }, { status: 401, headers: { "x-request-id": requestId } });
  }
  const { jobId } = await context.params;
  const workspaceId = request.headers.get("x-workspace-id");
  if (!workspaceId) return NextResponse.json({ error: "workspace is required", requestId }, { status: 400, headers: { "x-request-id": requestId } });
  try {
    await runManagedJob(workspaceId, jobId);
    return NextResponse.json({ jobId, status: "complete" }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    console.error("managed job request failed", {
      requestId,
      workspaceId,
      jobId,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: "managed processing failed", requestId }, { status: 500, headers: { "x-request-id": requestId } });
  }
}
