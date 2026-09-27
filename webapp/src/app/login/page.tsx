import type { Metadata } from "next";
import Link from "next/link";
import { cookies, headers } from "next/headers";
import { prisma } from "@/lib/db";
import { safeNextPath } from "@/lib/navigation";
import { getSessionContext } from "@/lib/sessions";
import { peekAuthToken } from "@/lib/authTokens";
import { passwordProblemMessage, MIN_PASSWORD_LENGTH, type PasswordProblem } from "@/lib/passwordPolicy";
import { SESSION_COOKIE, cookiesLikelyDropped } from "@/lib/sessionCookie";
import { contextFromHeaders } from "@/lib/requestContext";
import { emailDeliveryMode } from "@/lib/mailer";
import { signupAvailability } from "@/lib/signupPolicy";
import { formatRetryAfter } from "@/lib/loginThrottle";
import { bootstrap, login, signup, requestPasswordReset, resendVerification, verifyEmail, resetPassword, acceptInvite, acceptInviteNewAccount } from "./actions";
import { SubmitButton } from "./SubmitButton";
import { loginUrl, type LoginTab } from "./url";

// Verification, reset and invite links carry a secret in the query string —
// never leak it to third parties through the Referer header.
export const metadata: Metadata = { title: "Sign in · AI Notetaker", referrer: "no-referrer" };

type SearchParams = Record<string, string | undefined>;

const formStyle = { display: "flex", flexDirection: "column", gap: "var(--space-3)" } as const;

const TABS: LoginTab[] = ["signin", "signup", "forgot", "reset", "verify", "invite"];

function messageFor(error: string | undefined, retry: string | undefined, problem: string | undefined): string | null {
  if (!error) return null;
  const wait = retry && Number.isFinite(Number(retry)) ? formatRetryAfter(Number(retry) * 1000) : "a few minutes";
  switch (error) {
    case "invalid":
    case "1":
      return "That email or password isn't correct.";
    case "throttled":
      return `Too many attempts. Try again in ${wait}.`;
    case "unverified":
      return "Confirm your email first. We sent you a link when you signed up.";
    case "no-workspace":
      return "This account isn't part of any workspace yet. Ask a workspace owner to invite you.";
    case "signup-disabled":
      return "Public sign-up isn't open on this instance. Ask a workspace owner for an invitation.";
    case "signup-not-ready":
      return "Sign-up is temporarily unavailable while this service finishes setup. Please try again later.";
    case "signup-email-required":
      return "Sign-up is unavailable because this service can't send verification emails yet. Please contact the operator.";
    case "email-invalid":
      return "Enter a valid email address.";
    case "email-taken":
      return "An account with that email already exists. Sign in instead, or reset your password.";
    case "password-mismatch":
      return "The two passwords don't match.";
    case "weak-password":
      return passwordProblemMessage((problem as PasswordProblem) ?? "too-short");
    case "workspace-name":
      return "Give your workspace a name (at least 2 characters).";
    case "consent-required":
      return "Please accept the Terms and the recording notice to continue.";
    case "token-invalid":
      return "That link is invalid or has expired. Request a new one and try again.";
    case "email-not-configured":
      return "This instance can't send email, so it can't send links. Ask a workspace owner to issue you a reset link from the Team page.";
    case "invite-already-member":
      return "You're already a member of that workspace.";
    case "invite-email-mismatch":
      return "You're signed in with a different email than the one this invitation was sent to. Sign out and use the invited address.";
    case "bootstrap":
      return `Check your setup code and email, and make sure both passwords match (${MIN_PASSWORD_LENGTH}+ characters).`;
    default:
      return "Something went wrong. Please try again.";
  }
}

function noticeFor(notice: string | undefined): string | null {
  switch (notice) {
    case "verify-sent":
      return "Check your inbox — we've sent a confirmation link. You can sign in once you've confirmed your email.";
    case "verified":
      return "Email confirmed. You can sign in now.";
    case "reset-sent":
      return "If an account exists for that email, a reset link is on its way. It works once and expires in an hour.";
    case "password-reset":
      return "Password updated. Sign in with your new password.";
    default:
      return null;
  }
}

