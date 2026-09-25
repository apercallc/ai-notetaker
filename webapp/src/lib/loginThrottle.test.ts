import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "./db";
import {
  clearLoginFailures,
  delayFor,
  emailRequestStatus,
  formatRetryAfter,
  isLoginThrottled,
  loginThrottleStatus,
  recordEmailRequest,
  recordLoginFailure,
  recordSignupAttempt,
  signupThrottleStatus,
  type ThrottleRule,
} from "./loginThrottle";

const TEST_PREFIX = `throttle-${randomUUID()}-`;
const email = (suffix: string): string => `${TEST_PREFIX}${suffix}@example.com`;
const IP = `10.9.8.${TEST_PREFIX.length % 200}`;
const START = Date.parse("2026-09-23T12:00:00.000Z");

// Real throttle keys embed the email (`login:email:<addr>`, `login:pair:...`)
// or are shared globals (`signup:global`, per-IP budgets), so cleanup must
// match on containment and clear the shared keys explicitly — otherwise
// counters leak between tests and even between runs.
async function clearThrottleRows(): Promise<void> {
  await prisma.loginThrottle.deleteMany({
    where: { OR: [{ emailKey: { contains: TEST_PREFIX } }, { emailKey: { in: ["signup:global", `login:ip:${IP}`, `signup:ip:${IP}`] } }] },
  });
}

beforeEach(async () => {
  await clearThrottleRows();
});

afterAll(async () => {
  await clearThrottleRows();
});

describe("delay escalation math", () => {
  const rule: ThrottleRule = { key: "t", free: 2, baseDelayMs: 1000, maxDelayMs: 8000, windowMs: 60_000 };

  it("is free below the budget, then doubles until the cap", () => {
    expect(delayFor(0, rule)).toBe(0);
    expect(delayFor(2, rule)).toBe(0);
    expect(delayFor(3, rule)).toBe(1000);
    expect(delayFor(4, rule)).toBe(2000);
    expect(delayFor(5, rule)).toBe(4000);
    expect(delayFor(6, rule)).toBe(8000);
    expect(delayFor(10_000, rule)).toBe(8000);
  });

  it("formats retry windows for humans", () => {
    expect(formatRetryAfter(1)).toBe("1 second");
    expect(formatRetryAfter(45_000)).toBe("45 seconds");
    expect(formatRetryAfter(90_000)).toBe("2 minutes");
  });
});

