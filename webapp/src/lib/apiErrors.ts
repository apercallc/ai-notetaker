import { NextResponse } from "next/server";
import { ValidationError } from "./meetings";
import { safeRequestId } from "./requestId";
import { captureServerError } from "./observability";

// Keep the existing route import path stable while allowing the proxy to use
// the dependency-light request-id utility without loading route validation or
// Prisma-backed meeting code.
export { requestIdFrom } from "./requestId";

type ErrorResponseOptions = {
  requestId?: string;
  fallbackMessage?: string;
};

/**
 * Keep API failures consistent and safe for clients. Validation failures are
 * actionable; unexpected failures are logged with a correlation id but never
 * expose database/provider internals to an untrusted caller.
 */
export function apiErrorResponse(
  error: unknown,
  options: ErrorResponseOptions = {},
): NextResponse {
  const requestId = safeRequestId(options.requestId);
  if (error instanceof ValidationError) {
    return NextResponse.json(
      { error: error.message },
      { status: 400, headers: { "x-request-id": requestId } },
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  console.error("api request failed", { requestId, error: message });
  // Unexpected failures (validation errors are not) go to Sentry with the
  // correlation id, so a user quoting the id maps to a captured event.
  captureServerError(error, { requestId });
  return NextResponse.json(
    { error: options.fallbackMessage ?? "internal server error", requestId },
    { status: 500, headers: { "x-request-id": requestId } },
  );
}

export function jsonError(
  message: string,
  status: number,
  requestId?: string,
): NextResponse {
  const id = safeRequestId(requestId);
  return NextResponse.json(
    { error: message, requestId: id },
    { status, headers: { "x-request-id": id } },
  );
}
