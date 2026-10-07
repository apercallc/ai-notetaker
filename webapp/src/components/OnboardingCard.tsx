import Link from "next/link";

const DOWNLOAD_PATH = "/download";

export interface OnboardingPlan {
  label: string;
  canSync: boolean;
}

/**
 * Shown instead of a bare "no meetings" line. The library fills from the desktop app once the
 * workspace has a subscription and sync is on, so say exactly that instead of promising notes
 * that only a recording on the desktop can produce.
 */
export function OnboardingCard({ email, managed, plan }: { email: string; managed: boolean; plan: OnboardingPlan | null }) {
  return (
    <section className="onboarding" aria-labelledby="onboarding-heading">
      <h2 id="onboarding-heading">Your library is empty</h2>
      <p className="muted-copy">
        Notes are made in the AI Notetaker desktop app, on your device. With a subscription, finished notes sync here.
      </p>
      <ol className="onboarding-steps">
        <li>
          <strong>Install the desktop app.</strong> <Link href={DOWNLOAD_PATH}>Download it for macOS, Windows or Linux</Link>, then add your own
          provider keys in Settings.
        </li>
        <li>
          <strong>Record a short test.</strong> Start a recording in the app, talk for about half a minute, then stop. Your notes appear in the
          app first.
        </li>
        <li>
          <strong>Turn on sync.</strong>{" "}
          {managed ? (
            <>
              Sign in to the app as <code>{email}</code> (<Link href="/account/connect-desktop">connect the desktop app</Link>). Sync needs a Pro or
              Team plan: <Link href="/billing">see plans</Link>.
            </>
          ) : (
            <>Open the app&apos;s Account &amp; sync settings and connect it to this service.</>
          )}
        </li>
      </ol>
      <p className="onboarding-plan">
        {plan ? (
          <>
            <strong>{plan.label}.</strong> {plan.canSync ? "Cloud sync is on for this workspace." : "Cloud sync is off until you choose a plan."}
          </>
        ) : (
          <>
            <strong>Free.</strong> Nothing here is billed. Your own provider keys stay on your device.
          </>
        )}
      </p>
    </section>
  );
}
