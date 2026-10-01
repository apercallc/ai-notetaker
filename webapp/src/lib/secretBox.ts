import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Authenticated encryption (AES-256-GCM) for secrets stored in the database,
 * such as an integration's webhook secret or Notion token. The key is
 * INTEGRATIONS_ENCRYPTION_KEY (32 random bytes, base64) when set; otherwise it
 * is derived from AUTH_TOKEN, which every deployment already has, so a
 * one-click install needs no extra setup. Rotating AUTH_TOKEN without setting
 * the dedicated key makes saved integrations undecryptable and they must be
 * re-entered; the failure is reported, never silent.
 */
const VERSION = "v1";

export class SecretBoxError extends Error {}

export function integrationsKey(env: Record<string, string | undefined> = process.env): Buffer {
  const dedicated = env.INTEGRATIONS_ENCRYPTION_KEY?.trim();
  if (dedicated) {
    const key = Buffer.from(dedicated, "base64");
    if (key.length !== 32) throw new SecretBoxError("INTEGRATIONS_ENCRYPTION_KEY must be 32 bytes, base64 encoded");
    return key;
  }
  if (env.MANAGED_HOSTING === "true") throw new SecretBoxError("Set INTEGRATIONS_ENCRYPTION_KEY: managed hosting does not derive it from AUTH_TOKEN");
  const seed = env.AUTH_TOKEN?.trim();
  if (!seed) throw new SecretBoxError("Set INTEGRATIONS_ENCRYPTION_KEY (or AUTH_TOKEN) to store integration secrets");
  return Buffer.from(hkdfSync("sha256", seed, "ai-notetaker", "integrations-v1", 32));
}

export function encryptSecret(plaintext: string, key: Buffer = integrationsKey()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptSecret(value: string, key: Buffer = integrationsKey()): string {
  const [version, iv, tag, ciphertext] = value.split(".");
  if (version !== VERSION || !iv || !tag || !ciphertext) throw new SecretBoxError("Stored secret is not readable");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretBoxError("Stored secret could not be decrypted");
  }
}
