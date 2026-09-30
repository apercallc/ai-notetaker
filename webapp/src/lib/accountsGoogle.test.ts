import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "./db";
import { resolveGoogleAccount } from "./accounts";
import { hashPassword } from "./passwords";
import { CURRENT_TERMS_VERSION } from "./signupPolicy";

const EMAIL_PREFIX = "accounts.google.";
const WORKSPACE_PREFIX = "Google batch ";
const context = { ip: "198.51.100.230", userAgent: "google-signin-test", protocol: "https" as const, host: "notetaker.example.test" };

function managedEnvironment(): void {
  process.env.MANAGED_HOSTING = "true";
  process.env.MANAGED_WORKER_TOKEN = "worker-token";
  process.env.R2_ACCOUNT_ID = "test-account";
  process.env.R2_BUCKET = "test-audio";
  process.env.R2_ACCESS_KEY_ID = "test-access";
  process.env.R2_SECRET_ACCESS_KEY = "test-secret";
  process.env.MANAGED_TRANSCRIPTION_PROVIDER = "groq";
  process.env.MANAGED_GROQ_API_KEY = "test-groq";
  process.env.MANAGED_SUMMARY_PROVIDER = "openai";
  process.env.MANAGED_OPENAI_API_KEY = "test-openai";
  process.env.STRIPE_SECRET_KEY = "test-stripe";
  process.env.STRIPE_WEBHOOK_SECRET = "test-webhook";
  process.env.STRIPE_PRICE_HOSTED_PRO = "price-pro";
  process.env.STRIPE_PRICE_HOSTED_TEAM = "price-team";
  process.env.APP_URL = "https://notetaker.example.test";
  process.env.ALLOW_UNVERIFIED_SIGNUP = "true";
  delete process.env.EMAIL_FROM;
  delete process.env.RESEND_API_KEY;
  delete process.env.SMTP_URL;
}

async function cleanFixtures(): Promise<void> {
  await prisma.session.deleteMany({ where: { user: { email: { startsWith: EMAIL_PREFIX } } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
  await prisma.workspace.deleteMany({ where: { name: { startsWith: WORKSPACE_PREFIX } } });
  await prisma.loginThrottle.deleteMany({ where: { emailKey: { contains: "accounts.google" } } });
}

async function seedUser(email: string, verified: boolean): Promise<string> {
  const workspace = await prisma.workspace.create({ data: { name: `${WORKSPACE_PREFIX}${email}`, isDefault: false } });
  const user = await prisma.user.create({
    data: { email, passwordHash: await hashPassword("attacker chosen password 1!"), emailVerifiedAt: verified ? new Date() : null },
  });
  await prisma.workspaceMembership.create({ data: { userId: user.id, workspaceId: workspace.id, role: "owner" } });
  return user.id;
}

const base = { emailVerified: true, termsAccepted: true, context } as const;

beforeEach(async () => {
  await cleanFixtures();
  managedEnvironment();
});

afterAll(async () => {
  await cleanFixtures();
  await prisma.$disconnect();
});

describe("resolveGoogleAccount", () => {
  it("refuses an email Google has not verified, even for an existing account", async () => {
    const email = `${EMAIL_PREFIX}unverified@example.test`;
    await seedUser(email, true);
    expect(await resolveGoogleAccount({ ...base, email, emailVerified: false, mode: "signin" })).toEqual({ ok: false, error: "google-email-unverified" });
    expect(await resolveGoogleAccount({ ...base, email: `${EMAIL_PREFIX}new@example.test`, emailVerified: false, mode: "signup" })).toEqual({ ok: false, error: "google-email-unverified" });
  });

  it("signs into an existing account whose email is verified, ignoring email case", async () => {
    const email = `${EMAIL_PREFIX}existing@example.test`;
    const userId = await seedUser(email, true);
    const result = await resolveGoogleAccount({ ...base, email: email.toUpperCase(), mode: "signin" });
    expect(result).toMatchObject({ ok: true, userId, created: false });
    expect(await prisma.user.count({ where: { email: { startsWith: EMAIL_PREFIX } } })).toBe(1);
  });

  it("does not take over an account whose email was never confirmed (pre-registration attack)", async () => {
    const email = `${EMAIL_PREFIX}victim@example.test`;
    const attackerUser = await seedUser(email, false);
    for (const mode of ["signin", "signup"] as const) {
      expect(await resolveGoogleAccount({ ...base, email, mode })).toEqual({ ok: false, error: "google-account-unconfirmed" });
    }
    const untouched = await prisma.user.findUniqueOrThrow({ where: { id: attackerUser } });
    expect(untouched.emailVerifiedAt).toBeNull();
    expect(await prisma.session.count({ where: { userId: attackerUser } })).toBe(0);
  });

  it("does not create accounts in sign-in mode, so terms consent is never skipped", async () => {
    const email = `${EMAIL_PREFIX}nobody@example.test`;
    expect(await resolveGoogleAccount({ ...base, email, mode: "signin" })).toEqual({ ok: false, error: "google-no-account" });
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it("requires recorded terms consent to create an account", async () => {
    const email = `${EMAIL_PREFIX}noconsent@example.test`;
    expect(await resolveGoogleAccount({ ...base, email, mode: "signup", termsAccepted: false })).toEqual({ ok: false, error: "consent-required" });
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it("creates a verified account with a workspace, the free trial and the terms record", async () => {
    const email = `${EMAIL_PREFIX}fresh@example.test`;
    const result = await resolveGoogleAccount({ ...base, email, mode: "signup", workspaceName: `${WORKSPACE_PREFIX}fresh` });
    expect(result).toMatchObject({ ok: true, created: true, mustChangePassword: false });
    if (!result.ok) throw new Error("unreachable");
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(user.termsVersion).toBe(CURRENT_TERMS_VERSION);
    expect(user.termsAcceptedAt).not.toBeNull();
    expect(user.passwordHash).toBeTruthy();
    const membership = await prisma.workspaceMembership.findFirstOrThrow({ where: { userId: user.id } });
    expect(membership).toMatchObject({ role: "owner", workspaceId: result.workspaceId });
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: result.workspaceId } });
    expect(workspace).toMatchObject({ name: `${WORKSPACE_PREFIX}fresh`, isDefault: false });
  });

  it("names a workspace from the email when none is given and signs the same person back in later", async () => {
    const email = `${EMAIL_PREFIX}named@example.test`;
    const created = await resolveGoogleAccount({ ...base, email, mode: "signup" });
    if (!created.ok) throw new Error(JSON.stringify(created));
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: created.workspaceId } });
    expect(workspace.name).toBe(`${EMAIL_PREFIX}named's workspace`);
    await prisma.workspace.update({ where: { id: workspace.id }, data: { name: `${WORKSPACE_PREFIX}named` } });
    const again = await resolveGoogleAccount({ ...base, email, mode: "signin" });
    expect(again).toMatchObject({ ok: true, userId: created.userId, created: false });
  });

  it("blocks creation when public sign-up is closed", async () => {
    process.env.MANAGED_HOSTING = "false";
    const email = `${EMAIL_PREFIX}closed@example.test`;
    expect(await resolveGoogleAccount({ ...base, email, mode: "signup" })).toEqual({ ok: false, error: "signup-disabled" });
  });
});
