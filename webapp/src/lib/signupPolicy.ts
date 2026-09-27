import * as deploymentConfig from "./deploymentConfig";
import { emailDeliveryMode } from "./mailer";

type Env = Record<string, string | undefined>;

export type SignupAvailability =
  | { allowed: true }
  | { allowed: false; reason: "disabled" | "not-ready" | "email-required" };

/** Operators without email can still run open signup, but only knowingly. */
export function allowUnverifiedSignup(env: Env = process.env): boolean {
  return env.ALLOW_UNVERIFIED_SIGNUP === "true";
}

/** Sign-in is blocked for unverified accounts unless the operator opted out. */
export function emailVerificationRequired(env: Env = process.env): boolean {
  return !allowUnverifiedSignup(env);
}

/**
 * Whether public self-service signup is open right now.
 *
 * Deployment readiness comes from deploymentConfig.isSignupAllowed() when the
 * billing work provides it; until then the equivalent minimal check is used
 * (managed hosting on AND every managed setting configured), so signup can
 * never open on a half-configured deployment that could not bill or process.
 */
export function signupAvailability(env: Env = process.env): SignupAvailability {
  if (env.MANAGED_HOSTING !== "true") return { allowed: false, reason: "disabled" };
  const shared = (deploymentConfig as { isSignupAllowed?: (env?: Env) => boolean }).isSignupAllowed;
  if (typeof shared === "function") {
    if (!shared(env)) {
      return { allowed: false, reason: env.MANAGED_HOSTING === "true" ? "not-ready" : "disabled" };
    }
  } else {
    if (env.MANAGED_HOSTING !== "true") return { allowed: false, reason: "disabled" };
    if (!deploymentConfig.managedConfigurationStatus(env).ready) return { allowed: false, reason: "not-ready" };
  }
  if (!allowUnverifiedSignup(env) && emailDeliveryMode(env) === "none") {
    return { allowed: false, reason: "email-required" };
  }
  return { allowed: true };
}

export const CURRENT_TERMS_VERSION = "2026-09-24";
