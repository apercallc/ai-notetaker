import Link from "next/link";
import {
  BotOff,
  Check,
  Cloud,
  Code,
  HardDrive,
  KeyRound,
  ListChecks,
  MessageCircleQuestion,
  MessagesSquare,
  Users,
  Briefcase,
} from "lucide-react";
import { ChannelDemo } from "./ChannelDemo";
import { FALLBACK_PRICE_LABELS, LIMITS, SITE } from "./content";
import { Faq } from "./Faq";
import { Icon } from "./Icon";
import { Plans, type PlanDisplay } from "./Plans";
import type { ShellContext } from "./Shell";

export function Home({ context, prices }: { context: ShellContext; prices: PlanDisplay }) {
  const start = context.signupOpen ? "/login?tab=signup" : "/download";
  const startLabel = context.signupOpen ? "Try Hosted AI free" : "Get the extension";
  const fromPrice = prices.hosted_pro ?? FALLBACK_PRICE_LABELS.hosted_pro;
  return (
    <>
      <section className="mk-hero" aria-labelledby="hero-title">
        <div className="mk-wrap mk-hero-grid">
          <div>
            <h1 className="mk-h1" id="hero-title">{SITE.tagline}</h1>
            <p className="mk-lede">
              AI Notetaker records Google Meet and desktop calls from your own device, then turns each one into a
              transcript, decisions and action items. Nobody joins your call.
            </p>
            <div className="mk-cta-row">
              <Link className="mk-btn mk-btn--solid" href={start}>{startLabel}</Link>
              <Link className="mk-btn mk-btn--quiet" href="/how-it-works#own-keys">Use my own keys</Link>
            </div>
            <ul className="mk-facts">
              <li><Icon as={BotOff} />No bot in the call</li>
              <li><Icon as={HardDrive} />Audio saved on your device first</li>
              <li><Icon as={Code} />Open source, MIT</li>
            </ul>
          </div>
          <ChannelDemo />
        </div>
      </section>

      <section className="mk-section mk-section--deep" id="setup" aria-labelledby="setup-title">
        <div className="mk-wrap">
          <div className="mk-section-head">
            <h2 className="mk-h2" id="setup-title">Two ways to run the AI. Audio is saved on your device first, either way.</h2>
            <p className="mk-lede">
              Pick whichever suits you. You can switch at any time in the extension&apos;s Settings, and nothing about
              how audio is captured changes.
            </p>
          </div>
          <div className="mk-choice">
            <article className="mk-panel mk-panel--lead" aria-labelledby="choice-hosted">
              <h3 className="mk-h3" id="choice-hosted">Hosted AI</h3>
              <p className="mk-panel-price"><strong>From {fromPrice}</strong>, after {LIMITS.trial} free meetings. Pro includes {LIMITS.pro.toLocaleString("en-US")} meetings or {LIMITS.proHours} meeting hours a month.</p>
              <p className="mk-panel-copy">
                We run the transcription and summaries. There is nothing to set up except an account, and your notes
                are in a searchable library on any device. Pro and Team also include Ask your notes.
              </p>
              <Link className="mk-btn mk-btn--light" href={start}>{startLabel}</Link>
            </article>
            <article className="mk-panel" aria-labelledby="choice-keys">
              <h3 className="mk-h3" id="choice-keys">Your own keys</h3>
              <p className="mk-panel-price"><strong>$0</strong> for the software</p>
              <p className="mk-panel-copy">
                You choose the AI providers and pay them directly. No AI Notetaker account is needed, and your keys
                stay in protected storage on your device.
              </p>
              <Link className="mk-btn mk-btn--ghost-on-deep" href="/how-it-works#own-keys">Set up with my keys</Link>
            </article>
          </div>
          <p className="mk-choice-foot">
            <Link href="/how-it-works">See the step-by-step walkthrough</Link> or{" "}
            <Link href="/compare">how this differs from bot notetakers</Link>.
          </p>
        </div>
      </section>

      <section className="mk-section" id="how" aria-labelledby="how-title">
        <div className="mk-wrap">
          <div className="mk-section-head">
            <h2 className="mk-h2" id="how-title">From the call to what happens next, in three steps.</h2>
          </div>
          <ol className="mk-steps">
            <li className="mk-step">
              <h3 className="mk-h3">Install</h3>
              <p>Add the Chrome extension and you can record Google Meet straight away.</p>
              <ul>
                <li>Zoom, Teams or Slack too? Add the desktop helper for macOS, Windows or Linux.</li>
              </ul>
            </li>
            <li className="mk-step">
              <h3 className="mk-h3">Record</h3>
              <p>
                Confirm the recording notice and start when you are ready. Your microphone and the meeting&apos;s audio
                are saved on your device as two channels.
              </p>
            </li>
            <li className="mk-step">
              <h3 className="mk-h3">Review</h3>
              <p>
                When the call ends, open the transcript, summary, decisions and action items. Search across every
                meeting when you need a detail back.
              </p>
            </li>
          </ol>
        </div>
      </section>

      <section className="mk-section" id="ask" aria-labelledby="ask-title">
        <div className="mk-wrap">
          <div className="mk-section-head">
            <h2 className="mk-h2" id="ask-title">Ask your notes instead of searching them.</h2>
            <p className="mk-lede">
              Ask your notes is included with Hosted Pro ({LIMITS.proQuestions.toLocaleString("en-US")} questions a month) and Hosted Team ({LIMITS.teamQuestions.toLocaleString("en-US")} a month). Type a question and get an answer drawn only from your own meetings,
              with a link to each note it used. If the answer is not in your notes, it says so.
            </p>
          </div>
          <ul className="mk-rows">
            <li className="mk-row">
              <h3 className="mk-h3"><Icon as={MessageCircleQuestion} size={22} />&ldquo;What did we decide about pricing?&rdquo;</h3>
              <p>An example question. The answer cites the meetings it came from, so you can check it in one tap.</p>
            </li>
            <li className="mk-row">
              <h3 className="mk-h3"><Icon as={ListChecks} size={22} />&ldquo;What action items are still open?&rdquo;</h3>
              <p>Works across every meeting in your workspace, and only your workspace. Meeting hours and questions are separate allowances, so asking never uses up recording time.</p>
            </li>
          </ul>
        </div>
      </section>

      <section className="mk-section mk-section--tint" id="privacy" aria-labelledby="privacy-title">
        <div className="mk-wrap">
          <div className="mk-section-head">
            <h2 className="mk-h2" id="privacy-title">Where your audio and notes go.</h2>
            <p className="mk-lede">It depends on the mode you pick. Here is exactly what happens.</p>
          </div>
          <dl className="mk-defs">
            <div>
              <dt><Icon as={HardDrive} size={22} />On your device first</dt>
              <dd>
                Raw microphone and meeting audio is written to your device before anything is sent to a provider, so a
                failed upload or crash never loses a recording.
              </dd>
            </div>
            <div>
              <dt><Icon as={Cloud} size={22} />With Hosted AI</dt>
              <dd>
                Audio is uploaded to private, temporary storage only to be transcribed, then deleted. We keep your text
                notes, not your recordings, and every workspace is isolated from the others.
              </dd>
            </div>
            <div>
              <dt><Icon as={KeyRound} size={22} />With your own keys</dt>
              <dd>
                Your keys stay in protected storage on your device and go only to the provider you chose. We never
                receive them, your recordings or your notes.
              </dd>
            </div>
          </dl>
          <p className="mk-prose mk-mt-l">
            You can delete any meeting, and workspace owners choose how long hosted notes are kept. If you choose to
            connect Google, AI Notetaker creates Google Docs in your Drive only for meetings you choose to export, and
            can see only the files it creates. It uses Google data for nothing else.{" "}
            <Link href="/privacy#google">How we handle Google data</Link> and the <Link href="/privacy">full privacy notice</Link>.
          </p>
        </div>
      </section>

      <section className="mk-section" aria-labelledby="use-title">
        <div className="mk-wrap">
          <div className="mk-section-head">
            <h2 className="mk-h2" id="use-title">Keep the details that move work forward.</h2>
            <p className="mk-lede">Example workflows, not customer stories.</p>
          </div>
          <ul className="mk-rows">
            <li className="mk-row">
              <h3 className="mk-h3"><Icon as={Users} size={22} />Product and project teams</h3>
              <p>Find the decision, who owns the next task, and when to check back, without replaying the recording.</p>
            </li>
            <li className="mk-row">
              <h3 className="mk-h3"><Icon as={MessagesSquare} size={22} />Interviews</h3>
              <p>Stay in the conversation instead of typing. Come back to the exact answer and your follow-up questions.</p>
            </li>
            <li className="mk-row">
              <h3 className="mk-h3"><Icon as={Briefcase} size={22} />Client work</h3>
              <p>Capture agreed scope and next actions after a working session, ready to send as a recap.</p>
            </li>
            <li className="mk-row">
              <h3 className="mk-h3"><Icon as={ListChecks} size={22} />Follow-ups</h3>
              <p>Every action item lands in one inbox across meetings, with owners and due dates you can tick off.</p>
            </li>
          </ul>
        </div>
      </section>

      <section className="mk-section mk-section--tint" id="pricing" aria-labelledby="pricing-title">
        <div className="mk-wrap">
          <div className="mk-section-head">
            <h2 className="mk-h2" id="pricing-title">Simple pricing. Cancel any time.</h2>
            <p className="mk-lede">Free with your own keys, or one flat monthly price when we run the AI.</p>
          </div>
          <Plans prices={prices} signupOpen={context.signupOpen} />
          <p className="mk-small mk-mt-m">
            Prices in US dollars, billed monthly. <Link href="/pricing">Pricing details</Link>
          </p>
        </div>
      </section>

      <section className="mk-section" id="faq" aria-labelledby="faq-title">
        <div className="mk-wrap">
          <div className="mk-section-head">
            <h2 className="mk-h2" id="faq-title">Questions people ask first.</h2>
          </div>
          <Faq />
        </div>
      </section>

      <section className="mk-section mk-section--deep mk-final" aria-labelledby="final-title">
        <div className="mk-wrap">
          <div className="mk-section-head mk-section-head--flush">
            <h2 className="mk-h2" id="final-title">Be in the conversation. Get the notes.</h2>
            <div className="mk-cta-row">
              <Link className="mk-btn mk-btn--light" href={start}>{startLabel}</Link>
              <Link className="mk-btn mk-btn--ghost-on-deep" href="/download">Download the extension</Link>
            </div>
            <p className="mk-small mk-mt-m mk-on-deep">
              Free with your own keys. Open source under the {SITE.license} license. Delete your data any time.
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
