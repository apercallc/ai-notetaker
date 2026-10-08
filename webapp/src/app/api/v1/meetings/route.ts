import { NextResponse } from "next/server";
import { apiErrorResponse, requestIdFrom } from "@/lib/apiErrors";
import { getManagedSession, managedUnauthorized } from "@/lib/managedAuth";
import { readManagedJson } from "@/lib/managedJobs";
import { upsertMeeting } from "@/lib/meetings";
import { SYNC_SUBSCRIPTION_REQUIRED_MESSAGE } from "@/lib/syncAccess";
import { writeBlock } from "@/lib/workspaceAccess";

export async function POST(request: Request) {
  const requestId = requestIdFrom(request);
  const session = await getManagedSession(request);
  if (!session) return managedUnauthorized(requestId);
  try {
    if (await writeBlock(session.workspaceId)) {
      return NextResponse.json(
        { error: SYNC_SUBSCRIPTION_REQUIRED_MESSAGE, requestId },
        { status: 402, headers: { "x-request-id": requestId } },
      );
    }
    const body = await readManagedJson(request);
    const result = await upsertMeeting(body, session.workspaceId, session.userId);
    return NextResponse.json(result, { status: 201, headers: { "x-request-id": requestId } });
  } catch (error) {
    return apiErrorResponse(error, { requestId });
  }
}
