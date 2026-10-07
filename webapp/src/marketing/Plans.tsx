import Link from "next/link";
import { Check } from "lucide-react";
import { getPlanCatalog } from "@/lib/billing";
import { FALLBACK_PRICE_LABELS, LIMITS } from "./content";
import { Icon } from "./Icon";

export interface PlanDisplay {
  hosted_pro: string;
  hosted_team: string;
}

/**
 * Live prices from Stripe (cached ten minutes), falling back to the published
 * defaults so the page never shows a blank price when Stripe is unreachable.
 */
export async function planPrices(): Promise<PlanDisplay> {
  try {
    const catalog = await getPlanCatalog();
    const label = (id: "hosted_pro" | "hosted_team") => catalog.find((plan) => plan.id === id)?.priceLabel ?? FALLBACK_PRICE_LABELS[id];
    return { hosted_pro: label("hosted_pro"), hosted_team: label("hosted_team") };
  } catch {
    return { ...FALLBACK_PRICE_LABELS };
  }
}

const n = (value: number): string => value.toLocaleString("en-US");

function splitPrice(label: string): { amount: string; period: string } {
  const [amount, ...rest] = label.split(" / ");
  return { amount: amount ?? label, period: rest.length ? `/ ${rest.join(" / ")}` : "" };
}

export function Plans({ prices, signupOpen }: { prices: PlanDisplay; signupOpen: boolean }) {
  const pro = splitPrice(prices.hosted_pro);
  const team = splitPrice(prices.hosted_team);
  const start = signupOpen ? "/login?tab=signup" : "/download";
  return (
    <div className="mk-plans">
      <article className="mk-plan" aria-labelledby="plan-keys">
        <h3 className="mk-h3" id="plan-keys">Your own keys</h3>
        <p className="mk-plan-price">Free<small> you pay your AI providers directly</small></p>
        <p className="mk-plan-for">For people who want to bring their own AI providers.</p>
        <ul className="mk-checks">
          <li><Icon as={Check} /><span>No AI Notetaker account needed</span></li>
          <li><Icon as={Check} /><span>You pay your AI providers directly</span></li>
          <li><Icon as={Check} /><span>Keys stay in protected storage on your device</span></li>
          <li><Icon as={Check} /><span>Open source, so you can read exactly what runs</span></li>
        </ul>
        <Link className="mk-btn mk-btn--quiet" href="/how-it-works#own-keys">Set up with my keys</Link>
      </article>

      <article className="mk-plan mk-plan--lead" aria-labelledby="plan-pro">
        <span className="mk-plan-flag">Best for one person</span>
        <h3 className="mk-h3" id="plan-pro">Hosted Pro</h3>
        <p className="mk-plan-price">{pro.amount}{pro.period && <small> {pro.period}</small>}</p>
        <p className="mk-plan-for">We run the AI. Up to {n(LIMITS.pro)} meetings or {n(LIMITS.proHours)} meeting hours a month, whichever comes first.</p>
        <ul className="mk-checks">
          <li><Icon as={Check} /><span>{LIMITS.trial} free meetings first, no card</span></li>
          <li><Icon as={Check} /><span>No provider accounts or keys to manage</span></li>
          <li><Icon as={Check} /><span>Searchable library of your notes</span></li>
          <li><Icon as={Check} /><span><strong>Ask your notes:</strong> {n(LIMITS.proQuestions)} questions a month, answered from your meetings</span></li>
          <li><Icon as={Check} /><span>Import audio and video files, up to {LIMITS.importHoursPro} hours each</span></li>
          <li><Icon as={Check} /><span>Notes templates, speaker names, folders and Trash</span></li>
          <li><Icon as={Check} /><span>Slack, Notion, webhooks and an MCP connection for AI assistants</span></li>
          <li><Icon as={Check} /><span>Audio deleted after processing</span></li>
        </ul>
        <Link className="mk-btn mk-btn--solid" href={start}>{signupOpen ? "Try Hosted AI free" : "Get the desktop app"}</Link>
      </article>

      <article className="mk-plan" aria-labelledby="plan-team">
        <h3 className="mk-h3" id="plan-team">Hosted Team</h3>
        <p className="mk-plan-price">{team.amount}{team.period && <small> {team.period}</small>}</p>
        <p className="mk-plan-for">One shared workspace. Up to {n(LIMITS.team)} meetings or {n(LIMITS.teamHours)} meeting hours a month, whichever comes first.</p>
        <ul className="mk-checks">
          <li><Icon as={Check} /><span>Everything in Pro, with {n(LIMITS.teamQuestions)} Ask-your-notes questions a month</span></li>
          <li><Icon as={Check} /><span>Invite teammates to one library</span></li>
          <li><Icon as={Check} /><span>Imports up to {LIMITS.importHoursTeam} hours each</span></li>
          <li><Icon as={Check} /><span>Activity log for workspace owners</span></li>
          <li><Icon as={Check} /><span>Owners set how long notes are kept</span></li>
          <li><Icon as={Check} /><span>Workspaces are fully isolated from each other</span></li>
        </ul>
        <Link className="mk-btn mk-btn--quiet" href={start}>{signupOpen ? "Start a team workspace" : "Get the desktop app"}</Link>
      </article>
    </div>
  );
}
