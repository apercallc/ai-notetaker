import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { apiErrorResponse, requestIdFrom } from "@/lib/apiErrors";
import { getManagedSession, managedUnauthorized } from "@/lib/managedAuth";

export async function GET(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const requestId = requestIdFrom(request);
  const session = await getManagedSession(request);
  if (!session) return managedUnauthorized(requestId);
  try {
    const { jobId } = await context.params;
    const job = await prisma.processingJob.findFirst({
      where: { id: jobId, workspaceId: session.workspaceId },
      select: {
        id: true,
        meetingId: true,
        status: true,
        errorMessage: true,
        createdAt: true,
        startedAt: true,
        completedAt: true,
        meeting: { select: { summary: true, actionItems: { select: { text: true, owner: true } } } },
      },
    });
    if (!job) return NextResponse.json({ error: "job not found" }, { status: 404, headers: { "x-request-id": requestId } });
    return NextResponse.json({ jobId: job.id, meetingId: job.meetingId, status: job.status, message: job.errorMessage, createdAt: job.createdAt, startedAt: job.startedAt, completedAt: job.completedAt, ...(job.status === "complete" ? { meeting: job.meeting } : {}) }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return apiErrorResponse(error, { requestId });
  }
}
