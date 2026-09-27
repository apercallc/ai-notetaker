import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time string equality. Both values are hashed first so the
 * comparison always runs over equal-length buffers and never leaks the length
 * of the expected secret through timing or an exception.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

/**
 * The single worker-token check shared by proxy.ts, jobs/next and
 * jobs/[jobId]/run. Fails closed when MANAGED_WORKER_TOKEN is unset or empty.
 */
export function isValidWorkerToken(provided: string | null | undefined, env: Record<string, string | undefined> = process.env): boolean {
  const expected = env.MANAGED_WORKER_TOKEN;
  if (!expected || !provided) return false;
  return safeEqual(provided, expected);
}