function Consent() {
  return (
    <div>
      <label style={{ display: "flex", gap: "var(--space-2)", alignItems: "flex-start" }}>
        <input type="checkbox" name="acceptTerms" required style={{ marginTop: 4 }} />
        <span>
          I agree to the Terms of Service and Privacy Notice, and I&apos;ll tell everyone in a meeting — and get their
          consent where the law requires it — before recording.
        </span>
      </label>
      <details className="muted-copy">
        <summary>What am I agreeing to?</summary>
        <p>
          Your meeting audio, transcripts and summaries are stored in your workspace and processed by AI providers to
          produce notes. Only members of your workspace can see them; you can export or delete everything at any time
          from Account. You are responsible for lawful use, including consent to record other participants.
        </p>
      </details>
    </div>
  );
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const rawTab = params.tab as LoginTab | undefined;
  const tab: LoginTab = rawTab && TABS.includes(rawTab) ? rawTab : "signin";
  const next = params.next ? safeNextPath(params.next) : "/meetings";
  const token = params.token;

  const requestHeaders = await headers();
  const requestContext = contextFromHeaders((name) => requestHeaders.get(name));
  const store = await cookies();
  const sessionCookie = store.get(SESSION_COOKIE)?.value;
  const current = sessionCookie ? await getSessionContext(sessionCookie) : null;
  // A cookie that no longer resolves means the session ended (expired, signed
  // out elsewhere, or password changed). Say so instead of a silent bounce.
  const sessionExpired = Boolean(sessionCookie) && !current && !params.error && !params.notice;

  const userCount = await prisma.user.count();
  const managedHosting = process.env.MANAGED_HOSTING === "true";
  const errorText = messageFor(params.error, params.retry, params.problem);
  const noticeText = noticeFor(params.notice);
  const cookieHint = cookiesLikelyDropped(requestContext);
  const availability = signupAvailability();

  const banner = (
    <>
      {sessionExpired && <p role="status" className="muted-copy">Session expired — sign in again.</p>}
      {!sessionExpired && !params.error && !params.notice && params.next && tab === "signin" && !current && (
        <p role="status" className="muted-copy">Sign in to continue.</p>
      )}
      {noticeText && <p role="status" className="muted-copy">{noticeText}</p>}
      {errorText && <p className="error-text" role="alert">{errorText}</p>}
      {params.error === "unverified" && params.email && (
        <form action={resendVerification} style={formStyle}>
          <input type="hidden" name="email" value={params.email} />
          <input type="hidden" name="next" value={next} />
          <SubmitButton label="Resend confirmation email" pendingLabel="Sending…" variant="secondary" />
        </form>
      )}
      {cookieHint && (
        <p className="error-text" role="alert">
          This page is loaded over plain http, but sign-in cookies are set as secure-only, so your browser will drop them
          and sign-in will appear to loop. Serve the app over https, or ask the operator to set{" "}
          <code>INSECURE_COOKIES=true</code> for a trusted local network.
        </p>
      )}
    </>
  );

  // First run of a self-hosted instance: claim it with the deploy-time secret.
  if (userCount === 0 && !managedHosting) {
    return (
      <div className="container">
        <form className="login-form" action={bootstrap}>
          <h1>AI Notetaker</h1>
          <p className="muted-copy">
            Create the first account for this instance. You&apos;ll be its workspace owner.
          </p>
          <label htmlFor="setupToken">Setup code</label>
          <input id="setupToken" name="setupToken" type="password" className="text-input" autoFocus required autoComplete="off" />
          <p className="muted-copy">
            The <code>AUTH_TOKEN</code> value you set when deploying this instance — proves you&apos;re the
            one who deployed it, not just the first person to find the URL.
          </p>
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" className="text-input" required autoComplete="email" />
          <label htmlFor="password">Password</label>
          <input id="password" name="password" type="password" className="text-input" required minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" />
          <label htmlFor="confirmPassword">Confirm password</label>
          <input id="confirmPassword" name="confirmPassword" type="password" className="text-input" required minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" />
          {errorText && <p className="error-text" role="alert">{errorText}</p>}
          {cookieHint && <p className="error-text" role="alert">Sign-in cookies would be dropped over plain http; serve over https or set <code>INSECURE_COOKIES=true</code>.</p>}
          <SubmitButton label="Create owner account" pendingLabel="Creating…" />
        </form>
      </div>
    );
  }

  const showTabs = tab === "signin" || tab === "signup";

  return (
    <div className="container">
      <div className="login-form">
        <h1>AI Notetaker</h1>

        {showTabs && managedHosting && (
          <nav className="filter-links" aria-label="Account">
            <Link href={loginUrl({ next })} aria-current={tab === "signin" ? "page" : undefined}>Sign in</Link>
            <Link href={loginUrl({ tab: "signup", next })} aria-current={tab === "signup" ? "page" : undefined}>Create workspace</Link>
          </nav>
        )}

        {banner}

        {tab === "signin" && (
          <form action={login} style={formStyle}>
            <input type="hidden" name="next" value={next} />
            <label htmlFor="email">Email</label>
            <input id="email" name="email" type="email" className="text-input" autoFocus required autoComplete="email" defaultValue={params.error === "unverified" ? params.email : undefined} />
            <label htmlFor="password">Password</label>
            <input id="password" name="password" type="password" className="text-input" required autoComplete="current-password" />
            <SubmitButton label="Sign in" pendingLabel="Signing in…" />
            <Link href={loginUrl({ tab: "forgot", next })} className="text-link-muted">Forgot your password?</Link>
          </form>
        )}

        {tab === "signup" && !managedHosting && (
          <p className="muted-copy">Public sign-up isn&apos;t open on this instance. Ask a workspace owner for an invitation, then use the link they send you.</p>
        )}
        {tab === "signup" && managedHosting && !availability.allowed && !params.error && (
          <p className="error-text" role="alert">
            {messageFor(availability.reason === "disabled" ? "signup-disabled" : availability.reason === "not-ready" ? "signup-not-ready" : "signup-email-required", undefined, undefined)}
          </p>
        )}
        {tab === "signup" && managedHosting && availability.allowed && (
          <form action={signup} style={formStyle}>
            <input type="hidden" name="next" value={next} />
            <p className="muted-copy">Start a separate workspace for your team. Your meetings and billing stay isolated from every other customer.</p>
            <label htmlFor="signupWorkspaceName">Workspace name</label>
            <input id="signupWorkspaceName" name="workspaceName" type="text" className="text-input" required minLength={2} maxLength={100} autoComplete="organization" autoFocus />
            <label htmlFor="signupEmail">Work email</label>
            <input id="signupEmail" name="email" type="email" className="text-input" required autoComplete="email" />
            <label htmlFor="signupPassword">Password</label>
            <input id="signupPassword" name="password" type="password" className="text-input" required minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" aria-describedby="pw-hint" />
            <p id="pw-hint" className="muted-copy">At least {MIN_PASSWORD_LENGTH} characters. A phrase works well.</p>
            <label htmlFor="signupConfirmPassword">Confirm password</label>
            <input id="signupConfirmPassword" name="confirmPassword" type="password" className="text-input" required minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" />
            <Consent />
            <SubmitButton label="Create workspace" pendingLabel="Creating…" />
            <p className="muted-copy">Already have an account? <Link href={loginUrl({ next })}>Sign in</Link></p>
          </form>
        )}

        {tab === "forgot" && (
          <form action={requestPasswordReset} style={formStyle}>
            <input type="hidden" name="next" value={next} />
            <h2>Reset your password</h2>
            {emailDeliveryMode() === "none" ? (
              <p className="muted-copy">
                This instance can&apos;t send email. Ask a workspace owner to issue you a reset link from the Team page.
              </p>
            ) : (
              <>
                <p className="muted-copy">Enter your email and we&apos;ll send you a link to choose a new password.</p>
                <label htmlFor="forgotEmail">Email</label>
                <input id="forgotEmail" name="email" type="email" className="text-input" autoFocus required autoComplete="email" />
                <SubmitButton label="Send reset link" pendingLabel="Sending…" />
              </>
            )}
            <Link href={loginUrl({ next })} className="text-link-muted">Back to sign in</Link>
          </form>
        )}

        {tab === "reset" && token && (await peekAuthToken(token, "reset_password")) && (
          <form action={resetPassword} style={formStyle}>
            <h2>Choose a new password</h2>
            <input type="hidden" name="token" value={token} />
            <label htmlFor="resetPassword">New password</label>
            <input id="resetPassword" name="password" type="password" className="text-input" autoFocus required minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" />
            <label htmlFor="resetConfirm">Confirm new password</label>
            <input id="resetConfirm" name="confirmPassword" type="password" className="text-input" required minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" />
            <p className="muted-copy">You&apos;ll be signed out everywhere else.</p>
            <SubmitButton label="Set new password" pendingLabel="Saving…" />
          </form>
        )}

        {tab === "verify" && token && (await peekAuthToken(token, "verify_email")) && (
          <form action={verifyEmail} style={formStyle}>
            <h2>Confirm your email</h2>
            <input type="hidden" name="token" value={token} />
            <p className="muted-copy">One click to confirm this address.</p>
            <SubmitButton label="Confirm email" pendingLabel="Confirming…" />
          </form>
        )}

        {tab === "invite" && token && (await renderInvite(token, current, params, next))}

        {((tab === "reset" && (!token || !(await peekAuthToken(token, "reset_password")))) ||
          (tab === "verify" && (!token || !(await peekAuthToken(token, "verify_email")))) ||
          (tab === "invite" && !token)) && (
          <>
            <p className="error-text" role="alert">{messageFor("token-invalid", undefined, undefined)}</p>
            <Link href={loginUrl({ tab: tab === "reset" ? "forgot" : "signin" })} className="text-link-muted">
              {tab === "reset" ? "Request a new reset link" : "Back to sign in"}
            </Link>
          </>
        )}
      </div>
    </div>
  );
}

