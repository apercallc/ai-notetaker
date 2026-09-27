// In-memory sliding-window limiter for public, unauthenticated lookups (the
// share-link page). It is per server process: with several web replicas each
// keeps its own window, so the effective ceiling is `limit × replicas`. That
// is fine for this purpose — share tokens are 256-bit random values, so this
// exists to bound abusive request volume against the database, not to be the
// only defence against guessing. Login attempts use the Postgres-backed
// `loginThrottle`, because those need a hard shared budget.

export interface SlidingWindowLimiter {
  /** Records a hit for `key` and reports whether it is within budget. */
  hit(key: string, now?: number): { allowed: boolean; retryAfterMs: number };
  /** Test hook. */
  clear(): void;
}

export function createSlidingWindowLimiter(options: { limit: number; windowMs: number; maxKeys?: number }): SlidingWindowLimiter {
  const { limit, windowMs, maxKeys = 10_000 } = options;
  const hits = new Map<string, number[]>();

  function prune(now: number): void {
    for (const [key, times] of hits) {
      const fresh = times.filter((time) => now - time < windowMs);
      if (fresh.length === 0) hits.delete(key);
      else hits.set(key, fresh);
    }
  }

  return {
    hit(key, now = Date.now()) {
      const times = (hits.get(key) ?? []).filter((time) => now - time < windowMs);
      if (times.length >= limit) {
        hits.set(key, times);
        return { allowed: false, retryAfterMs: Math.max(1, windowMs - (now - times[0]!)) };
      }
      times.push(now);
      hits.set(key, times);
      // Bound memory under a spray of distinct keys.
      if (hits.size > maxKeys) prune(now);
      return { allowed: true, retryAfterMs: 0 };
    },
    clear() {
      hits.clear();
    },
  };
}

const SHARE_LOOKUPS_PER_MINUTE = 60;
export const shareLookupLimiter = createSlidingWindowLimiter({ limit: SHARE_LOOKUPS_PER_MINUTE, windowMs: 60_000 });
