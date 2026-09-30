import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "./db";
import {
  acceptInviteAsUser,
  acceptInviteWithNewAccount,
  authenticateCredentials,
  changePassword,
  completeEmailVerification,
  completePasswordReset,
  isResetTokenValid,
  registerHostedAccount,
} from "./accounts";
import { createApiToken } from "./apiTokens";
import { issueAuthToken } from "./authTokens";
import { hashPassword, verifyPassword } from "./passwords";
import { CURRENT_TERMS_VERSION } from "./signupPolicy";

const EMAIL_PREFIX = "accounts.batch.";
const WORKSPACE_PREFIX = "Accounts batch ";
const validPassword = "River glass orchard 2026!";
const context = { ip: "198.51.100.222", userAgent: "accounts-test", protocol: "https" as const, host: "notetaker.example.test" };

function managedSignupEnvironment(): void {
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
  await prisma.authToken.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
  await prisma.session.deleteMany({ where: { user: { email: { startsWith: EMAIL_PREFIX } } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
  await prisma.workspace.deleteMany({ where: { name: { startsWith: WORKSPACE_PREFIX } } });
  await prisma.loginThrottle.deleteMany({ where: { emailKey: { contains: "accounts.batch" } } });
}

beforeEach(async () => {
  await cleanFixtures();
  managedSignupEnvironment();
});

afterAll(async () => {
  await cleanFixtures();
  await prisma.$disconnect();
});

describe("hosted account creation", () => {
  const input = (overrides: Partial<Parameters<typeof registerHostedAccount>[0]> = {}) => ({
    email: `${EMAIL_PREFIX}owner@example.com`,
    password: validPassword,
    confirmPassword: validPassword,
    workspaceName: `${WORKSPACE_PREFIX}Studio`,
    acceptedTerms: true,
    context,
    now: Date.now(),
    ...overrides,
  });

  it("keeps signup closed when hosting is disabled, misconfigured, or email cannot be delivered", async () => {
    process.env.MANAGED_HOSTING = "false";
    expect(await registerHostedAccount(input())).toEqual({ ok: false, error: "signup-disabled" });

    process.env.MANAGED_HOSTING = "true";
    delete process.env.STRIPE_PRICE_HOSTED_TEAM;
    expect(await registerHostedAccount(input())).toEqual({ ok: false, error: "signup-not-ready" });

    process.env.STRIPE_PRICE_HOSTED_TEAM = "price-team";
    process.env.ALLOW_UNVERIFIED_SIGNUP = "false";
    const originalNodeEnv = process.env.NODE_ENV;
    Reflect.set(process.env, "NODE_ENV", "production");
    expect(await registerHostedAccount(input())).toEqual({ ok: false, error: "signup-email-required" });
    expect(await prisma.user.findUnique({ where: { email: input().email } })).toBeNull();
    if (originalNodeEnv === undefined) Reflect.deleteProperty(process.env, "NODE_ENV");
    else Reflect.set(process.env, "NODE_ENV", originalNodeEnv);
  });

  it("validates email, workspace, password confirmation, strength, and terms before writing", async () => {
    expect(await registerHostedAccount(input({ email: "bad-address" }))).toEqual({ ok: false, error: "email-invalid" });
    expect(await registerHostedAccount(input({ workspaceName: " A " }))).toEqual({ ok: false, error: "workspace-name" });
    expect(await registerHostedAccount(input({ confirmPassword: "another password" }))).toEqual({ ok: false, error: "password-mismatch" });
    expect(await registerHostedAccount(input({ password: "short", confirmPassword: "short" }))).toMatchObject({ ok: false, error: "weak-password", problem: "too-short" });
    expect(await registerHostedAccount(input({ acceptedTerms: false }))).toEqual({ ok: false, error: "consent-required" });
    expect(await prisma.user.count()).toBe(0);
  });

  it("throttles creation, rejects duplicate email, and provisions a normalized account with a trial", async () => {
    const now = Date.now();
    await prisma.loginThrottle.create({ data: { emailKey: "signup:ip:198.51.100.222", failures: 6, firstFailureAt: new Date(now), updatedAt: new Date(now) } });
    expect(await registerHostedAccount(input({ now }))).toMatchObject({ ok: false, error: "throttled" });
    await prisma.loginThrottle.deleteMany({ where: { emailKey: { startsWith: "signup:" } } });

    const duplicateEmail = `${EMAIL_PREFIX}taken@example.com`;
    await prisma.user.create({ data: { email: duplicateEmail, passwordHash: "existing-hash" } });
    expect(await registerHostedAccount(input({ email: duplicateEmail }))).toEqual({ ok: false, error: "email-taken" });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await registerHostedAccount(input({
      email: ` ${EMAIL_PREFIX.toUpperCase()}Alice@Example.com `,
      workspaceName: `${WORKSPACE_PREFIX}${"N".repeat(120)}`,
    }));
    expect(result).toMatchObject({ ok: true, verificationRequired: false, verification: { delivered: false } });
    if (!result.ok) throw new Error("expected signup success");
    const user = await prisma.user.findUniqueOrThrow({ where: { id: result.userId } });
    expect(user.email).toBe(`${EMAIL_PREFIX}alice@example.com`);
    expect(user.termsVersion).toBe(CURRENT_TERMS_VERSION);
    expect(user.termsAcceptedAt).not.toBeNull();
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: result.workspaceId }, include: { subscription: true } });
    expect(workspace.name).toHaveLength(100);
    expect(workspace.isDefault).toBe(false);
    expect(workspace.subscription).toMatchObject({ plan: "hosted_trial", status: "trialing" });
    const token = new URL(result.verification!.link).searchParams.get("token")!;
    expect((await completeEmailVerification(token)).ok).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: result.userId } })).emailVerifiedAt).not.toBeNull();
    expect(await completeEmailVerification(token)).toEqual({ ok: false });
    warn.mockRestore();
  });
});

