/**
 * Throttles repeated failed sign-in attempts.
 *
 * A self-hosted instance sits on a guessable public Railway URL, and until
 * now `login` would evaluate an unlimited number of password guesses — the
 * only cost to an attacker was one scrypt call each. scrypt makes a *stolen
 * hash* expensive to crack offline; it does nothing to stop an online
 * guessing loop against the live form.
 *
 * Deliberately in-process rather than a new table or a Redis dependency:
 * the Railway template is one long-lived Node server with one deployment,
 * and the project's hard constraint is that deploying stays one click with
 * no new required configuration. The trade-off is explicit — counters reset
 * on redeploy, and this would not hold across horizontally scaled replicas.
 * If this app ever runs more than one instance, this needs to move into
 * Postgres.
 *
 * Keyed on the submitted email, not the client IP: the proxy chain in front
 * of a Railway deployment makes a claimed IP trivially spoofable via
 * `X-Forwarded-For`, so keying on it would let an attacker reset their own
 * budget at will *and* would let them lock a victim out by exhausting it.
 */

const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60 * 1000;
/** Bounds memory against an attacker cycling through invented addresses. */
const MAX_TRACKED_KEYS = 10_000;

type Attempts = { failures: number; firstFailureAt: number };

const attemptsByKey = new Map<string, Attempts>();

function normalize(email: string): string {
  return email.trim().toLocaleLowerCase();
}

function prune(now: number): void {
  for (const [key, attempts] of attemptsByKey) {
    if (now - attempts.firstFailureAt >= WINDOW_MS) attemptsByKey.delete(key);
  }
}

/** True when this email has burned through its attempt budget. */
export function isLoginThrottled(email: string, now: number = Date.now()): boolean {
  const attempts = attemptsByKey.get(normalize(email));
  if (!attempts) return false;
  if (now - attempts.firstFailureAt >= WINDOW_MS) {
    attemptsByKey.delete(normalize(email));
    return false;
  }
  return attempts.failures >= MAX_FAILURES;
}

export function recordLoginFailure(email: string, now: number = Date.now()): void {
  const key = normalize(email);
  const attempts = attemptsByKey.get(key);
  if (!attempts || now - attempts.firstFailureAt >= WINDOW_MS) {
    if (attemptsByKey.size >= MAX_TRACKED_KEYS) prune(now);
    // Still full of live entries: an attacker is cycling addresses faster
    // than they expire. Drop the oldest rather than growing without bound;
    // losing one counter is better than exhausting the process's memory.
    if (attemptsByKey.size >= MAX_TRACKED_KEYS) {
      const oldest = attemptsByKey.keys().next();
      if (!oldest.done) attemptsByKey.delete(oldest.value);
    }
    attemptsByKey.set(key, { failures: 1, firstFailureAt: now });
    return;
  }
  attempts.failures += 1;
}

/** A correct password clears the budget immediately. */
export function clearLoginFailures(email: string): void {
  attemptsByKey.delete(normalize(email));
}

/** Test-only: the module-level map otherwise leaks state between cases. */
export function resetLoginThrottleForTests(): void {
  attemptsByKey.clear();
}
