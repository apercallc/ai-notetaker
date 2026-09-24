import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "./db";
import { clearLoginFailures, isLoginThrottled, recordLoginFailure } from "./loginThrottle";

const TEST_PREFIX = `throttle-${randomUUID()}-`;
const email = (suffix: string): string => `${TEST_PREFIX}${suffix}@example.com`;

beforeEach(async () => {
  await prisma.loginThrottle.deleteMany({ where: { emailKey: { startsWith: TEST_PREFIX } } });
});

afterAll(async () => {
  await prisma.loginThrottle.deleteMany({ where: { emailKey: { startsWith: TEST_PREFIX } } });
});

describe("database-backed login throttle", () => {
  it("allows nine wrong guesses, then stops the tenth", async () => {
    const address = email("owner");
    for (let attempt = 0; attempt < 9; attempt += 1) {
      await recordLoginFailure(address);
      expect(await isLoginThrottled(address)).toBe(false);
    }
    await recordLoginFailure(address);
    expect(await isLoginThrottled(address)).toBe(true);
  });

  it("keeps counters isolated and normalizes email keys", async () => {
    const address = email("owner");
    await recordLoginFailure(address.toUpperCase());
    expect(await isLoginThrottled(`  ${address} `)).toBe(false);
    expect(await isLoginThrottled(email("someone-else"))).toBe(false);
  });

  it("clears the budget on a successful sign-in", async () => {
    const address = email("owner");
    for (let attempt = 0; attempt < 10; attempt += 1) await recordLoginFailure(address);
    expect(await isLoginThrottled(address)).toBe(true);

    await clearLoginFailures(address);
    expect(await isLoginThrottled(address)).toBe(false);
  });

  it("lets the window expire so a user is never locked out permanently", async () => {
    const address = email("owner");
    const start = Date.parse("2026-09-23T12:00:00.000Z");
    for (let attempt = 0; attempt < 10; attempt += 1) await recordLoginFailure(address, start);
    expect(await isLoginThrottled(address, start)).toBe(true);

    const afterWindow = start + 15 * 60 * 1000 + 1;
    expect(await isLoginThrottled(address, afterWindow)).toBe(false);
    await recordLoginFailure(address, afterWindow);
    expect(await isLoginThrottled(address, afterWindow)).toBe(false);
  });

  it("serializes concurrent failures instead of losing increments", async () => {
    const address = email("owner");
    const now = Date.parse("2026-09-23T12:00:00.000Z");
    await Promise.all(Array.from({ length: 10 }, () => recordLoginFailure(address, now)));
    expect(await isLoginThrottled(address, now)).toBe(true);
  });

  it("prunes expired addresses when new failures arrive", async () => {
    const oldAddress = email("expired");
    const currentAddress = email("current");
    const old = Date.parse("2026-09-23T12:00:00.000Z");
    const current = old + 15 * 60 * 1000 + 1;
    await recordLoginFailure(oldAddress, old);
    await recordLoginFailure(currentAddress, current);

    expect(await prisma.loginThrottle.findMany({ where: { emailKey: { startsWith: TEST_PREFIX } } })).toHaveLength(1);
    expect(await prisma.loginThrottle.findUnique({ where: { emailKey: currentAddress } })).not.toBeNull();
  });
});
