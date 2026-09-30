import { describe, expect, it } from "vitest";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, passwordProblem, passwordProblemMessage, type PasswordProblem } from "./passwordPolicy";
import { clientIpFromHeaders, contextFromHeaders, contextFromRequest, protocolFromHeaders } from "./requestContext";
import { allowUnverifiedSignup, emailVerificationRequired, signupAvailability } from "./signupPolicy";
import { isSerializationConflict } from "./usageLedger";

const headersOf = (values: Record<string, string>) => (name: string): string | null => values[name.toLowerCase()] ?? null;

describe("password policy", () => {
  it("accepts a long, uncommon password that does not contain the email name", () => {
    expect(passwordProblem("correct horse battery staple", "alex.smith@example.com")).toBeNull();
  });

  it("rejects short, oversized, common, repetitive and email-derived passwords", () => {
    expect(passwordProblem("a".repeat(MIN_PASSWORD_LENGTH - 1))).toBe("too-short");
    expect(passwordProblem("x9".repeat(MAX_PASSWORD_LENGTH))).toBe("too-long");
    expect(passwordProblem("PasswordPassword")).toBe("too-common");
    expect(passwordProblem("abababababab")).toBe("too-common");
    expect(passwordProblem("my-alexsmith-secret-phrase", "alexsmith@example.com")).toBe("contains-email");
  });

  it("ignores very short email names so ordinary passwords are not rejected", () => {
    expect(passwordProblem("a-long-and-unusual-passphrase", "al@example.com")).toBeNull();
  });

  it("explains every problem in words the user can act on", () => {
    const problems: PasswordProblem[] = ["too-short", "too-long", "too-common", "contains-email"];
    const messages = problems.map(passwordProblemMessage);
    expect(new Set(messages).size).toBe(problems.length);
    expect(messages[0]).toContain(String(MIN_PASSWORD_LENGTH));
    expect(messages[1]).toContain(String(MAX_PASSWORD_LENGTH));
  });
});

