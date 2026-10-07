import Link from "next/link";
import { Download, Laptop, Puzzle, Share2 } from "lucide-react";
import { NOT_LEGAL_ADVICE, SITE, governingLaw, supportEmail } from "./content";
import { Faq } from "./Faq";
import { Icon } from "./Icon";
import { Plans, type PlanDisplay } from "./Plans";
import { chromeWebStoreUrl, formatBytes, type DownloadLinks } from "./release";
import type { ShellContext } from "./Shell";

const UNSIGNED_DOC = "https://github.com/apercallc/ai-notetaker/blob/main/docs/code-signing-policy.md";
const ACCEPTANCE_DOC = "https://github.com/apercallc/ai-notetaker/blob/main/docs/launch/release-candidate-checklist.md";
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

function startHref(): string {
  return "/download";
}

/* ------------------------------------------------------------------ */

export function HowItWorksView({ context }: { context: ShellContext }) {
  return (
    <>
      <PageHead
        title="Local notes, with optional web access."
        lede="One desktop app records browser and desktop meetings on macOS, Windows, and Linux, and makes your notes with your own AI provider keys. An optional Chrome extension can record a browser tab. No bot joins the call."
      />

      <section className="mk-section mk-section--flush" aria-labelledby="choose-title">
        <div className="mk-wrap">
          <h2 className="mk-h2 mk-mb-l" id="choose-title">Local setup is the default</h2>
          <div className="mk-split">
            <div className="mk-guide">
              <h3 className="mk-h3">Use your provider API keys</h3>
              <ul className="mk-bullets">
                <li>choose and pay your transcription and summary providers directly</li>
                <li>keep provider keys in your operating-system credential store</li>
                <li>record browser or desktop calls without an AI Notetaker account</li>
                <li>in desktop, save raw audio and notes on this device first</li>
              </ul>
            </div>
            <div className="mk-guide">
              <h3 className="mk-h3">Sync notes only if you want</h3>
              <ul className="mk-bullets">
                <li>sign in from the desktop app and choose a Pro or Team plan</li>
                <li>finished desktop notes sync to the web app and your other devices</li>
                <li>workspace notes are copied into the desktop library</li>
                <li>raw audio and provider keys stay on this device</li>
              </ul>
            </div>
          </div>
          <p className="mk-small mk-mt-m">
            Sync (Pro or Team) sends finished desktop notes to the workspace and copies workspace notes into the desktop library. Web edits refresh workspace copies on the next sync. Desktop-origin notes are protected from automatic overwrites; deletions and settings do not sync back. Browser extension recordings still need archive export and import.
          </p>
        </div>
      </section>

      <section className="mk-section mk-section--tint" id="sync" aria-labelledby="sync-title">
        <div className="mk-wrap">
          <div className="mk-section-head">
            <h2 className="mk-h2" id="sync-title">Sync your notes (optional, subscription)</h2>
            <p className="mk-lede">Cloud sync is part of the Pro and Team plans. It sends finished desktop notes to your workspace so you can read them on the web and on your other devices. Local recording stays account-free.</p>
          </div>
          <ol className="mk-steps">
            <li className="mk-step">
              <h3 className="mk-h3">Create your account</h3>
              <p>A free account lets you sign in and manage your devices. Sync starts when the workspace has a Pro or Team plan.</p>
              <ul>
                <li>{context.signupOpen ? <Link href="/login?tab=signup">Create an account</Link> : "Sign-up is temporarily closed"}</li>
              </ul>
            </li>
            <li className="mk-step">
              <h3 className="mk-h3">Choose a plan</h3>
              <p>Pick Pro for your own devices or Team to share a workspace.</p>
              <ul>
                <li><Link href="/pricing">See plans</Link></li>
              </ul>
            </li>
            <li className="mk-step">
              <h3 className="mk-h3">Sign in from the desktop app</h3>
              <p>Open Settings → Account &amp; sync and sign in, or use the one-time code from your account page. Finished desktop notes then sync; raw audio and provider keys stay local.</p>
            </li>
          </ol>
        </div>
      </section>

      <section className="mk-section" id="own-keys" aria-labelledby="keys-title">
        <div className="mk-wrap">
          <div className="mk-section-head">
            <h2 className="mk-h2" id="keys-title">Set up with API keys</h2>
            <p className="mk-lede">Free and account-free. You pay your AI providers directly.</p>
          </div>
          <ol className="mk-steps">
            <li className="mk-step">
              <h3 className="mk-h3">Install the desktop app</h3>
              <p>Preview installers are available on Downloads. They are unsigned, and platform capture checks are still in progress. Local recording does not require an AI Notetaker account.</p>
              <ul>
                <li><Link href="/download">Go to downloads</Link></li>
              </ul>
            </li>
            <li className="mk-step">
              <h3 className="mk-h3">Pick providers and paste keys</h3>
              <p>
                In desktop Settings, choose transcription and summary providers, paste each key, and test them before saving.
                Supported providers include Deepgram, Groq, Anthropic, Gemini and DeepSeek.
              </p>
            </li>
            <li className="mk-step">
              <h3 className="mk-h3">Record</h3>
              <p>
                Confirm recording consent and start. Keys stay in protected storage on your device and go only to the
                providers you chose. Raw audio and notes are saved locally first.
              </p>
            </li>
          </ol>
        </div>
      </section>

      <section className="mk-section mk-section--tint" aria-labelledby="calls-title">
        <div className="mk-wrap">
          <div className="mk-section-head">
            <h2 className="mk-h2" id="calls-title">Choose how to capture your meeting.</h2>
          </div>
          <div className="mk-split">
            <div className="mk-guide">
              <h3 className="mk-h3">Meetings in Chrome</h3>
              <p className="mk-small">Use the extension for a meeting playing in the current Chrome tab, including web versions of Meet, Zoom, Teams, Slack, and Discord.</p>
              <ol>
                <li>Join the meeting in Chrome. Use its floating recording control, the extension toolbar popup, or the recording shortcut.</li>
                <li>Confirm the recording notice. The extension saves tab and microphone audio separately in Chrome.</li>
                <li>Export the archive and import it in the desktop app to transcribe the audio and create notes.</li>
              </ol>
            </div>
            <div className="mk-guide">
              <h3 className="mk-h3">Browser or desktop meeting</h3>
              <p className="mk-small">Use AI Notetaker for macOS, Windows, or Linux for direct system-audio capture.</p>
              <ol>
                <li>Check the detected microphone and system audio in the app. Change your OS input or output if needed.</li>
                <li>Grant OS audio permissions and run the audio check.</li>
                <li>Start and stop from the desktop app, then review notes locally.</li>
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
            <Link className="mk-btn mk-btn--solid" href={startHref()}>Get the desktop app</Link>
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
        lede="The desktop app is free with your own AI keys. A subscription adds cloud sync and team sync."
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
              <li>The desktop app and a free account cost nothing, and need no card.</li>
              <li>Paid plans are billed monthly in US dollars by Stripe. We never see or store your card number.</li>
              <li>Pro syncs your finished notes across your devices. Team adds a shared workspace for your teammates.</li>
              <li>Without a subscription your notes stay on your device and keep working. Nothing is deleted when a plan ends.</li>
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

function AssetButton({ asset, label, accessibleLabel, primary }: { asset?: { url: string; bytes: number }; label: string; accessibleLabel?: string; primary?: boolean }) {
  if (!asset) return null;
  const size = formatBytes(asset.bytes);
  return (
    <a className={`mk-btn ${primary ? "mk-btn--solid" : "mk-btn--quiet"}`} href={asset.url} aria-label={accessibleLabel}>
      <Icon as={Download} size={18} />
      {label}
      {size && <span className="mk-small">({size})</span>}
    </a>
  );
}

export function DownloadView({
  release,
  platform,
}: {
  release: DownloadLinks | null;
  platform?: "macos" | "windows" | "linux";
}) {
  const store = chromeWebStoreUrl();
  const desktopAssets = [
    { platform: "macos", label: "macOS · Apple silicon", asset: release?.mac },
    { platform: "macos-intel", label: "macOS · Intel", asset: release?.macIntel },
    { platform: "windows", label: "Windows · 64-bit", asset: release?.windows },
    { platform: "linux", label: "Linux · Debian or Ubuntu", asset: release?.linux },
  ] as const;
  const hasGuidedMacInstaller = [release?.mac, release?.macIntel].some((asset) => asset?.name.endsWith("-installer.dmg"));
  const hasDesktopAssets = desktopAssets.some(({ asset }) => asset !== undefined);
  return (
    <>
      <PageHead
        title="Record browser or desktop meetings."
        lede="Download the desktop app for macOS, Windows, or Linux. It records browser and desktop meetings on its own; the Chrome extension below is optional."
      />
      <section className="mk-section mk-section--flush" aria-labelledby="desktop-app-availability">
        <div className="mk-wrap">
          <h2 className="mk-h2" id="desktop-app-availability">
            {hasDesktopAssets ? "Download AI Notetaker" : "Desktop app preview"}
          </h2>
          {hasDesktopAssets ? (
            <>
              <p className="mk-lede">Choose the installer for your computer. The desktop app handles setup, browser and desktop capture, processing, and local notes.</p>
              <div className="mk-notice mk-mt-m" role="note">
                <strong>Preview release.</strong> These installers are unsigned, so your operating system may show a warning. Fresh-install and real-call checks are still incomplete across supported platforms. Read the <a href={UNSIGNED_DOC}>first-open guide</a> and <a href={ACCEPTANCE_DOC}>platform acceptance checklist</a>.
              </div>
              <div className="mk-downloads">
                {desktopAssets.map(({ platform: assetPlatform, label, asset }) => (
                  <article className="mk-download" key={assetPlatform}>
                    <h3 className="mk-h3"><Icon as={Laptop} size={22} />{label}</h3>
                    {asset ? (
                      <>
                        <AssetButton asset={asset} label="Download installer" accessibleLabel={`Download installer for ${label}`} primary={platform === assetPlatform} />
                        <details open={platform === (assetPlatform.startsWith("macos") ? "macos" : assetPlatform)}>
                          <summary>Install on {label}</summary>
                          {assetPlatform.startsWith("macos") ? (
                            asset.name.endsWith("-installer.dmg") ? (
                              <>
                                <ol>
                                  <li>Open the downloaded .dmg and double-click <strong>Install AI Notetaker.command</strong>.</li>
                                  <li>macOS blocks it the first time because this release is not notarized by Apple. The dialog says &quot;Not Opened&quot; with only Cancel and Move to Trash. Choose <strong>Cancel</strong>, not Move to Trash.</li>
                                  <li>Open <strong>System Settings → Privacy &amp; Security</strong>, scroll to <strong>Security</strong>, choose <strong>Open Anyway</strong> next to Install AI Notetaker.command, and enter your password.</li>
                                  <li>Double-click the installer again and choose <strong>Install</strong>. It copies the app to Applications and opens it. If macOS blocks the app itself, repeat step 3 for AI Notetaker.</li>
                                </ol>
                                <p>No Terminal commands are needed. More detail: <a href={UNSIGNED_DOC}>first-open guide</a>.</p>
                              </>
                            ) : (
                              <ol>
                                <li>Open the downloaded .dmg and drag <strong>AI Notetaker</strong> into Applications.</li>
                                <li>Open the app. If macOS says it cannot be opened, go to <strong>System Settings → Privacy &amp; Security</strong>, choose <strong>Open Anyway</strong> next to AI Notetaker, and enter your password. No Terminal commands are needed. More detail: <a href={UNSIGNED_DOC}>first-open guide</a>.</li>
                              </ol>
                            )
                          ) : assetPlatform === "windows" ? (
                            <ol>
                              <li>Run the downloaded installer. If Windows shows &quot;Windows protected your PC&quot;, choose <strong>More info</strong>, then <strong>Run anyway</strong>. It installs for your account only and needs no administrator password.</li>
                              <li>Open <strong>AI Notetaker</strong> from the Start menu. More detail: <a href={UNSIGNED_DOC}>first-open guide</a>.</li>
                            </ol>
                          ) : (
                            <ol>
                              <li>Open the downloaded .deb with your system&apos;s Software Install app and choose Install.</li>
                              <li>Open <strong>AI Notetaker</strong> from your applications menu.</li>
                            </ol>
                          )}
                        </details>
                      </>
                    ) : (
                      <p className="mk-small">Installer not published yet.</p>
                    )}
                  </article>
                ))}
              </div>
              <div className="mk-prose mk-mt-l">
                <h3 className="mk-h3">After download</h3>
                <ol>
                  <li>Install and open AI Notetaker. The app guides you through audio permissions and a microphone/system-audio check.</li>
                  <li>Choose transcription and summary providers, add and test your API keys, then start a recording in the app.</li>
                  <li>Find your transcript, summary, and action items in local Notes. No AI Notetaker account is needed.</li>
                </ol>
              </div>
            </>
          ) : release ? (
            <div className="mk-prose">
              <p>This release has no desktop installer attached. Check its release page for available assets.</p>
              <p><a className="mk-btn mk-btn--quiet" href={release.pageUrl}>View release details</a></p>
            </div>
          ) : (
            <div className="mk-prose">
              <p>Release links could not be loaded. Check the releases page for current installers.</p>
              <p><a className="mk-btn mk-btn--solid" href={SITE.releasesUrl}>View all releases</a></p>
            </div>
          )}
          <p className="mk-small mk-mt-m">Raw recordings are saved on this device before processing. To process them, audio is sent directly to your chosen transcription provider; the resulting transcript is sent to your chosen summary provider. Optional sync sends finished desktop notes to a web workspace and copies workspace notes into desktop. Web edits refresh workspace copies on the next sync. Desktop-origin notes are protected from automatic overwrites; deletions and settings do not sync back.</p>
        </div>
      </section>
      <section id="browser-extension" className="mk-section mk-section--flush" aria-labelledby="browser-extension-title">
        <div className="mk-wrap">
          <div className="mk-download">
            <h2 className="mk-h2" id="browser-extension-title"><Icon as={Puzzle} size={24} />Optional Chrome extension</h2>
            <p>Capture meeting audio playing in the current secure Chrome tab and your microphone as separate local tracks. This includes web versions of Google Meet, Zoom, Teams, Slack, Discord, and other sites; behavior can vary by site and browser. Export the archive, then import it in desktop to transcribe and create notes.</p>
            <div className="mk-cta-row">
              {store && <a className="mk-btn mk-btn--solid" href={store}>Add to Chrome</a>}
              <AssetButton asset={release?.extension} label={store ? "Download extension ZIP" : "Download Chrome extension"} />
            </div>
            {!store && !release?.extension && <p className="mk-small">The extension download could not be loaded. Check the <a href={SITE.releasesUrl}>releases page</a>.</p>}
            {!store && release?.extension && <p className="mk-small">Unzip the file, open <code>chrome://extensions</code>, turn on Developer mode, choose Load unpacked, and select the unzipped folder containing manifest.json.</p>}
            <p className="mk-small">Floating controls appear in Meet, Teams, Zoom web meetings, Discord channels, and Slack workspaces. If Chrome asks, click the extension toolbar icon or use the recording shortcut to enable tab audio. Other secure meeting tabs use the popup or shortcut.</p>
            <p className="mk-small">Extension recording settings stay in Chrome. Transcription providers, local notes, and optional web-app sync are managed in the desktop app.</p>
          </div>
        </div>
      </section>
      <details id="legacy-downloads" className="mk-wrap mk-legacy-downloads">
        <summary>Already use the previous extension and helper setup?</summary>
      <section className="mk-section mk-section--flush" aria-label="Downloads">
        <div className="mk-wrap">
          <div className="mk-downloads">
            <article className="mk-download" aria-labelledby="dl-helper">
              <h2 className="mk-h3" id="dl-helper"><Icon as={Laptop} size={22} />Desktop app</h2>
              <p>Records browser and desktop meetings in any app. Captures your microphone and system audio.</p>
              <p className="mk-notice">
                The installers are not code-signed yet, so macOS and Windows may warn you the first time. The{" "}
                <a href={UNSIGNED_DOC}>install guide</a> shows what to expect.
              </p>
              <div className="mk-cta-row">
                <AssetButton asset={release?.mac} label="macOS (Apple silicon)" primary={platform === "macos"} />
                <AssetButton asset={release?.macIntel} label="macOS (Intel)" primary={platform === "macos"} />
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
              <p className="mk-small">Choose the Mac installer that matches your processor.</p>
              <a href="#install-helper">Legacy setup for existing extension users →</a>
            </article>
          </div>

          <div className="mk-prose mk-mt-l mk-setup" id="install-helper">
            <h2>Keep using your existing extension (legacy)</h2>
            <p>This section explains the previous extension-to-helper connection for existing users. New browser-tab recordings can be exported from extension Settings and imported in the desktop app without Native Messaging.</p>
            <details open={platform === "macos"}>
              <summary>macOS · choose Apple silicon or Intel</summary>
              <div className="mk-cta-row">
                <AssetButton asset={release?.mac} label="Apple silicon (M1 or newer)" />
                <AssetButton asset={release?.macIntel} label="Intel" />
              </div>
              {hasGuidedMacInstaller ? (
                <>
                  <ol>
                    <li>Download the installer matching your Mac above and open the .dmg.</li>
                    <li>Double-click <strong>Install AI Notetaker.command</strong>. A Terminal window opens; choose <strong>Install</strong> in the confirmation dialog. It copies the app to your Applications folder, connects it to Chrome, and opens it.</li>
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
            <h2>Use API keys in the existing extension</h2>
            <p>In extension setup, choose <strong>Use my own API keys</strong>, add one transcription key and one summary key, then test them. This legacy path does not require an AI Notetaker account.</p>
            <h2>Record with the existing extension</h2>
            <p>Earlier extension releases could process Google Meet calls or relay desktop capture through the helper. New browser-tab recordings only save audio in Chrome; export and import them in desktop to create notes. Use the desktop app controls above for new recordings and current provider settings.</p>
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
      </details>
    </>
  );
}

/* ------------------------------------------------------------------ */

const COMPARE_ROWS: { label: string; bot: string; ours: string }[] = [
  { label: "How it records", bot: "A bot account joins the call as a participant.", ours: "Records on your own device, from your browser tab and microphone or your system audio." },
  { label: "What others see", bot: "An extra attendee, often with a notice.", ours: "Nothing added to the call. You still need to tell people and get consent." },
  { label: "Where the recording lives", bot: "On the vendor's servers.", ours: "On your device first, before any provider is called." },
  { label: "Audio channels", bot: "Usually one mixed track.", ours: "Your microphone and the meeting's audio are kept separate, so \"you\" is never guessed." },
  { label: "Desktop apps", bot: "Depends on the vendor's integrations.", ours: "Records system audio and microphone from one desktop app." },
  { label: "Who runs the AI", bot: "The vendor.", ours: "You do: your own provider keys, on your device." },
  { label: "Pricing", bot: "Commonly a per-seat subscription.", ours: "Free with your own keys. A flat monthly price only for cloud sync and team sync." },
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
            <Link className="mk-btn mk-btn--solid" href={startHref()}>Get the desktop app</Link>
            <Link className="mk-btn mk-btn--quiet" href="/how-it-works">See how it works</Link>
          </div>
        </div>
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ */

const SUBPROCESSORS: { name: string; role: string; data: string }[] = [
  { name: "Railway", role: "Hosting and database", data: "Account records and synced notes" },
  { name: "Stripe", role: "Payments and billing portal", data: "Your email and payment details, which Stripe collects directly" },
  { name: "Resend", role: "Sign-up and password-reset email", data: "Your email address" },
  { name: "Sentry", role: "Error diagnostics for the account and sync service", data: "Technical error details and workspace-safe identifiers, not designed to include audio or transcript text" },
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
              AI Notetaker has a free local mode that needs no account, and an account service we operate. This
              notice covers both. The local mode uses your own AI provider keys. With a subscription, cloud sync sends
              finished note text from the desktop app to your workspace and copies workspace notes into the desktop
              library. This notice also covers the website.
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
              <li>Your provider keys stay in the desktop app&apos;s operating-system credential store. Existing extension users keep their keys in protected browser storage. We never receive them.</li>
              <li>Audio and text go directly to the providers you configure, under their terms and retention rules.</li>
              <li>If you subscribe and turn on sync, finished desktop note text syncs to your workspace and workspace notes are copied into the desktop library. Web edits refresh workspace copies on sync; desktop-origin notes are protected from automatic overwrites. Deletions and settings do not sync back. Raw audio and provider keys remain on this device.</li>
              <li>We do not receive local-mode recordings, transcripts or notes, and local mode sends us no telemetry or error reports.</li>
              <li>The desktop app keeps itself up to date. It checks for a newer release on GitHub (about every six hours, and at startup). On macOS and Windows it installs update packages signed with the project&apos;s update key and restarts only when nothing is recording; on Linux it opens the release page for you to download the new .deb. GitHub, not us, receives your IP address and the app version. Turn automatic updates off in the tray menu and the app only checks when you ask.</li>
              <li>Google Drive export is optional. Google receives what you send it.</li>
            </ul>

            <h2>Accounts and sync: what we collect</h2>
            <ul>
              <li><strong>Account:</strong> your email address, a salted and hashed password, and your workspace and membership details. You can sign in from the website, the desktop app or the extension. The desktop app sends your password once, never stores it, and keeps only a revocable session token in your operating-system credential store; signing out deletes it.</li>
              <li><strong>Notes:</strong> if you subscribe and sync, the transcripts, summaries, decisions and action items from your meetings, stored in your workspace.</li>
              <li><strong>Billing:</strong> your plan and its status. Stripe holds your payment details, not us.</li>
              <li><strong>Sign-in and security records:</strong> when you sign in we record a description of your device, your IP address and timestamps. We use them to show your signed-in devices, let you revoke them, limit repeated failed sign-ins, and investigate abuse. A session or extension token ends when you sign out, revoke it, or it expires.</li>
              <li><strong>Audio:</strong> we never receive or store your recordings. They stay on your device, and there is no audio in the synced library.</li>
            </ul>
            <p>
              Every workspace is isolated from the others. Your AI provider keys stay on your device and are
              never sent to us. Server logs use workspace-safe identifiers and failure
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
              this service is suitable for it. The account and sync service is not offered as a HIPAA-compliant service.
            </p>

            <h2>Who processes data for accounts and sync</h2>
          </div>
          <div className="mk-table-wrap mk-table-wrap--narrow" role="region" aria-label="Service providers, scrolls sideways on small screens" tabIndex={0}>
            <table className="mk-table">
              <caption>Service providers used by the account and sync service</caption>
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

            <h2>Keeping, deleting and exporting your data</h2>
            <ul>
              <li>Delete any meeting or folder from the app. In the synced library it moves to Trash, where you can restore it for 30 days; after that, or when you delete it from Trash, its transcript and summary are removed.</li>
              <li>Workspace owners choose how long hosted notes are kept, and you can export your data from the account page.</li>
              <li>We keep account data while your account exists. After you delete an account or workspace, its notes and account records are removed, and copies in system backups are overwritten on the normal backup schedule. We keep records that the law or our tax and fraud-prevention duties require, such as billing records held by Stripe, for as long as they require.</li>
              <li>
                <strong>Clearing your browser history does not delete your notes.</strong> Synced notes live in your
                workspace on our servers, so they are unaffected by anything you do in your browser; if you clear cookies
                you only need to sign in again. The desktop app keeps new local recordings and notes in a private data
                folder, so clearing browser history, cookies or cache leaves them alone. They are removed if you delete
                that app data or reset or lose the device; nothing is stored on our servers to restore them. Existing
                extension users keep their local notes in the browser profile until they export them to the desktop app.
                Export local notes you need to preserve, or use a subscription to sync finished note text to the cloud.
              </li>
              <li>Deleting the legacy extension does not delete desktop app data, provider account data, exported files, or data held by services you connected. Delete those where they live.</li>
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
      <PageHead title="Terms of use" lede={`Effective ${EFFECTIVE}. These cover this website, the software, and the account and sync service.`} />
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

            <h2>Accounts</h2>
            <ul>
              <li>You must be at least 16 years old, and able to form a binding contract, to use an AI Notetaker account. If you use it for an organization, you confirm you may bind it to these terms.</li>
              <li>Give us a real email address and keep your password private. You are responsible for activity in your account and workspace.</li>
              <li>Workspace owners manage members and are responsible for what their members record and store.</li>
              <li>You keep ownership of your recordings and notes. You give us a limited license to store, process, transmit to the providers listed in the privacy notice, and display them, solely to provide the service to you. We do not use them to train AI models.</li>
              <li>You are responsible for your content, for having the right to record and process it, and for the consent of the people in it. You must not upload content you have no right to use.</li>
              <li>Do not use the service to break the law or anyone&apos;s rights, to record people unlawfully, to process regulated sensitive data described in the privacy notice, to attack, overload, scrape or reverse engineer the service, to get around plan limits, to resell access, or to try to access another workspace&apos;s data.</li>
              <li>If your use of the service, including a recording made without a required consent, results in a claim against us, you agree to cover our reasonable losses from that claim to the extent the law allows.</li>
            </ul>

            <h2>Plans and billing</h2>
            <ul>
              <li>The desktop app and a free account cost nothing. Pro (cloud sync) and Team (team sync) are monthly subscriptions billed in US dollars through Stripe, as shown on the pricing page.</li>
              <li>Without an active subscription, cloud sync is off. Your notes stay on your device and keep working, and nothing is deleted when a plan ends.</li>
              <li>Cancel from the billing page. The plan stays active until the end of the period you already paid for, and it does not renew.</li>
              <li>
                Fees for a billing period that has started are not refunded, except where the law requires it or we
                could not provide the service. If you were charged by mistake or twice, contact us within 14 days and
                we will review it and refund what was charged in error.
              </li>
              <li>If a payment fails, access continues for a short grace period while Stripe retries, and then sync stops.</li>
              <li>We may rate-limit requests to protect the service. We may change prices and plans for future billing periods, and will tell subscribers in advance; a change does not affect a period you have already paid for.</li>
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
              detect a changed or damaged file, but it does not establish who published it. On macOS and Windows the desktop app installs updates signed with the project&apos;s update key by default (the installers themselves are not operating-system code-signed); on Linux it opens the release page. You can turn automatic updates off in the tray menu and install releases yourself.
            </p>

            <h2>Liability</h2>
            <p>
              The account and sync service is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;. To the extent the law
              allows, we give no warranty that it will be uninterrupted, error-free or that its output will be accurate,
              and we disclaim implied warranties such as merchantability and fitness for a particular purpose. To the same
              extent, we are not liable for indirect, incidental, special or consequential losses, lost profits, lost
              data, or losses from a recording made without a required consent or from your reliance on AI output from your own providers, and
              our total liability for the account and sync service is limited to the amount you paid for it in the 12 months
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
