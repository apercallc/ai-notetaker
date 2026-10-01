import Link from "next/link";
import { Download, Laptop, Puzzle, Share2 } from "lucide-react";
import { LIMITS, NOT_LEGAL_ADVICE, SITE, governingLaw, supportEmail } from "./content";
import { Faq } from "./Faq";
import { Icon } from "./Icon";
import { Plans, type PlanDisplay } from "./Plans";
import { chromeWebStoreUrl, formatBytes, type DownloadLinks } from "./release";
import type { ShellContext } from "./Shell";

const UNSIGNED_DOC = "https://github.com/apercallc/ai-notetaker/blob/main/docs/code-signing-policy.md";
const EFFECTIVE = "September 30, 2026";

function PageHead({ title, lede }: { title: string; lede?: string }) {
  return (
    <section className="mk-hero mk-hero--page">
      <div className="mk-wrap">
        <h1 className="mk-h1 mk-h1--page">{title}</h1>
        {lede && <p className="mk-lede">{lede}</p>}
      </div>
    </section>
  );
}

function startHref(context: ShellContext): string {
  return context.signupOpen ? "/login?tab=signup" : "/download";
}

/* ------------------------------------------------------------------ */

export function HowItWorksView({ context }: { context: ShellContext }) {
  return (
    <>
      <PageHead
        title="Set up in a few minutes, your way."
        lede="Choose who runs the AI. Capture works the same either way: it happens on your device, and nothing joins your call."
      />

      <section className="mk-section mk-section--flush" aria-labelledby="choose-title">
        <div className="mk-wrap">
          <h2 className="mk-h2 mk-mb-l" id="choose-title">Which one fits you?</h2>
          <div className="mk-split">
            <div className="mk-guide">
              <h3 className="mk-h3">Choose Hosted AI if you</h3>
              <ul className="mk-bullets">
                <li>want it to work without opening AI provider accounts</li>
                <li>want your notes in a searchable library on any device</li>
                <li>are setting this up for a team</li>
                <li>prefer one predictable monthly price</li>
              </ul>
            </div>
            <div className="mk-guide">
              <h3 className="mk-h3">Choose your own keys if you</h3>
              <ul className="mk-bullets">
                <li>want audio and text to go only to providers you pick</li>
                <li>already have provider keys, or want to shop on price</li>
                <li>want no AI Notetaker account at all</li>
                <li>like keeping everything on your own machine</li>
              </ul>
            </div>
          </div>
          <p className="mk-small mk-mt-m">
            You are never locked in. Switch modes any time in the extension&apos;s Settings.
          </p>
        </div>
      </section>

      <section className="mk-section mk-section--tint" id="hosted" aria-labelledby="hosted-title">
        <div className="mk-wrap">
          <div className="mk-section-head">
            <h2 className="mk-h2" id="hosted-title">Set up Hosted AI</h2>
            <p className="mk-lede">Your first {LIMITS.trial} meetings are free, with no card.</p>
          </div>
          <ol className="mk-steps">
            <li className="mk-step">
              <h3 className="mk-h3">Create your account</h3>
              <p>Sign up with your email and confirm it from the message we send. Your free meetings are ready as soon as you confirm.</p>
              <ul>
                <li>{context.signupOpen ? <Link href="/login?tab=signup">Create an account</Link> : "Sign-up is temporarily closed"}</li>
              </ul>
            </li>
            <li className="mk-step">
              <h3 className="mk-h3">Add the extension</h3>
              <p>Install AI Notetaker in Chrome. For Zoom, Teams or Slack, also install the desktop helper.</p>
              <ul>
                <li><Link href="/download">Go to downloads</Link></li>
              </ul>
            </li>
            <li className="mk-step">
              <h3 className="mk-h3">Sign in and record</h3>
              <p>
                Open the extension, choose Hosted AI, and sign in. Join a meeting, confirm the recording notice, and
                start. Notes appear in your library a minute or two after the call ends.
              </p>
            </li>
          </ol>
        </div>
      </section>

      <section className="mk-section" id="own-keys" aria-labelledby="keys-title">
        <div className="mk-wrap">
          <div className="mk-section-head">
            <h2 className="mk-h2" id="keys-title">Set up with your own keys</h2>
            <p className="mk-lede">Free and account-free. You pay your AI providers directly.</p>
          </div>
          <ol className="mk-steps">
            <li className="mk-step">
              <h3 className="mk-h3">Add the extension</h3>
              <p>Install AI Notetaker in Chrome. You do not need an AI Notetaker account.</p>
              <ul>
                <li><Link href="/download">Go to downloads</Link></li>
              </ul>
            </li>
            <li className="mk-step">
              <h3 className="mk-h3">Pick providers and paste keys</h3>
              <p>
                In onboarding choose Use my own keys, pick a transcription and a summary provider, and paste each key.
                Supported providers include Deepgram, Groq, Anthropic, Gemini and DeepSeek. The extension lets you test each
                key before you finish.
              </p>
            </li>
            <li className="mk-step">
              <h3 className="mk-h3">Record</h3>
              <p>
                Confirm the recording notice and start. Keys stay in protected storage on your device and go only to the
                providers you chose. Notes are saved on your device.
              </p>
            </li>
          </ol>
        </div>
      </section>

      <section className="mk-section mk-section--tint" aria-labelledby="calls-title">
        <div className="mk-wrap">
          <div className="mk-section-head">
            <h2 className="mk-h2" id="calls-title">Which calls can it record?</h2>
          </div>
          <div className="mk-split">
            <div className="mk-guide">
              <h3 className="mk-h3">Google Meet</h3>
              <p className="mk-small">Just the Chrome extension.</p>
              <ol>
                <li>Open a Meet in Chrome.</li>
                <li>Choose <strong>Record this Meet</strong> in the extension or the in-call widget.</li>
                <li>If Chrome blocks auto-start, click the extension icon once and recording begins.</li>
              </ol>
            </div>
            <div className="mk-guide">
              <h3 className="mk-h3">Zoom, Teams, Slack and other desktop calls</h3>
              <p className="mk-small">The extension plus the desktop helper.</p>
              <ol>
                <li>Install the helper for macOS, Windows or Linux.</li>
                <li>Run the guided audio check in onboarding.</li>
                <li>Start recording from the extension or the tray icon.</li>
              </ol>
            </div>
          </div>
          <p className="mk-small mk-mt-m">{NOT_LEGAL_ADVICE}</p>
        </div>
      </section>

      <section className="mk-section mk-section--tint" aria-labelledby="share-title">
        <div className="mk-wrap">
          <div className="mk-section-head">
            <h2 className="mk-h2" id="share-title">Explain it to your team</h2>
            <p className="mk-lede">Free vector infographics you can download, print or link to. Example content only.</p>
          </div>
          <ul className="mk-rows">
            <li className="mk-row">
              <h3 className="mk-h3"><Icon as={Share2} size={22} />How AI Notetaker works</h3>
              <p><a href="/marketing/how-ai-notetaker-works.svg">Download the SVG</a>. Three steps from choosing your call to reviewing what happens next.</p>
            </li>
            <li className="mk-row">
              <h3 className="mk-h3"><Icon as={Share2} size={22} />Example meeting workflows</h3>
              <p><a href="/marketing/meeting-notes-workflows.svg">Download the SVG</a>. Illustrative ideas for project leads, recruiters and consultants.</p>
            </li>
          </ul>
        </div>
      </section>

      <section className="mk-section" aria-labelledby="hiw-faq">
        <div className="mk-wrap">
          <div className="mk-section-head">
            <h2 className="mk-h2" id="hiw-faq">Questions about setup</h2>
          </div>
          <Faq topic="setup" />
          <div className="mk-cta-row">
            <Link className="mk-btn mk-btn--solid" href={startHref(context)}>
              {context.signupOpen ? "Try Hosted AI free" : "Get the extension"}
            </Link>
            <Link className="mk-btn mk-btn--quiet" href="/pricing">See pricing</Link>
          </div>
        </div>
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ */

export function PricingView({ context, prices }: { context: ShellContext; prices: PlanDisplay }) {
  return (
    <>
      <PageHead
        title="Simple pricing. Cancel any time."
        lede="Free with your own AI keys, or one flat monthly price when we run the AI for you."
      />
      <section className="mk-section mk-section--flush" aria-labelledby="plans-title">
        <div className="mk-wrap">
          <h2 className="mk-visually-hidden" id="plans-title">Plans</h2>
          <Plans prices={prices} signupOpen={context.signupOpen} />
        </div>
      </section>
      <section className="mk-section mk-section--tint" aria-labelledby="billing-title">
        <div className="mk-wrap">
          <div className="mk-section-head">
            <h2 className="mk-h2" id="billing-title">How billing works</h2>
          </div>
          <div className="mk-prose">
            <ul>
              <li>Your first {LIMITS.trial} hosted meetings (up to {LIMITS.trialHours} hours in total) are free and need no card. The free allowance is a one-time grant.</li>
              <li>Paid plans are billed monthly in US dollars by Stripe. We never see or store your card number.</li>
              <li>
                Pro includes up to {LIMITS.pro.toLocaleString("en-US")} meetings or {LIMITS.proHours} meeting hours a
                month, whichever comes first, and Team up to {LIMITS.team.toLocaleString("en-US")} meetings or{" "}
                {LIMITS.teamHours} hours. Both reset each billing period, and the extension tells you before a meeting
                starts if you have no meetings or hours left.
              </li>
              <li>
                Ask your notes is a Pro and Team perk: {LIMITS.proQuestions.toLocaleString("en-US")} questions a month on
                Pro and {LIMITS.teamQuestions.toLocaleString("en-US")} on Team. Questions are counted separately from
                meeting hours, reset each billing period, and are not part of the free trial or your-own-keys mode.
              </li>
              <li>Cancel from the billing page. Your plan stays active until the end of the period you paid for.</li>
              <li>If a payment fails, you keep access for a short grace period while Stripe retries.</li>
              <li>Your recordings are always saved on your device first, whatever your plan.</li>
            </ul>
          </div>
        </div>
      </section>
      <section className="mk-section" aria-labelledby="price-faq">
        <div className="mk-wrap">
          <div className="mk-section-head">
            <h2 className="mk-h2" id="price-faq">Pricing questions</h2>
          </div>
          <Faq topic="pricing" />
        </div>
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ */

function AssetButton({ asset, label, primary }: { asset?: { url: string; bytes: number }; label: string; primary?: boolean }) {
  if (!asset) return null;
  const size = formatBytes(asset.bytes);
  return (
    <a className={`mk-btn ${primary ? "mk-btn--solid" : "mk-btn--quiet"}`} href={asset.url}>
      <Icon as={Download} size={18} />
      {label}
      {size && <span className="mk-small">({size})</span>}
    </a>
  );
}

export function DownloadView({
  release,
  platform,
  focus,
}: {
  release: DownloadLinks | null;
  platform?: "macos" | "windows" | "linux";
  focus?: "desktop";
}) {
  const store = chromeWebStoreUrl();
  return (
    <>
      <PageHead
        title="Set up AI Notetaker."
        lede="Add the Chrome extension for Google Meet. Add the desktop helper only if you also meet in Zoom, Teams, Slack or other apps."
      />
      <section className="mk-section mk-section--flush" aria-label="Downloads">
        <div className="mk-wrap">
          <div className={`mk-downloads${focus === "desktop" ? " mk-downloads--desktop-first" : ""}`}>
            <article className="mk-download" aria-labelledby="dl-ext">
              <h2 className="mk-h3" id="dl-ext"><Icon as={Puzzle} size={22} />Chrome extension</h2>
              <p>Records Google Meet with no helper. Required for every setup.</p>
              <div className="mk-cta-row">
                {store && (
                  <a className="mk-btn mk-btn--solid" href={store}>Add to Chrome</a>
                )}
                <AssetButton asset={release?.extension} label={store ? "Download ZIP" : "Download extension ZIP"} />
              </div>
              {!store && !release?.extension && (
                <p className="mk-small">
                  The extension download could not be loaded. Check the{" "}
                  <a href={SITE.releasesUrl}>releases page</a>.
                </p>
              )}
              {!store && release?.extension && (
                <p className="mk-small">
                  Chrome Web Store link coming soon. For now, unzip the file, open <code>chrome://extensions</code>,
                  turn on Developer mode, choose Load unpacked, and select the unzipped folder containing manifest.json.
                </p>
              )}
            </article>

            <article className="mk-download" aria-labelledby="dl-helper">
              <h2 className="mk-h3" id="dl-helper"><Icon as={Laptop} size={22} />Desktop helper</h2>
              <p>For Zoom, Teams, Slack and other desktop calls. Captures your microphone and system audio.</p>
              <p className="mk-notice">
                The installers are not code-signed yet, so macOS and Windows may warn you the first time. The{" "}
                <a href={UNSIGNED_DOC}>install guide</a> shows what to expect.
              </p>
              <div className="mk-cta-row">
                <AssetButton asset={release?.mac} label="macOS (Apple silicon)" primary={platform === "macos"} />
                <AssetButton asset={release?.windows} label="Windows (64-bit)" primary={platform === "windows"} />
                <AssetButton asset={release?.linux} label="Linux (Debian, Ubuntu 64-bit)" primary={platform === "linux"} />
              </div>
              {!release && (
                <p className="mk-small">
                  Direct downloads could not be loaded. Choose the .dmg (Mac), .exe (Windows), or .deb (Linux) on the release page below.
                </p>
              )}
              {release && !release.mac && !release.windows && !release.linux && (
                <p className="mk-small">Installers for this release are on the <a href={release.pageUrl}>release page</a>.</p>
              )}
              <p><a href={release?.pageUrl ?? SITE.releasesUrl}>All desktop downloads on GitHub</a></p>
              <p className="mk-small">Macs with Intel chips are not supported yet.</p>
              <a href="#install-helper">How to install and connect the helper →</a>
            </article>
          </div>

          <div className="mk-prose mk-mt-l mk-setup" id="install-helper">
            <h2>Install the desktop helper</h2>
            <p>Only recording Google Meet? <a href="#choose-ai">Skip to AI setup</a>. For desktop calls, keep the Chrome extension installed too: it controls the helper.</p>
            <details open={platform === "macos"}>
              <summary>macOS · Apple silicon (M1 or newer)</summary>
              {release?.mac?.name.endsWith("-installer.dmg") ? (
                <>
                  <ol>
                    <li>Download and open the Mac .dmg above.</li>
                    <li>Double-click <strong>Install AI Notetaker.command</strong>. A Terminal window opens; choose <strong>Install</strong> in the confirmation dialog. It copies the app to Applications, connects it to Chrome, and opens it.</li>
                    <li>Look for AI Notetaker in your menu bar, then return to the extension and choose <strong>Check desktop helper</strong>.</li>
                  </ol>
                  <p>This release is not notarized by Apple. The installer asks you to approve this app only; your other Mac security settings stay unchanged. If macOS blocks the installer, see the <a href={UNSIGNED_DOC}>first-open guide</a>.</p>
                </>
              ) : (
                <>
                  <ol>
                    <li>Download the Mac .dmg above, open it, and drag <strong>AI Notetaker</strong> into <strong>Applications</strong>.</li>
                    <li>Open AI Notetaker from Applications. If macOS says it is damaged, follow the <a href={UNSIGNED_DOC}>Mac repair guide</a> before continuing.</li>
                    <li>Connect it to Chrome once: open <strong>Terminal</strong>, paste the command below, and press Return.</li>
                  </ol>
                  <pre><code>sh &quot;/Applications/AI Notetaker.app/Contents/Resources/scripts/install-native-messaging.sh&quot;</code></pre>
                  <p>Older downloads require this browser connection step. New guided installers perform it for you.</p>
                </>
              )}
            </details>
            <details open={platform === "windows"}>
              <summary>Windows · 64-bit Intel / AMD</summary>
              <ol>
                <li>Download and run the Windows .exe above, then follow the installer.</li>
                <li>If SmartScreen blocks this unsigned installer, review the <a href={UNSIGNED_DOC}>first-open guide</a>.</li>
                <li>Launch <strong>AI Notetaker</strong> from Start. Look for its icon in the system tray, including the hidden-icons menu. The installer connects it to Chrome.</li>
              </ol>
            </details>
            <details open={platform === "linux"}>
              <summary>Linux · Debian / Ubuntu, 64-bit Intel / AMD</summary>
              <ol>
                <li>Download the Linux .deb above and open it with your system&apos;s Software Install app.</li>
                <li>Choose <strong>Install</strong> and approve the system prompt. The package installs the browser connection and required audio utilities.</li>
                <li>Launch <strong>AI Notetaker</strong> from your applications menu and look for its tray icon.</li>
              </ol>
            </details>
            <h3>Connect and check the audio</h3>
            <ol>
              <li>Open the AI Notetaker Chrome extension from a tab outside Google Meet. If shown, choose <strong>Recording Zoom or Teams instead?</strong>, then <strong>Set up desktop capture</strong>. If the helper is already connected, use the audio check in the popup.</li>
              <li>Choose <strong>Check desktop helper</strong>. Once connected, continue to the audio check.</li>
              <li>Keep your normal microphone and speakers selected. Grant the requested microphone and system-audio permissions, then run the <strong>2-second test</strong>. Follow any fallback instructions shown for your device.</li>
            </ol>
            <details>
              <summary>Helper still not detected?</summary>
              <p>Make sure AI Notetaker is running from its installed location. On Mac, complete the Terminal step above. Close and reopen Chrome, then check again. If setup says it is paired with another browser, choose <strong>Pair New Browser</strong> from the helper&apos;s menu.</p>
            </details>
          </div>

          <div className="mk-prose mk-mt-l mk-setup" id="choose-ai">
            <h2>Choose how your notes are written</h2>
            <p>In the extension setup, choose <strong>Hosted AI</strong> and sign in to your AI Notetaker account, or create one. Our service is already configured; there is no server URL to enter.</p>
            <p>Prefer your own providers? Choose <strong>Use my own API keys</strong> and follow the key checks. This mode requires no AI Notetaker account. Connecting a self-hosted history server is optional, under Settings.</p>
            <h2>Make your first recording</h2>
            <p>For Google Meet, open a meeting in Chrome and choose <strong>Start notes</strong> in the call widget or extension. For a desktop call, open the extension from a tab outside Meet, choose <strong>Recording Zoom or Teams instead?</strong> if shown, then <strong>Start notes</strong>. Tell participants and confirm the recording notice. Stop when you finish; the extension shows processing progress and your notes when ready.</p>
          </div>

          <div className="mk-prose mk-mt-l">
            <h2>Before you install</h2>
            <p>
              The <a href={UNSIGNED_DOC}>install guide</a> shows how to continue safely without turning off system
              protections. Each release lists SHA-256 checksums, which help you confirm the file was not damaged or
              changed. They do not by themselves prove who published it.
            </p>
            {release && (
              <p>
                Latest release: <a href={release.pageUrl}>{release.tag}</a>. All versions are on the{" "}
                <a href={SITE.releasesUrl}>releases page</a>, and the <a href={SITE.repoUrl}>source</a> is public.
              </p>
            )}
          </div>
        </div>
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ */

const COMPARE_ROWS: { label: string; bot: string; ours: string }[] = [
  { label: "How it records", bot: "A bot account joins the call as a participant.", ours: "Records on your own device, from your browser tab and microphone or your system audio." },
  { label: "What others see", bot: "An extra attendee, often with a notice.", ours: "Nothing added to the call. You still need to tell people and get consent." },
  { label: "Where the recording lives", bot: "On the vendor's servers.", ours: "On your device first, before any provider is called." },
  { label: "Audio channels", bot: "Usually one mixed track.", ours: "Your microphone and the meeting's audio are kept separate, so \"you\" is never guessed." },
  { label: "Desktop apps", bot: "Depends on the vendor's integrations.", ours: "Zoom, Teams, Slack and others through the desktop helper." },
  { label: "Who runs the AI", bot: "The vendor.", ours: "Your choice: your own provider keys, or our Hosted AI." },
  { label: "Pricing", bot: "Commonly a per-seat subscription.", ours: "Free with your own keys, or a flat monthly price for Hosted AI." },
  { label: "Source code", bot: "Usually closed.", ours: `Open source under the ${SITE.license} license.` },
];

export function CompareView({ context }: { context: ShellContext }) {
  return (
    <>
      <PageHead
        title="Bot notetakers and AI Notetaker, side by side."
        lede="A bot joins your call as an extra participant. AI Notetaker records from your own device instead. Here is what that changes."
      />
      <section className="mk-section mk-section--flush" aria-label="Comparison">
        <div className="mk-wrap">
          <div className="mk-table-wrap" role="region" aria-label="Comparison table, scrolls sideways on small screens" tabIndex={0}>
            <table className="mk-table">
              <caption>How the two approaches differ</caption>
              <thead>
                <tr>
                  <th scope="col"><span className="mk-visually-hidden">Topic</span></th>
                  <th scope="col">Typical bot notetaker</th>
                  <th scope="col">AI Notetaker</th>
                </tr>
              </thead>
              <tbody>
                {COMPARE_ROWS.map((row) => (
                  <tr key={row.label}>
                    <th scope="row">{row.label}</th>
                    <td>{row.bot}</td>
                    <td>{row.ours}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mk-small mk-mt-s">
            Bot notetakers differ from one another. This describes the common pattern, not any single product.
          </p>
        </div>
      </section>
      <section className="mk-section mk-section--tint" aria-labelledby="when-title">
        <div className="mk-wrap">
          <div className="mk-section-head">
            <h2 className="mk-h2" id="when-title">When a bot is the better choice</h2>
          </div>
          <div className="mk-prose">
            <p>
              A bot can join a scheduled meeting when you are not there, and it needs nothing installed on your
              computer. If you need notes from calls you will not attend, or you cannot install software, a bot may suit
              you better. AI Notetaker is for people who are in the call and want their recording to stay under their
              control.
            </p>
          </div>
          <div className="mk-cta-row">
            <Link className="mk-btn mk-btn--solid" href={startHref(context)}>
              {context.signupOpen ? "Try Hosted AI free" : "Get the extension"}
            </Link>
            <Link className="mk-btn mk-btn--quiet" href="/how-it-works">See how it works</Link>
          </div>
        </div>
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ */

const SUBPROCESSORS: { name: string; role: string; data: string }[] = [
  { name: "Groq", role: "Transcription in Hosted AI", data: "Meeting audio, while it is being transcribed" },
  { name: "OpenAI", role: "Summaries and Ask your notes in Hosted AI", data: "Transcript text while the summary is written, and your question plus the note excerpts relevant to it while an answer is written" },
  { name: "Anthropic", role: "Alternative provider for summaries and Ask your notes, used only if the service is switched to it", data: "The same text OpenAI would receive: transcript text for summaries, and your question with relevant note excerpts for answers" },
  { name: "Railway", role: "Hosting, database and temporary audio staging", data: "Account records, notes, and audio until processing finishes" },
  { name: "Stripe", role: "Payments and billing portal", data: "Your email and payment details, which Stripe collects directly" },
  { name: "Resend", role: "Sign-up and password-reset email", data: "Your email address" },
  { name: "Sentry", role: "Error diagnostics for the hosted service", data: "Technical error details and workspace-safe identifiers, not designed to include audio or transcript text" },
  { name: "Google", role: "Sign-in, and Drive export only if you connect it", data: "What you choose to sync or export" },
];

export function PrivacyView() {
  const contact = supportEmail();
  return (
    <>
      <PageHead title="Privacy notice" lede={`Effective ${EFFECTIVE}. Plain language, specific about where your data goes.`} />
      <section className="mk-section mk-section--flush">
        <div className="mk-wrap">
          <div className="mk-prose">
            <p>
              AI Notetaker has two modes and this notice covers both: free local mode with your own AI keys, and Hosted
              AI, the service we operate. It also covers this website.
            </p>

            <h2>This website</h2>
            <p>
              The site sets no advertising or analytics cookies and runs no advertising or analytics scripts. Fonts and
              icons are served from this site. If you create an account, we set one session cookie so you stay signed
              in. If a page hits an error, a technical error report may be sent to Sentry. Download links are looked up
              by our server, so your browser does not contact GitHub until you follow a link to it.
            </p>

            <h2>Local mode: your own keys</h2>
            <ul>
              <li>Raw microphone and meeting audio is saved on your device before any provider request. The two channels stay separate.</li>
              <li>Your provider keys stay in protected extension storage. We never receive them.</li>
              <li>Audio and text go directly to the providers you configure, under their terms and retention rules.</li>
              <li>We do not receive local-mode recordings, transcripts or notes, and local mode sends us no telemetry or error reports.</li>
              <li>Google Drive export and a self-hosted history server are optional. Their operators receive what you send them.</li>
            </ul>

            <h2>Hosted AI: what we collect</h2>
            <ul>
              <li><strong>Account:</strong> your email address, a salted and hashed password, and your workspace and membership details.</li>
              <li><strong>Notes:</strong> the transcripts, summaries, decisions and action items generated from your meetings, stored in your workspace.</li>
              <li><strong>Usage and billing:</strong> how many meetings, meeting hours and Ask-your-notes questions you have used this period, and your plan status. Stripe holds your payment details, not us.</li>
              <li><strong>Ask your notes:</strong> when you ask a question, the service searches only your workspace and sends your question with the matching excerpts of your notes to the summary provider to write the answer. Questions and answers are not saved; we keep only a count for your allowance.</li>
              <li><strong>Sign-in and security records:</strong> when you sign in we record a description of your device, your IP address and timestamps. We use them to show your signed-in devices, let you revoke them, limit repeated failed sign-ins, and investigate abuse. A session or extension token ends when you sign out, revoke it, or it expires.</li>
              <li><strong>Audio:</strong> uploaded to private, temporary storage only so it can be transcribed. It is deleted as soon as processing succeeds, and uploads that never finish are removed within 24 hours. We do not keep recordings, and there is no playback or download of audio in the hosted library.</li>
            </ul>
            <p>
              Every workspace is isolated from the others. Provider credentials for Hosted AI live on our servers and are
              never sent to your browser or extension. Server logs use workspace-safe identifiers and failure
              categories, not audio, transcript text, keys or tokens.
            </p>

            <h2>Who is responsible for your notes</h2>
            <p>
              The people in your meetings are people too. When you record a call, the notes contain what they said. For
              the notes and recordings in your workspace, you (or the organization that owns the workspace) decide what is
              recorded and why, and we process that content only on your behalf to provide the service. For your account,
              sign-in, billing and security records, we decide how the data is used, as described here. If your
              organization needs a data processing agreement, contact us.
            </p>
            <p>
              We do not sell your personal information, do not share it for advertising, and do not use your recordings,
              transcripts or notes to train AI models. The providers below receive content only to perform the task we
              send them and handle it under their own terms, which may include limited safety or abuse-monitoring
              retention.
            </p>

            <h2>Sensitive information</h2>
            <p>
              Do not record or upload information that law or contract requires a special regime for, such as protected
              health information, payment card data, or government identification numbers, unless you have confirmed that
              this service is suitable for it. Hosted AI is not offered as a HIPAA-compliant service.
            </p>

            <h2>Who processes data for Hosted AI</h2>
          </div>
          <div className="mk-table-wrap mk-table-wrap--narrow" role="region" aria-label="Service providers, scrolls sideways on small screens" tabIndex={0}>
            <table className="mk-table">
              <caption>Service providers used by the hosted service</caption>
              <thead>
                <tr>
                  <th scope="col">Provider</th>
                  <th scope="col">Used for</th>
                  <th scope="col">Data involved</th>
                </tr>
              </thead>
              <tbody>
                {SUBPROCESSORS.map((row) => (
                  <tr key={row.name}>
                    <th scope="row">{row.name}</th>
                    <td>{row.role}</td>
                    <td>{row.data}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mk-prose">
            <p className="mk-mt-s">
              Each provider handles the data it receives under its own terms and privacy policy. Providers and the
              servers that run the service may be located in the United States and other countries, so your data can be
              processed outside the country where you live. We may add or replace providers and will update this table
              when we do.
            </p>

            <h2 id="google">Google sign-in and Drive</h2>
            <p>
              Connecting Google is optional and always your choice. If you connect Drive, AI Notetaker asks only for
              access to the files it creates in your Drive, so it can export a meeting you choose as a Google Doc. It
              does not request access to your other Drive files, your calendar, or your email.
            </p>
            <ul>
              <li>We store your Google account email and encrypted access tokens so these features keep working. Choosing Disconnect in your account deletes them.</li>
              <li>If you choose Continue with Google to sign in or create an account, we receive only your Google email address and whether Google has verified it. We use it to find or create your account and keep no Google access token for sign-in.</li>
              <li>We use Google data only to provide sign-in and Drive export. We do not use it for advertising, sell it, or use it to train AI models.</li>
              <li>We do not let people read your Google data unless you ask us to, it is needed to investigate abuse or a security problem, or the law requires it.</li>
              <li>You can also remove access at any time from your <a href="https://myaccount.google.com/permissions">Google Account permissions</a>.</li>
            </ul>
            <p>
              AI Notetaker&apos;s use and transfer to any other app of information received from Google APIs adheres to the{" "}
              <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>,
              including the Limited Use requirements.
            </p>

            <h2>Self-hosted history</h2>
            <p>
              If you run the optional history app yourself, notes go to the server you chose. You control its access,
              storage, backups and retention, and you are responsible for it.
            </p>

            <h2>Keeping, deleting and exporting your data</h2>
            <ul>
              <li>Delete any meeting or folder from the app. In Hosted AI it moves to Trash, where you can restore it for 30 days; after that, or when you delete it from Trash, its transcript and summary are removed.</li>
              <li>Workspace owners choose how long hosted notes are kept, and you can export your data from the account page.</li>
              <li>We keep account data while your account exists. After you delete an account or workspace, its notes and account records are removed, and copies in system backups are overwritten on the normal backup schedule. We keep records that the law or our tax and fraud-prevention duties require, such as billing records held by Stripe, for as long as they require.</li>
              <li>
                <strong>Clearing your browser history does not delete your notes.</strong> Hosted AI notes live in your
                workspace on our servers, so they are unaffected by anything you do in your browser; if you clear cookies
                you only need to sign in again. In local mode, notes are stored in the extension on your device, and
                clearing history, cookies or cache leaves them alone. They are removed if you uninstall the extension,
                delete the Chrome profile, or reset or lose the device, and nothing is stored on our servers to restore
                them. A self-hosted history server keeps its own copy of what was synced to it. To keep local notes
                safe, sync them to Hosted AI or your own history server, or export the ones you need.
              </li>
              <li>Deleting the extension does not delete files the helper saved on your device, provider account data, exported files, or data on a server you set up. Delete those where they live.</li>
            </ul>

            <h2>Your rights</h2>
            <p>
              Depending on where you live, you may have the right to access, correct, delete, export or restrict the use
              of your personal information, to object to some uses, to withdraw consent you gave, and to complain to your
              data protection authority. Most of this you can do yourself: export from the account page, delete
              meetings, disconnect Google, revoke devices, or delete your account. For anything else, contact us. We
              will not treat you worse for exercising a privacy right. If you are a participant in someone else&apos;s
              meeting, ask the person or organization that recorded it first, because they control that recording; we
              will help where we can.
            </p>

            <h2>Children</h2>
            <p>
              AI Notetaker is not for anyone under 16, and we do not knowingly collect personal information from children.
              If you believe a child has an account, contact us and we will delete it.
            </p>

            <h2>Security incidents</h2>
            <p>
              We protect data with access controls, workspace isolation, encryption in transit, and encrypted storage of
              Google tokens, but no system is perfectly secure. If an incident affects your personal information, we
              will notify you and the authorities where the law requires it.
            </p>

            <h2>Meeting participants</h2>
            <p>{NOT_LEGAL_ADVICE}</p>

            <h2>Security and contact</h2>
            <p>
              The source code is public. Report a suspected vulnerability privately through the{" "}
              <a href={SITE.securityUrl}>security policy</a>. For questions about this notice,{" "}
              {contact ? <>email <a href={`mailto:${contact}`}>{contact}</a> or </> : null}open an issue on the{" "}
              <a href={SITE.supportUrl}>project&apos;s issue tracker</a>, and never post keys, recordings or transcripts
              there. We will show a new effective date whenever this notice changes, and tell signed-in users about material changes in the app or by email before they take effect.
            </p>
          </div>
        </div>
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ */

export function TermsView() {
  const contact = supportEmail();
  const law = governingLaw();
  return (
    <>
      <PageHead title="Terms of use" lede={`Effective ${EFFECTIVE}. These cover this website, the software, and the Hosted AI service.`} />
      <section className="mk-section mk-section--flush">
        <div className="mk-wrap">
          <div className="mk-prose">
            <h2>The software</h2>
            <p>
              AI Notetaker&apos;s source code is provided under the <a href={SITE.licenseUrl}>{SITE.license} License</a>.
              That license sets the warranty and liability terms for the software, and these terms do not narrow it.
            </p>

            <h2>Recording and consent</h2>
            <p>
              You decide whether and how to record a meeting. You are responsible for notifying participants and
              obtaining the consent that law, workplace policy or your agreements require, wherever each participant is
              located. An in-app reminder is not legal advice and does not obtain consent for you.
            </p>

            <h2>Hosted AI accounts</h2>
            <ul>
              <li>You must be at least 16 years old, and able to form a binding contract, to use Hosted AI. If you use it for an organization, you confirm you may bind it to these terms.</li>
              <li>Give us a real email address and keep your password private. You are responsible for activity in your account and workspace.</li>
              <li>Workspace owners manage members and are responsible for what their members record and store.</li>
              <li>You keep ownership of your recordings and notes. You give us a limited license to store, process, transmit to the providers listed in the privacy notice, and display them, and to create summaries, action items and answers from them, solely to provide the service to you. We do not use them to train AI models.</li>
              <li>You are responsible for your content, for having the right to record and process it, and for the consent of the people in it. You must not upload content you have no right to use.</li>
              <li>Do not use the service to break the law or anyone&apos;s rights, to record people unlawfully, to process regulated sensitive data described in the privacy notice, to attack, overload, scrape or reverse engineer the hosted service, to get around plan limits, to resell access, or to try to access another workspace&apos;s data.</li>
              <li>If your use of the service, including a recording made without a required consent, results in a claim against us, you agree to cover our reasonable losses from that claim to the extent the law allows.</li>
            </ul>

            <h2>Plans and billing</h2>
            <ul>
              <li>Hosted Pro and Hosted Team are monthly subscriptions billed in US dollars through Stripe. Each includes the monthly meeting, meeting-hours and Ask-your-notes question allowances shown on the pricing page.</li>
              <li>Your first {LIMITS.trial} hosted meetings are a free one-time allowance, and Ask your notes is not included in it. When an allowance is used up, that feature stops until the next period or a plan change.</li>
              <li>Ask your notes answers are generated by AI from your notes and can be incomplete or wrong. Check the linked notes before you rely on an answer.</li>
              <li>Cancel from the billing page. The plan stays active until the end of the period you already paid for, and it does not renew.</li>
              <li>
                Fees for a billing period that has started are not refunded, except where the law requires it or we
                could not provide the service. If you were charged by mistake or twice, contact us within 14 days and
                we will review it and refund what was charged in error.
              </li>
              <li>If a payment fails, access continues for a short grace period while Stripe retries, and then processing stops.</li>
              <li>Allowances are fair-use limits that exist to keep the service affordable. We may rate-limit requests or the number of simultaneous questions to protect it. We may change prices, plans and allowances for future billing periods, and will tell subscribers in advance; a change does not affect a period you have already paid for.</li>
            </ul>

            <h2>Your data, export and deletion</h2>
            <p>
              You can download all of a workspace&apos;s meetings from the Account page at any time. Deleting your
              account, or a workspace you own, permanently removes its meetings and cancels any active subscription
              first; audio staged for processing is deleted after processing or within 24 hours. Deleted data cannot be
              recovered, apart from copies in system backups that are overwritten on the normal schedule. You can stop using the service at
              any time. We may suspend or end an account that breaks these terms, is unpaid, or puts the service or other people at
              risk, and will tell you why where we can. If we end your account without cause, we will give you a reasonable chance to export
              your data first. Sections that by their nature should continue after an account ends, such as ownership, liability and disputes,
              continue.
            </p>

            <h2>AI output and your own keys</h2>
            <p>
              Transcripts, summaries, action items and answers are produced by AI and can be incomplete, wrong or
              misleading, including misattributing who said something. Check anything important against the recording or the
              source note before you rely on it. They are not legal, medical, financial or other professional advice, and
              you are responsible for decisions you make using them. In local mode you are responsible for your provider
              accounts, keys, fees and their terms.
            </p>

            <h2>Third-party services</h2>
            <p>
              The service depends on providers such as hosting, transcription, language-model, payment and email
              services. We are not responsible for their outages, changes or acts, and your use of a provider you choose
              yourself, such as in local mode or Google Drive, is under that provider&apos;s terms.
            </p>

            <h2>Downloads</h2>
            <p>
              Download software from the linked project releases and check each release&apos;s notes and checksums.
              Current desktop installers are not code-signed and may show operating-system warnings. A checksum helps
              detect a changed or damaged file, but it does not establish who published it.
            </p>

            <h2>Liability</h2>
            <p>
              The Hosted AI service is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;. To the extent the law
              allows, we give no warranty that it will be uninterrupted, error-free or that its output will be accurate,
              and we disclaim implied warranties such as merchantability and fitness for a particular purpose. To the same
              extent, we are not liable for indirect, incidental, special or consequential losses, lost profits, lost
              data, or losses from a recording made without a required consent or from your reliance on AI output, and
              our total liability for the Hosted AI service is limited to the amount you paid for it in the 12 months
              before the claim. This does not limit liability that the law does not allow to be limited.
            </p>
            {law && (
              <>
                <h2>Governing law</h2>
                <p>These terms are governed by the laws of {law}, without regard to its conflict-of-law rules.</p>
              </>
            )}

            <h2>Disputes</h2>
            <p>
              Before starting a formal claim, contact us and give us 30 days to try to resolve it informally.
            </p>

            <h2>Availability and changes</h2>
            <p>
              We work to keep the service running but do not promise uninterrupted availability or a support response
              time. Features, limits and prices can change. We will show a new effective date when these terms change,
              and tell signed-in users about material changes in the app or by email before they take effect; if you
              keep using the service afterwards, you accept the updated terms, and if you do not agree you can stop and
              delete your account. Nothing here removes a right or protection that the law does not allow to be excluded.
            </p>

            <h2>General</h2>
            <p>
              These terms, the privacy notice and the software license are the whole agreement about the service. If part
              of these terms cannot be enforced, the rest still applies. Not enforcing a term is not a waiver of it. You
              may not transfer your account to someone else, and we may transfer ours to a successor operator of the
              service.
            </p>

            <h2>Contact</h2>
            <p>
              {contact ? <>Email <a href={`mailto:${contact}`}>{contact}</a>, or raise </> : "Raise "}questions on the{" "}
              <a href={SITE.supportUrl}>project&apos;s issue tracker</a>, without posting private meeting content, keys or
              personal information.
            </p>
            <p className="mk-small">These terms are plain-language project information and are not legal advice.</p>
          </div>
        </div>
      </section>
    </>
  );
}

