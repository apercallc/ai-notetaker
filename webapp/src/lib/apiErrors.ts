import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { ValidationError } from "./meetings";

type ErrorResponseOptions = {
  requestId?: string;
  fallbackMessage?: string;
};

function safeRequestId(value: string | null | undefined): string {
  const candidate = value?.trim();
  return candidate && candidate.length <= 128 ? candidate : randomUUID();
}

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
  return NextResponse.json(
    { error: options.fallbackMessage ?? "internal server error", requestId },
    { status: 500, headers: { "x-request-id": requestId } },
  );
}

export function requestIdFrom(request: Request): string {
  return safeRequestId(request.headers.get("x-request-id"));
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
