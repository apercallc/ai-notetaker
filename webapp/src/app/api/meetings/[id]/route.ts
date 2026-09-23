import { NextResponse } from "next/server";
import { getMeeting, deleteMeeting } from "@/lib/meetings";
import { getDefaultWorkspaceId } from "@/lib/workspaces";
import { apiErrorResponse, requestIdFrom } from "@/lib/apiErrors";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = requestIdFrom(request);
  try {
    const { id } = await params;
    const workspaceId = await getDefaultWorkspaceId();
    const meeting = await getMeeting(workspaceId, id);
    if (!meeting) {
      return NextResponse.json({ error: "not found", requestId }, { status: 404, headers: { "x-request-id": requestId } });
    }
    return NextResponse.json(meeting, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return apiErrorResponse(error, { requestId });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = requestIdFrom(request);
  try {
    const { id } = await params;
    const workspaceId = await getDefaultWorkspaceId();
    await deleteMeeting(workspaceId, id);
    return new NextResponse(null, { status: 204, headers: { "x-request-id": requestId } });
  } catch (error) {
    return apiErrorResponse(error, { requestId });
  }
}
