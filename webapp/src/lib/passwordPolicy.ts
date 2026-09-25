export const MIN_PASSWORD_LENGTH = 12;
// scrypt cost grows with input size; an unbounded password is a cheap DoS.
export const MAX_PASSWORD_LENGTH = 256;

const COMMON = new Set([
  "password1234", "passwordpassword", "123456789012", "1234567890123", "qwertyuiop12",
  "iloveyou1234", "letmein12345", "administrator", "changemechangeme", "welcome12345",
]);

export type PasswordProblem = "too-short" | "too-long" | "too-common" | "contains-email";

/** Returns why a password is unacceptable, or null when it is fine. */
export function passwordProblem(password: string, email?: string): PasswordProblem | null {
  if (password.length < MIN_PASSWORD_LENGTH) return "too-short";
  if (password.length > MAX_PASSWORD_LENGTH) return "too-long";
  const lowered = password.toLowerCase();
  if (COMMON.has(lowered) || new Set(lowered).size <= 2) return "too-common";
  if (email) {
    const local = email.split("@")[0]?.toLowerCase() ?? "";
    if (local.length >= 4 && lowered.includes(local)) return "contains-email";
  }
  return null;
}

export function passwordProblemMessage(problem: PasswordProblem): string {
  switch (problem) {
    case "too-short":
      return `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`;
    case "too-long":
      return `Passwords can be at most ${MAX_PASSWORD_LENGTH} characters.`;
    case "too-common":
      return "That password is too easy to guess. Try a longer phrase.";
    case "contains-email":
      return "Your password shouldn't contain your email name.";
  }
}
