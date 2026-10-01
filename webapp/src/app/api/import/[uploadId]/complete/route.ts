import { NextResponse } from "next/server";
import { apiErrorResponse, requestIdFrom } from "@/lib/apiErrors";
import { getBrowserManagedSession, managedUnauthorized } from "@/lib/managedAuth";
import { finishImport } from "@/lib/fileImport";

export async function POST(request: Request, context: { params: Promise<{ uploadId: string }> }) {
  const requestId = requestIdFrom(request);
  const session = await getBrowserManagedSession(request);
  if (!session) return managedUnauthorized(requestId);
  try {
    const { uploadId } = await context.params;
    const result = await finishImport(session, uploadId);
    return NextResponse.json(result, { status: 202, headers: { "x-request-id": requestId } });
  } catch (error) {
    return apiErrorResponse(error, { requestId });
  }
}