async function renderInvite(
  token: string,
  current: { user: { id: string; email: string } } | null,
  params: SearchParams,
  next: string,
) {
  const invite = await peekAuthToken(token, "invite");
  if (!invite?.workspaceId) {
    return (
      <>
        <p className="error-text" role="alert">{messageFor("token-invalid", undefined, undefined)}</p>
        <Link href={loginUrl()} className="text-link-muted">Back to sign in</Link>
      </>
    );
  }
  const workspace = await prisma.workspace.findUnique({ where: { id: invite.workspaceId }, select: { name: true } });
  if (!workspace) return <p className="error-text" role="alert">{messageFor("token-invalid", undefined, undefined)}</p>;
  const existing = await prisma.user.findUnique({ where: { email: invite.email }, select: { id: true } });
  const inviteHref = `/login?tab=invite&token=${encodeURIComponent(token)}`;

  if (current && current.user.email === invite.email) {
    return (
      <form action={acceptInvite} style={formStyle}>
        <h2>Join {workspace.name}</h2>
        <input type="hidden" name="token" value={token} />
        <p className="muted-copy">You&apos;re signed in as {current.user.email}.</p>
        <SubmitButton label="Join workspace" pendingLabel="Joining…" />
      </form>
    );
  }
  if (current) {
    return (
      <>
        <h2>Join {workspace.name}</h2>
        <p className="error-text" role="alert">{messageFor("invite-email-mismatch", undefined, undefined)}</p>
      </>
    );
  }
  if (existing) {
    return (
      <>
        <h2>Join {workspace.name}</h2>
        <p className="muted-copy">You already have an account for {invite.email}. Sign in to accept this invitation.</p>
        <Link className="button button-primary" href={loginUrl({ next: inviteHref })}>Sign in to join</Link>
      </>
    );
  }
  void next;
  void params;
  return (
    <form action={acceptInviteNewAccount} style={formStyle}>
      <h2>Join {workspace.name}</h2>
      <input type="hidden" name="token" value={token} />
      <p className="muted-copy">Create your account for {invite.email}.</p>
      {messageFor(params.error, undefined, params.problem) && <p className="error-text" role="alert">{messageFor(params.error, undefined, params.problem)}</p>}
      <label htmlFor="invitePassword">Password</label>
      <input id="invitePassword" name="password" type="password" className="text-input" autoFocus required minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" />
      <label htmlFor="inviteConfirm">Confirm password</label>
      <input id="inviteConfirm" name="confirmPassword" type="password" className="text-input" required minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" />
      <Consent />
      <SubmitButton label="Create account and join" pendingLabel="Creating…" />
    </form>
  );
}
