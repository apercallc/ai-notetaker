import { NextResponse } from "next/server";
import { apiErrorResponse, requestIdFrom } from "@/lib/apiErrors";
import { getManagedSession, managedUnauthorized } from "@/lib/managedAuth";
import { readManagedJson } from "@/lib/managedJobs";
import { upsertMeeting } from "@/lib/meetings";

export async function POST(request: Request) {
  const requestId = requestIdFrom(request);
  const session = await getManagedSession(request);
  if (!session) return managedUnauthorized(requestId);
  try {
    const body = await readManagedJson(request);
    const result = await upsertMeeting(body, session.workspaceId, session.userId);
    return NextResponse.json(result, { status: 201, headers: { "x-request-id": requestId } });
  } catch (error) {
    return apiErrorResponse(error, { requestId });
  }
}
