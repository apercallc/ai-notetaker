import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;

/**
 * A fixed, valid-shaped hash with no corresponding real password. Callers
 * verify against this when no user exists for a login attempt's email, so
 * an unknown-email request still pays scrypt's cost — without this, an
 * unknown email returns fast (no scrypt call) while a known email with a
 * wrong password returns slow (one scrypt call), letting an attacker
 * enumerate registered emails by measuring response time.
 */
export const DUMMY_PASSWORD_HASH =
  "8c35283cbf9ba5e3574ba04f1cadb8ab:eed43a883a54595f740f3a7c9c8a0b28002d42f886570943a1c1070b068a10f0be2c74ad14a01d3f20ea5df306e1f856e0ee0ced381487d3a263edb8e1f4b4aa";

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
