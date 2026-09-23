import { describe, expect, it } from "vitest";
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from "./passwords";

describe("hashPassword / verifyPassword", () => {
  it("verifies a password against its own hash", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
  });

  it("rejects the wrong password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("wrong password", hash)).toBe(false);
  });

  it("produces a different hash each time (random salt)", async () => {
    const first = await hashPassword("same password");
    const second = await hashPassword("same password");
    expect(first).not.toBe(second);
  });

  it("rejects a malformed stored hash instead of throwing", async () => {
    expect(await verifyPassword("anything", "not-a-valid-hash")).toBe(false);
  });

  it("DUMMY_PASSWORD_HASH never verifies against any password (used to pay scrypt's cost on an unknown-email login attempt)", async () => {
    expect(await verifyPassword("anything", DUMMY_PASSWORD_HASH)).toBe(false);
    expect(await verifyPassword("", DUMMY_PASSWORD_HASH)).toBe(false);
  });
});
