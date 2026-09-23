import { prisma } from "@/lib/db";
import { bootstrap, login } from "./actions";
import { SubmitButton } from "./SubmitButton";
import { safeNextPath } from "@/lib/navigation";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next = "/meetings", error } = await searchParams;
  const userCount = await prisma.user.count();

  if (userCount === 0) {
    return (
      <div className="container">
        <form className="login-form" action={bootstrap}>
          <h1>AI Notetaker</h1>
          <p className="muted-copy">
            Create the first account for this instance. You&apos;ll be its workspace owner.
          </p>
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
        {error && (
          <p className="error-text" role="alert">
            That email or password isn&apos;t correct.
          </p>
        )}
        <SubmitButton />
      </form>
    </div>
  );
}
