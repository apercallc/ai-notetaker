import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;

/**
 * Stored shape is `<salt-hex>:<derived-key-hex>` — self-contained, no
 * separate column needed for the salt. scrypt (not a general hash
 * function) is deliberately slow/memory-hard to make brute-forcing a
 * stolen hash expensive; matches this project's existing preference for
 * node:crypto over adding a bcrypt/argon2 dependency (see lib/auth.ts's
 * hand-rolled timingSafeEqual comparison).
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derivedKey = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;
  return `${salt.toString("hex")}:${derivedKey.toString("hex")}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [saltHex, keyHex] = storedHash.split(":");
  if (!saltHex || !keyHex) return false;
  let salt: Buffer;
  let expectedKey: Buffer;
  try {
    salt = Buffer.from(saltHex, "hex");
    expectedKey = Buffer.from(keyHex, "hex");
  } catch {
    return false;
  }
  const derivedKey = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;
  if (derivedKey.length !== expectedKey.length) return false;
  return timingSafeEqual(derivedKey, expectedKey);
}