describe("credential authentication", () => {
  it("uses normalized lookup, counts invalid attempts, blocks unverified users, and cleans up after success", async () => {
    const email = `${EMAIL_PREFIX}login@example.com`;
    const passwordHash = await hashPassword(validPassword);
    const user = await prisma.user.create({ data: { email, passwordHash, emailVerifiedAt: null } });
    expect(await authenticateCredentials({ email: " unknown@example.com ", password: "wrong", ip: null })).toEqual({ ok: false, reason: "invalid" });
    expect(await prisma.loginThrottle.findUnique({ where: { emailKey: `login:email:unknown@example.com` } })).not.toBeNull();
    expect(await authenticateCredentials({ email: ` ${email.toUpperCase()} `, password: "bad password", ip: null })).toEqual({ ok: false, reason: "invalid" });
    expect(await authenticateCredentials({ email, password: "x".repeat(257), ip: null })).toEqual({ ok: false, reason: "invalid" });

    process.env.ALLOW_UNVERIFIED_SIGNUP = "false";
    expect(await authenticateCredentials({ email, password: validPassword, ip: null })).toEqual({ ok: false, reason: "unverified", email });
    await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
    const result = await authenticateCredentials({ email: ` ${email.toUpperCase()} `, password: validPassword, ip: null });
    expect(result).toEqual({ ok: true, user: { id: user.id, email, mustChangePassword: false } });
    expect(await prisma.loginThrottle.findUnique({ where: { emailKey: `login:email:${email}` } })).toBeNull();
  });

  it("returns retry timing before password verification when a login key is blocked", async () => {
    const email = `${EMAIL_PREFIX}blocked@example.com`;
    const now = Date.now();
    await prisma.loginThrottle.create({ data: { emailKey: `login:email:${email}`, failures: 12, firstFailureAt: new Date(now), updatedAt: new Date(now) } });
    expect(await authenticateCredentials({ email, password: validPassword, ip: null, now })).toEqual({ ok: false, reason: "throttled", retryAfterMs: 60_000 });
  });
});

