import Link from "next/link";
import {
  BotOff,
  Check,
  FileAudio,
  FolderOpen,
  Languages,
  LayoutTemplate,
  Plug,
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
import { LIMITS, SITE } from "./content";
import { Faq } from "./Faq";
import { Icon } from "./Icon";
import { Plans, type PlanDisplay } from "./Plans";
import type { ShellContext } from "./Shell";

export function Home({ context, prices }: { context: ShellContext; prices: PlanDisplay }) {
  const start = "/download";
  const startLabel = "Get the desktop app";
  return (
    <>
      <section className="mk-hero" aria-labelledby="hero-title">
        <div className="mk-wrap mk-hero-grid">
          <div>
            <h1 className="mk-h1" id="hero-title">{SITE.tagline}</h1>
            <p className="mk-lede">
              AI Notetaker is moving to one desktop app for setup, recording and local notes. Use your own AI keys;
              no browser extension or AI Notetaker login is required. Nobody joins your call.
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
            <h2 className="mk-h2" id="setup-title">Your own AI keys. Your recordings stay local.</h2>
            <p className="mk-lede">
              Add transcription and summary provider keys in the desktop app. Connect a web workspace only if you
              want finished notes available on more than one device.
            </p>
          </div>
          <div className="mk-choice">
            <article className="mk-panel mk-panel--lead" aria-labelledby="choice-hosted">
              <h3 className="mk-h3" id="choice-hosted">Desktop app</h3>
              <p className="mk-panel-price"><strong>Free with your API keys</strong></p>
              <p className="mk-panel-copy">
                Choose transcription and summary providers, test your keys, and record from one app. Keys stay in the
                operating-system credential store; audio is saved locally before provider calls.
              </p>
              <Link className="mk-btn mk-btn--light" href={start}>{startLabel}</Link>
            </article>
            <article className="mk-panel" aria-labelledby="choice-keys">
              <h3 className="mk-h3" id="choice-keys">Optional web-app sync</h3>
              <p className="mk-panel-price"><strong>Connect one workspace</strong></p>
              <p className="mk-panel-copy">
                Create a revocable desktop sync token in the web app. Only finished transcripts, summaries, and
                action items sync. Raw audio and provider keys stay on this device.
              </p>
              <Link className="mk-btn mk-btn--ghost-on-deep" href="/how-it-works#own-keys">How setup works</Link>
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
              <h3 className="mk-h3">Install one app</h3>
              <p>Download AI Notetaker and use one app for setup, recording, and local notes. The downloads page shows which installers are currently available.</p>
            </li>
            <li className="mk-step">
              <h3 className="mk-h3">Record</h3>
              <p>
                Add and test your transcription and summary API keys, then grant microphone and system-audio access.
              </p>
            </li>
            <li className="mk-step">
              <h3 className="mk-h3">Review</h3>
              <p>
                Start and stop in the desktop app. Your transcript, summary and action items are saved in local history.
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

      <section className="mk-section" id="more" aria-labelledby="more-title">
        <div className="mk-wrap">
          <div className="mk-section-head">
            <h2 className="mk-h2" id="more-title">More than live calls.</h2>
            <p className="mk-lede">
              These come with Hosted AI. Your own-keys setup stays free and keeps live capture, transcripts and
              summaries on your device.
            </p>
          </div>
          <ul className="mk-rows">
            <li className="mk-row">
              <h3 className="mk-h3"><Icon as={FileAudio} size={22} />Import a recording</h3>
              <p>Upload an audio or video file you already have and get the same transcript, summary and action items. The file is deleted once it is processed.</p>
            </li>
            <li className="mk-row">
              <h3 className="mk-h3"><Icon as={LayoutTemplate} size={22} />Templates and speaker names</h3>
              <p>Choose Standup, Sales call, 1:1, Interview, Lecture or General notes, and rename a speaker once to fix it everywhere.</p>
            </li>
            <li className="mk-row">
              <h3 className="mk-h3"><Icon as={FolderOpen} size={22} />A library with folders and Trash</h3>
              <p>Nested folders, text notes you can edit, and 30 days to restore anything you delete.</p>
            </li>
            <li className="mk-row">
              <h3 className="mk-h3"><Icon as={Plug} size={22} />Slack, Notion, Zapier and AI assistants</h3>
              <p>Send finished notes to a signed webhook, Slack or Notion, or let an MCP-compatible assistant read your own notes with a token you can revoke.</p>
            </li>
            <li className="mk-row">
              <h3 className="mk-h3"><Icon as={Languages} size={22} />{LIMITS.languages} languages</h3>
              <p>Set or detect the spoken language, add custom vocabulary, and write the notes in another language.</p>
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
                receive your keys or recordings. Finished note text stays local unless you enable workspace sync.
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
              <Link className="mk-btn mk-btn--ghost-on-deep" href="/download#legacy-downloads">Existing extension downloads</Link>
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
