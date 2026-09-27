/**
 * The one place an email address is canonicalized. Every write (signup,
 * invite, add-member, bootstrap) and every lookup (login, throttle keys,
 * password reset) goes through this, so "Alice@Example.com " and
 * "alice@example.com" can never be two accounts or two throttle budgets.
 * The database backs this with a unique index on lower("email").
 */
export function normalizeEmail(value: string): string {
  return value.normalize("NFC").trim().toLowerCase().normalize("NFC");
}

export const MAX_EMAIL_LENGTH = 254;

// Deliberately permissive: real validation is "can this mailbox receive a
// link", which only a verification email can prove.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function isPlausibleEmail(normalized: string): boolean {
  return normalized.length <= MAX_EMAIL_LENGTH && EMAIL_SHAPE.test(normalized);
}
