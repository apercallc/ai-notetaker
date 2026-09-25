import { issueAuthToken } from "./authTokens";
import { getEmailSender, type EmailMessage } from "./mailer";
import { normalizeEmail } from "./email";
import type { RequestContext } from "./requestContext";

/**
 * Issues verification / reset / invite tokens and delivers the link.
 *
 * The link's origin comes from operator config (APP_URL), never from the
 * request's Host header, when the link is EMAILED — a forged Host on a
 * "forgot password" request would otherwise poison the mail sent to the
 * victim. The request origin is only used for links shown to an authorized
 * workspace owner, or in development.
 */
export interface DeliveredLink {
  /** Absolute link; show it only to an authorized owner when `delivered` is false. */
  link: string;
  /** True only when a real mailbox transport accepted the message. */
  delivered: boolean;
}

type LinkKind = "verify" | "reset" | "invite";

function configuredBaseUrl(env = process.env): string | null {
  const value = env.APP_URL?.trim() || env.NEXT_PUBLIC_APP_URL?.trim();
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function requestBaseUrl(context: Pick<RequestContext, "protocol" | "host">): string | null {
  if (!context.host || !/^[a-zA-Z0-9.:[\]-]+$/.test(context.host)) return null;
  return `${context.protocol ?? "http"}://${context.host}`;
}

function linkPath(kind: LinkKind, token: string): string {
  const tab = kind === "verify" ? "verify" : kind === "reset" ? "reset" : "invite";
  return `/login?tab=${tab}&token=${encodeURIComponent(token)}`;
}

async function deliver(
  kind: LinkKind,
  token: string,
  message: (link: string) => Omit<EmailMessage, "to">,
  to: string,
  context: Pick<RequestContext, "protocol" | "host">,
): Promise<DeliveredLink> {
  const envBase = configuredBaseUrl();
  const requestBase = requestBaseUrl(context);
  const path = linkPath(kind, token);
  const displayLink = `${envBase ?? requestBase ?? ""}${path}`;

  const sender = getEmailSender();
  if (!sender) return { link: displayLink, delivered: false };
  const emailBase = envBase ?? (sender.mode === "console" ? requestBase : null);
  if (!emailBase) {
    console.error("auth email not sent: set APP_URL so links in emails point at this deployment");
    return { link: displayLink, delivered: false };
  }
  try {
    await sender.send({ to, ...message(`${emailBase}${path}`) });
    return { link: displayLink, delivered: sender.mode !== "console" };
  } catch (error) {
    console.error("auth email delivery failed", { kind, error: error instanceof Error ? error.message : String(error) });
    return { link: displayLink, delivered: false };
  }
}

export async function sendVerificationEmail(
  input: { userId: string; email: string; context: Pick<RequestContext, "protocol" | "host"> },
): Promise<DeliveredLink> {
  const email = normalizeEmail(input.email);
  const { token } = await issueAuthToken({ purpose: "verify_email", userId: input.userId, email });
  return deliver("verify", token, (link) => ({
    subject: "Confirm your email for AI Notetaker",
    text: `Confirm this email address to finish setting up your workspace:\n\n${link}\n\nThe link works once and expires in 24 hours. If you didn't create an account, ignore this message.`,
  }), email, input.context);
}

export async function sendPasswordResetEmail(
  input: { userId: string; email: string; context: Pick<RequestContext, "protocol" | "host">; issuedByOwner?: boolean },
): Promise<DeliveredLink> {
  const email = normalizeEmail(input.email);
  const { token } = await issueAuthToken({ purpose: "reset_password", userId: input.userId, email });
  return deliver("reset", token, (link) => ({
    subject: "Reset your AI Notetaker password",
    text: `${input.issuedByOwner ? "A workspace owner requested a password reset for your account." : "We received a request to reset your password."}\n\nChoose a new password here:\n\n${link}\n\nThe link works once and expires in 1 hour. If you didn't expect this, you can ignore it — your password stays the same.`,
  }), email, input.context);
}

export async function sendInviteEmail(
  input: {
    workspaceId: string;
    workspaceName: string;
    email: string;
    role: "owner" | "member";
    invitedById: string;
    invitedByEmail: string;
    context: Pick<RequestContext, "protocol" | "host">;
  },
): Promise<DeliveredLink> {
  const email = normalizeEmail(input.email);
  const { token } = await issueAuthToken({
    purpose: "invite",
    email,
    workspaceId: input.workspaceId,
    role: input.role,
    invitedById: input.invitedById,
  });
  return deliver("invite", token, (link) => ({
    subject: `${input.invitedByEmail} invited you to ${input.workspaceName} on AI Notetaker`,
    text: `${input.invitedByEmail} invited you to join the workspace "${input.workspaceName}".\n\nAccept the invitation:\n\n${link}\n\nThe link works once and expires in 7 days.`,
  }), email, input.context);
}
