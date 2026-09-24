import { prisma } from "@/lib/db";
import { bootstrap, login, signup } from "./actions";
import { SubmitButton } from "./SubmitButton";
import { safeNextPath } from "@/lib/navigation";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next = "/meetings", error } = await searchParams;
  const userCount = await prisma.user.count();
  const managedHosting = process.env.MANAGED_HOSTING === "true";

  if (userCount === 0 && !managedHosting) {
    return (
      <div className="container">
        <form className="login-form" action={bootstrap}>
          <h1>AI Notetaker</h1>
          <p className="muted-copy">
            Create the first account for this instance. You&apos;ll be its workspace owner.
          </p>
          <label htmlFor="setupToken">Setup code</label>
          <input
            id="setupToken"
            name="setupToken"
            type="password"
            className="text-input"
            autoFocus
            required
            autoComplete="off"
          />
          <p className="muted-copy">
            The <code>AUTH_TOKEN</code> value you set when deploying this instance — proves you&apos;re the
            one who deployed it, not just the first person to find the URL.
          </p>
          <label htmlFor="email">Email</label>
          <input
            id="email"
            name="email"
            type="email"
            className="text-input"
            required
            autoComplete="email"
          />
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            className="text-input"
            required
            minLength={12}
            autoComplete="new-password"
          />
          <label htmlFor="confirmPassword">Confirm password</label>
          <input
            id="confirmPassword"
            name="confirmPassword"
            type="password"
            className="text-input"
            required
            minLength={12}
            autoComplete="new-password"
          />
          {error === "bootstrap" && (
            <p className="error-text" role="alert">
              Check your email and make sure both passwords match (12+ characters).
            </p>
          )}
          <SubmitButton />
        </form>
      </div>
    );
  }

  return (
    <div className="container">
      <form className="login-form" action={login}>
        <h1>AI Notetaker</h1>
        <input type="hidden" name="next" value={safeNextPath(next)} />
        <label htmlFor="email">Email</label>
        <input
          id="email"
          name="email"
          type="email"
          className="text-input"
          autoFocus
          required
          autoComplete="email"
        />
        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          className="text-input"
          required
          autoComplete="current-password"
        />
        {error === "1" && (
          <p className="error-text" role="alert">
            That email or password isn&apos;t correct.
          </p>
        )}
        <SubmitButton />
      </form>
      {managedHosting && (
        <form className="login-form" action={signup}>
          <h2>Create a hosted workspace</h2>
          <p className="muted-copy">Start a separate tenant for your team. Your meetings and billing stay isolated from every other customer.</p>
          <label htmlFor="signupWorkspaceName">Workspace name</label>
          <input id="signupWorkspaceName" name="workspaceName" type="text" className="text-input" required maxLength={100} autoComplete="organization" />
          <label htmlFor="signupEmail">Email</label>
          <input id="signupEmail" name="email" type="email" className="text-input" required autoComplete="email" />
          <label htmlFor="signupPassword">Password</label>
          <input id="signupPassword" name="password" type="password" className="text-input" required minLength={12} autoComplete="new-password" />
          <label htmlFor="signupConfirmPassword">Confirm password</label>
          <input id="signupConfirmPassword" name="confirmPassword" type="password" className="text-input" required minLength={12} autoComplete="new-password" />
          {error === "signup" && <p className="error-text" role="alert">Check the workspace name, email, and password, or use another email.</p>}
          <SubmitButton />
        </form>
      )}
    </div>
  );
}