describe("database-backed login throttle", () => {
  it("allows the free budget, then requires an escalating wait", async () => {
    const address = email("owner");
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await recordLoginFailure(address);
      expect(await isLoginThrottled(address)).toBe(false);
    }
    await recordLoginFailure(address);
    const status = await loginThrottleStatus(address);
    expect(status.blocked).toBe(true);
    expect(status.retryAfterMs).toBeGreaterThan(0);
    expect(status.retryAfterMs).toBeLessThanOrEqual(15 * 60_000);
  });

  it("keeps counters isolated and normalizes email keys", async () => {
    const address = email("owner");
    await recordLoginFailure(address.toUpperCase());
    expect(await isLoginThrottled(`  ${address} `)).toBe(false);
    expect(await isLoginThrottled(email("someone-else"))).toBe(false);
  });

  it("clears the pair and email budgets on success but never the shared IP one", async () => {
    const address = email("owner");
    const other = email("other");
    const now = START;
    for (let attempt = 0; attempt < 31; attempt += 1) {
      await recordLoginFailure(address, { ip: IP, now });
    }
    expect(await isLoginThrottled(address, { ip: IP, now })).toBe(true);

    await clearLoginFailures(address, { ip: IP });
    expect(await isLoginThrottled(address, { now })).toBe(false);
    // The attacker on that IP is still throttled for other accounts.
    expect(await isLoginThrottled(other, { ip: IP, now })).toBe(true);
    // ...and from a different IP the freed account is reachable.
    expect(await isLoginThrottled(address, { ip: "10.1.1.1", now })).toBe(false);
  });

  it("throttles a pair faster than the email backstop alone", async () => {
    const address = email("pair");
    const now = START;
    for (let attempt = 0; attempt < 6; attempt += 1) await recordLoginFailure(address, { ip: IP, now });
    // Pair budget (free=5) exhausted: this exact ip+email must wait.
    expect((await loginThrottleStatus(address, { ip: IP, now })).blocked).toBe(true);
    // The email backstop (free=10) alone has not tripped yet.
    expect((await loginThrottleStatus(address, { now })).blocked).toBe(false);
  });

  it("lets delays expire so a user is never locked out permanently", async () => {
    const address = email("owner");
    for (let attempt = 0; attempt < 11; attempt += 1) await recordLoginFailure(address, { now: START });
    expect(await isLoginThrottled(address, { now: START })).toBe(true);

    const afterDelay = START + 31 * 1000;
    expect(await isLoginThrottled(address, { now: afterDelay })).toBe(false);
  });

  it("restarts the counter after the window passes with no activity", async () => {
    const address = email("window");
    for (let attempt = 0; attempt < 12; attempt += 1) await recordLoginFailure(address, { now: START });
    expect(await isLoginThrottled(address, { now: START })).toBe(true);

    const afterWindow = START + 30 * 60_000 + 1;
    await recordLoginFailure(address, { now: afterWindow });
    expect(await isLoginThrottled(address, { now: afterWindow })).toBe(false);
  });

  it("serializes concurrent failures instead of losing increments", async () => {
    const address = email("concurrent");
    const now = START;
    await Promise.all(Array.from({ length: 10 }, () => recordLoginFailure(address, { ip: IP, now })));
    expect((await loginThrottleStatus(address, { ip: IP, now })).blocked).toBe(true);
  });

  it("prunes stale rows when new failures arrive", async () => {
    const oldAddress = email("expired");
    const freshAddress = email("current");
    await recordLoginFailure(oldAddress, { now: START });
    await recordLoginFailure(freshAddress, { now: START + 3 * 60 * 60_000 });

    const rows = await prisma.loginThrottle.findMany({ where: { emailKey: { contains: TEST_PREFIX } } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.emailKey).toContain("current");
  });
});

describe("signup throttle", () => {
  it("lets a small burst through, then throttles that IP", async () => {
    const now = START;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await recordSignupAttempt({ ip: IP, now });
      expect((await signupThrottleStatus({ ip: IP, now })).blocked).toBe(false);
    }
    await recordSignupAttempt({ ip: IP, now });
    expect((await signupThrottleStatus({ ip: IP, now })).blocked).toBe(true);
    // A different IP is unaffected by this IP's budget.
    expect((await signupThrottleStatus({ ip: "10.2.3.4", now })).blocked).toBe(false);
  });

  it("counts every signup attempt toward the global budget", async () => {
    const now = START;
    for (let attempt = 0; attempt < 200; attempt += 1) await recordSignupAttempt({ now });
    expect((await signupThrottleStatus({ now })).blocked).toBe(false);
    await recordSignupAttempt({ now });
    expect((await signupThrottleStatus({ now })).blocked).toBe(true);
  });
});

describe("email request throttle", () => {
  it("allows a few password-reset requests then throttles that address", async () => {
    const address = email("resetter");
    const now = START;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await recordEmailRequest("reset", address, { ip: IP, now });
      expect((await emailRequestStatus("reset", address, { ip: IP, now })).blocked).toBe(false);
    }
    await recordEmailRequest("reset", address, { ip: IP, now });
    expect((await emailRequestStatus("reset", address, { ip: IP, now })).blocked).toBe(true);
    // Verification requests have their own budget.
    expect((await emailRequestStatus("verify", address, { ip: IP, now })).blocked).toBe(false);
  });
});