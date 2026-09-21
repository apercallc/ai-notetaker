import { login } from "./actions";
import { SubmitButton } from "./SubmitButton";
import { safeNextPath } from "@/lib/navigation";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next = "/meetings", error } = await searchParams;

  return (
    <div className="container">
      <form className="login-form" action={login}>
        <h1>AI Notetaker</h1>
        <p className="muted-copy">
          Enter the access token you set when you deployed this instance.
        </p>
        <input type="hidden" name="next" value={safeNextPath(next)} />
        {/* Hidden username field: this app has no username, only a shared
            token, but browsers/password managers expect one alongside a
            password-type field for their autofill heuristics to work. */}
        <input
          type="text"
          name="username"
          value="ai-notetaker"
          readOnly
          hidden
          autoComplete="username"
        />
        <label htmlFor="token">Access token</label>
        <input
          id="token"
          name="token"
          type="password"
          className="text-input"
          autoFocus
          required
          autoComplete="current-password"
        />
        {error && <p className="error-text" role="alert">That token isn&apos;t correct.</p>}
        <SubmitButton />
      </form>
    </div>
  );
}