describe("password reset and change", () => {
  it("validates a reset before spending it and revokes sessions and extension API tokens on success", async () => {
    const email = `${EMAIL_PREFIX}reset@example.com`;
    const user = await prisma.user.create({ data: { email, passwordHash: await hashPassword(validPassword), mustChangePassword: true } });
    const session = await prisma.session.create({ data: { userId: user.id, expiresAt: new Date(Date.now() + 60_000) } });
    const apiToken = await createApiToken(user.id);
    const issued = await issueAuthToken({ purpose: "reset_password", email, userId: user.id });
    expect(await isResetTokenValid(issued.token)).toBe(true);
    expect(await completePasswordReset("invalid-token", validPassword, validPassword)).toEqual({ ok: false, reason: "invalid-token" });
    expect(await completePasswordReset(issued.token, validPassword, "not the same" )).toEqual({ ok: false, reason: "mismatch" });
    expect(await completePasswordReset(issued.token, "password1234", "password1234")).toMatchObject({ ok: false, reason: "weak-password", problem: "too-common" });
    expect(await isResetTokenValid(issued.token)).toBe(true);

    const nextPassword = "Maple canyon sunset 2027!";
    expect(await completePasswordReset(issued.token, nextPassword, nextPassword)).toEqual({ ok: true });
    expect(await isResetTokenValid(issued.token)).toBe(false);
    expect(await prisma.session.findUnique({ where: { id: session.id } })).toBeNull();
    expect(await prisma.apiToken.findUnique({ where: { id: apiToken.id } })).toBeNull();
    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(updated.mustChangePassword).toBe(false);
    expect(updated.emailVerifiedAt).not.toBeNull();
    expect(await verifyPassword(nextPassword, updated.passwordHash)).toBe(true);
  });

  it("requires the current password, rejects unsafe changes, then preserves only the active session", async () => {
    const email = `${EMAIL_PREFIX}change@example.com`;
    const user = await prisma.user.create({ data: { email, passwordHash: await hashPassword(validPassword) } });
    const keep = await prisma.session.create({ data: { userId: user.id, expiresAt: new Date(Date.now() + 60_000) } });
    const remove = await prisma.session.create({ data: { userId: user.id, expiresAt: new Date(Date.now() + 60_000) } });
    await createApiToken(user.id);
    const change = (overrides: Partial<Parameters<typeof changePassword>[0]> = {}) => ({
      userId: user.id, keepSessionId: keep.id, currentPassword: validPassword,
      newPassword: "Cedar valley sunrise 2027!", confirmPassword: "Cedar valley sunrise 2027!", ...overrides,
    });
    expect(await changePassword(change({ currentPassword: "incorrect" }))).toEqual({ ok: false, reason: "wrong-password" });
    expect(await changePassword(change({ confirmPassword: "different password" }))).toEqual({ ok: false, reason: "mismatch" });
    expect(await changePassword(change({ newPassword: validPassword, confirmPassword: validPassword }))).toEqual({ ok: false, reason: "same-password" });
    expect(await changePassword(change({ newPassword: "password1234", confirmPassword: "password1234" }))).toMatchObject({ ok: false, reason: "weak-password", problem: "too-common" });
    expect(await changePassword(change())).toEqual({ ok: true });
    expect(await prisma.session.findUnique({ where: { id: keep.id } })).not.toBeNull();
    expect(await prisma.session.findUnique({ where: { id: remove.id } })).toBeNull();
    expect(await prisma.apiToken.count({ where: { userId: user.id } })).toBe(0);
    expect(await verifyPassword("Cedar valley sunrise 2027!", (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash)).toBe(true);
  });
});

describe("workspace invitation acceptance", () => {
  it("lets only the invited identity join and returns distinct safe outcomes for new accounts", async () => {
    const workspace = await prisma.workspace.create({ data: { name: `${WORKSPACE_PREFIX}Invitations` } });
    const existingEmail = `${EMAIL_PREFIX}existing@example.com`;
    const existing = await prisma.user.create({ data: { email: existingEmail, passwordHash: "hash" } });
    const invite = await issueAuthToken({ purpose: "invite", email: existingEmail, workspaceId: workspace.id, role: "member" });
    expect(await acceptInviteAsUser(invite.token, { id: existing.id, email: `${EMAIL_PREFIX}wrong@example.com` })).toEqual({ ok: false, reason: "email-mismatch" });
    expect(await acceptInviteAsUser(invite.token, { id: existing.id, email: existingEmail })).toEqual({ ok: true, userId: existing.id, workspaceId: workspace.id });
    expect(await acceptInviteAsUser(invite.token, { id: existing.id, email: existingEmail })).toEqual({ ok: false, reason: "invalid-token" });

    const newEmail = `${EMAIL_PREFIX}newinvite@example.com`;
    const newInvite = await issueAuthToken({ purpose: "invite", email: newEmail, workspaceId: workspace.id, role: null });
    const mismatch = await acceptInviteWithNewAccount({ token: newInvite.token, password: validPassword, confirmPassword: "different", acceptedTerms: true });
    expect(mismatch).toEqual({ ok: false, reason: "mismatch" });
    expect(await acceptInviteWithNewAccount({ token: newInvite.token, password: "password1234", confirmPassword: "password1234", acceptedTerms: true }))
      .toMatchObject({ ok: false, reason: "weak-password", problem: "too-common" });
    expect(await acceptInviteWithNewAccount({ token: newInvite.token, password: validPassword, confirmPassword: validPassword, acceptedTerms: false }))
      .toEqual({ ok: false, reason: "consent-required" });
    const accepted = await acceptInviteWithNewAccount({ token: newInvite.token, password: validPassword, confirmPassword: validPassword, acceptedTerms: true });
    expect(accepted).toMatchObject({ ok: true, workspaceId: workspace.id });
    if (!accepted.ok) throw new Error("expected invitation acceptance");
    const invitee = await prisma.user.findUniqueOrThrow({ where: { id: accepted.userId } });
    expect(invitee.emailVerifiedAt).not.toBeNull();
    expect(await prisma.workspaceMembership.findUnique({ where: { userId_workspaceId: { userId: accepted.userId, workspaceId: workspace.id } } })).toMatchObject({ role: "member" });
    const duplicate = await issueAuthToken({ purpose: "invite", email: newEmail, workspaceId: workspace.id, role: "member" });
    expect(await acceptInviteWithNewAccount({ token: duplicate.token, password: validPassword, confirmPassword: validPassword, acceptedTerms: true }))
      .toEqual({ ok: false, reason: "account-exists" });
  });

  it("does not consume a valid invite when its workspace has been deleted", async () => {
    const workspace = await prisma.workspace.create({ data: { name: `${WORKSPACE_PREFIX}Deleted invite` } });
    const issued = await issueAuthToken({ purpose: "invite", email: `${EMAIL_PREFIX}orphan@example.com`, workspaceId: workspace.id, role: "owner" });
    await prisma.workspace.delete({ where: { id: workspace.id } });
    expect(await acceptInviteWithNewAccount({ token: issued.token, password: validPassword, confirmPassword: validPassword, acceptedTerms: true }))
      .toEqual({ ok: false, reason: "workspace-gone" });
  });
});
