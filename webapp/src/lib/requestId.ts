import { randomUUID } from "node:crypto";

function safeRequestId(value: string | null | undefined): string {
  const candidate = value?.trim();
  return candidate && candidate.length <= 128 ? candidate : randomUUID();
}

/** Returns the caller's bounded correlation id or creates one for the request. */
export function requestIdFrom(request: Request): string {
  return safeRequestId(request.headers.get("x-request-id"));
}

export { safeRequestId };