describe("request context", () => {
  it("trusts only the last forwarded hop, because earlier hops are client-supplied", () => {
    expect(clientIpFromHeaders(headersOf({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 9.9.9.9" }))).toBe("9.9.9.9");
    expect(clientIpFromHeaders(headersOf({ "x-forwarded-for": " , " }))).toBeNull();
  });

  it("prefers the proxy-appended forwarded hop over a client-forgeable real-ip, and falls back to real-ip", () => {
    expect(clientIpFromHeaders(headersOf({ "x-real-ip": "6.6.6.6", "x-forwarded-for": "1.1.1.1, 7.7.7.7" }))).toBe("7.7.7.7");
    expect(clientIpFromHeaders(headersOf({ "x-real-ip": "7.7.7.7" }))).toBe("7.7.7.7");
    expect(clientIpFromHeaders(headersOf({ "x-real-ip": "7.7.7.7", "x-forwarded-for": " , " }))).toBe("7.7.7.7");
    expect(clientIpFromHeaders(headersOf({ "x-real-ip": "9".repeat(200) }))?.length).toBe(64);
    expect(clientIpFromHeaders(headersOf({}))).toBeNull();
  });

  it("derives the protocol from the proxy header, then the origin, else null", () => {
    expect(protocolFromHeaders(headersOf({ "x-forwarded-proto": "HTTPS, http" }))).toBe("https");
    expect(protocolFromHeaders(headersOf({ "x-forwarded-proto": "http" }))).toBe("http");
    expect(protocolFromHeaders(headersOf({ origin: "https://notes.example.test" }))).toBe("https");
    expect(protocolFromHeaders(headersOf({ origin: "http://localhost:3000" }))).toBe("http");
    expect(protocolFromHeaders(headersOf({ origin: "chrome-extension://abc" }))).toBeNull();
    expect(protocolFromHeaders(headersOf({ origin: "not a url" }))).toBeNull();
    expect(protocolFromHeaders(headersOf({ "x-forwarded-proto": "ftp" }))).toBeNull();
  });

  it("truncates the user agent and keeps the host", () => {
    const context = contextFromHeaders(headersOf({ "user-agent": "u".repeat(500), host: "notes.example.test" }));
    expect(context.userAgent?.length).toBe(300);
    expect(context.host).toBe("notes.example.test");
    expect(contextFromHeaders(headersOf({})).userAgent).toBeNull();
  });

  it("falls back to the request URL's scheme when no header names one", () => {
    expect(contextFromRequest(new Request("https://notes.example.test/x")).protocol).toBe("https");
    expect(contextFromRequest(new Request("http://localhost/x")).protocol).toBe("http");
    expect(contextFromRequest(new Request("https://notes.example.test/x", { headers: { "x-forwarded-proto": "http" } })).protocol).toBe("http");
  });
});

describe("signup policy", () => {
  const ready = {
    MANAGED_HOSTING: "true",
    NODE_ENV: "production",
    APP_URL: "https://notes.example.test",
    MANAGED_WORKER_TOKEN: "worker",
    S3_BUCKET: "bucket",
    S3_ACCESS_KEY_ID: "key",
    S3_SECRET_ACCESS_KEY: "secret",
    MANAGED_GROQ_API_KEY: "groq",
    MANAGED_OPENAI_API_KEY: "openai",
    STRIPE_SECRET_KEY: "sk_test",
    STRIPE_WEBHOOK_SECRET: "whsec_test",
    STRIPE_PRICE_HOSTED_PRO: "price_pro",
    STRIPE_PRICE_HOSTED_TEAM: "price_team",
  };
  const withEmail = { ...ready, RESEND_API_KEY: "re_test", EMAIL_FROM: "AI Notetaker <noreply@example.test>" };

  it("is closed on a self-hosted instance", () => {
    expect(signupAvailability({})).toEqual({ allowed: false, reason: "disabled" });
  });

  it("stays closed until every provider, billing and storage setting exists", () => {
    expect(signupAvailability({ MANAGED_HOSTING: "true", NODE_ENV: "production" })).toEqual({ allowed: false, reason: "not-ready" });
  });

  it("refuses signup that could not send a verification email", () => {
    expect(signupAvailability(ready)).toEqual({ allowed: false, reason: "email-required" });
  });

  it("opens once the deployment is complete and can send email", () => {
    expect(signupAvailability(withEmail)).toEqual({ allowed: true });
  });

  it("lets an operator knowingly opt out of email verification", () => {
    const optOut = { ...ready, ALLOW_UNVERIFIED_SIGNUP: "true" };
    expect(allowUnverifiedSignup(optOut)).toBe(true);
    expect(emailVerificationRequired(optOut)).toBe(false);
    expect(signupAvailability(optOut)).toEqual({ allowed: true });
    expect(emailVerificationRequired(ready)).toBe(true);
  });
});

describe("serializable transaction conflicts", () => {
  it("recognizes both the Prisma engine code and the pg driver adapter's error", () => {
    expect(isSerializationConflict({ code: "P2034" })).toBe(true);
    const adapter = Object.assign(new Error("TransactionWriteConflict"), { name: "DriverAdapterError" });
    expect(isSerializationConflict(adapter)).toBe(true);
    expect(isSerializationConflict(Object.assign(new Error("could not serialize access due to concurrent update"), { name: "DriverAdapterError" }))).toBe(true);
    expect(isSerializationConflict(Object.assign(new Error("deadlock detected"), { name: "DriverAdapterError" }))).toBe(true);
  });

  it("does not retry ordinary failures, including a genuine quota refusal", () => {
    expect(isSerializationConflict(new Error("managed processing entitlement is unavailable"))).toBe(false);
    expect(isSerializationConflict(Object.assign(new Error("connection refused"), { name: "DriverAdapterError" }))).toBe(false);
    expect(isSerializationConflict(Object.assign(new Error("TransactionWriteConflict"), { name: "Error" }))).toBe(false);
    expect(isSerializationConflict({ code: "P2002" })).toBe(false);
    expect(isSerializationConflict(null)).toBe(false);
    expect(isSerializationConflict("TransactionWriteConflict")).toBe(false);
  });
});
