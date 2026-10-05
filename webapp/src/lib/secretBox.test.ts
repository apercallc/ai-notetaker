import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SecretBoxError, decryptSecret, encryptSecret, integrationsKey } from "./secretBox";

describe("secretBox", () => {
  const key = randomBytes(32);

  it("round-trips and never stores the plaintext", () => {
    const sealed = encryptSecret("whsec_super-secret", key);
    expect(sealed).not.toContain("whsec_super-secret");
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(decryptSecret(sealed, key)).toBe("whsec_super-secret");
  });

  it("uses a fresh nonce each time", () => {
    expect(encryptSecret("same", key)).not.toBe(encryptSecret("same", key));
  });

  it("rejects tampering, the wrong key and malformed input", () => {
    const sealed = encryptSecret("value", key);
    const [version, iv, tag, ciphertext] = sealed.split(".");
    const tamperedCiphertext = Buffer.from(ciphertext!, "base64url");
    tamperedCiphertext[0] ^= 1;
    expect(() => decryptSecret([version, iv, tag, tamperedCiphertext.toString("base64url")].join("."), key)).toThrow(SecretBoxError);
    expect(() => decryptSecret(sealed, randomBytes(32))).toThrow(SecretBoxError);
    expect(() => decryptSecret("nope", key)).toThrow(SecretBoxError);
    expect(() => decryptSecret(`v2.${iv}.${tag}.${ciphertext}`, key)).toThrow(SecretBoxError);
  });

  it("uses a dedicated key when set, else derives a stable key from AUTH_TOKEN", () => {
    const dedicated = randomBytes(32).toString("base64");
    expect(integrationsKey({ INTEGRATIONS_ENCRYPTION_KEY: dedicated, AUTH_TOKEN: "x" }).equals(Buffer.from(dedicated, "base64"))).toBe(true);
    const derived = integrationsKey({ AUTH_TOKEN: "deploy-token" });
    expect(derived).toHaveLength(32);
    expect(integrationsKey({ AUTH_TOKEN: "deploy-token" }).equals(derived)).toBe(true);
    expect(integrationsKey({ AUTH_TOKEN: "other-token" }).equals(derived)).toBe(false);
  });

  it("refuses a malformed dedicated key and a missing seed", () => {
    expect(() => integrationsKey({ INTEGRATIONS_ENCRYPTION_KEY: "c2hvcnQ=" })).toThrow(SecretBoxError);
    expect(() => integrationsKey({})).toThrow(SecretBoxError);
  });
});
