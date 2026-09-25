import { CopyButton } from "./CopyButton";

const RELEASES_URL = "https://github.com/apercallc/ai-notetaker/releases/latest";

export interface OnboardingPlan {
  label: string;
  isTrial: boolean;
  used: number;
  limit: number;
}

/**
 * Shown instead of a bare "no meetings" line. It answers the only question a
 * new account has — what do I do now? — and it never prints a password.
 */
export function OnboardingCard({
  email,
  origin,
  managed,
  plan,
}: {
  email: string;
  origin: string;
  managed: boolean;
  plan: OnboardingPlan | null;
}) {
  return (
    <section className="onboarding" aria-labelledby="onboarding-heading">
      <h2 id="onboarding-heading">Record your first meeting</h2>
      <p className="muted-copy">Your notes show up here a minute or two after a call ends.</p>
      <ol className="onboarding-steps">
        <li>
          <strong>Install the extension.</strong>{" "}
          <a href={RELEASES_URL} target="_blank" rel="noreferrer">Get AI Notetaker for Chrome</a>
          <span className="muted-copy"> (until the Chrome Web Store listing is live, load the release download unpacked).</span>
        </li>
        <li>
          <strong>Sign in from the extension.</strong>{" "}
          {managed ? (
            <>Open it, choose Hosted AI, and sign in as <code>{email}</code>.</>
          ) : (
            <>Open its settings and connect this server with the <code>AUTH_TOKEN</code> you deployed it with.</>
          )}
          <div className="onboarding-address">
            <span className="muted-copy">Service address</span>
            <code>{origin}</code>
            <CopyButton text={origin} label="Copy address" className="button button-secondary button-small" />
          </div>
        </li>
        <li>
          <strong>Record a 30-second test.</strong> Start notes on any Meet call or a video playing in a tab, talk for about
          half a minute, then stop.
        </li>
      </ol>
      <p className="onboarding-plan">
        {plan ? (
          <>
            <strong>{plan.label}.</strong>{" "}
            {plan.isTrial
              ? `${Math.max(0, plan.limit - plan.used)} of ${plan.limit} free meetings left.`
              : plan.limit > 0
                ? `${plan.used} of ${plan.limit} meetings used this period.`
                : "Hosted processing isn't part of this plan."}
          </>
        ) : (
          <>
            <strong>Free local mode.</strong> Bring your own provider keys; nothing here is billed.
          </>
        )}
      </p>
    </section>
  );
}
