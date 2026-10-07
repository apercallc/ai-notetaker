import Link from "next/link";
import { Check } from "lucide-react";
import { getPlanCatalog } from "@/lib/billing";
import { FALLBACK_PRICE_LABELS } from "./content";
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
      <article className="mk-plan" aria-labelledby="plan-free">
        <h3 className="mk-h3" id="plan-free">Free</h3>
        <p className="mk-plan-price">$0<small> bring your own AI keys</small></p>
        <p className="mk-plan-for">The full desktop app. No account needed, and a free account if you want one.</p>
        <ul className="mk-checks">
          <li><Icon as={Check} /><span>Record browser and desktop meetings with no bot</span></li>
          <li><Icon as={Check} /><span>Notes made with your own AI providers, billed to you directly</span></li>
          <li><Icon as={Check} /><span>Keys and audio stay on your device</span></li>
          <li><Icon as={Check} /><span>Optional free account: sign in, manage your devices and your data</span></li>
          <li><Icon as={Check} /><span>Open source</span></li>
        </ul>
        <Link className="mk-btn mk-btn--quiet" href="/download">Get the desktop app</Link>
      </article>

      <article className="mk-plan mk-plan--lead" aria-labelledby="plan-pro">
        <span className="mk-plan-flag">Best for one person</span>
        <h3 className="mk-h3" id="plan-pro">Pro</h3>
        <p className="mk-plan-price">{pro.amount}{pro.period && <small> {pro.period}</small>}</p>
        <p className="mk-plan-for">Cloud sync of your notes across all your devices.</p>
        <ul className="mk-checks">
          <li><Icon as={Check} /><span>Everything in Free</span></li>
          <li><Icon as={Check} /><span>Finished notes sync to every device you sign in on</span></li>
          <li><Icon as={Check} /><span>Searchable library of your notes on the web</span></li>
          <li><Icon as={Check} /><span>Folders, speaker names, Trash and data export</span></li>
          <li><Icon as={Check} /><span>Slack, Notion, webhooks and an MCP connection for AI assistants</span></li>
          <li><Icon as={Check} /><span>Recordings never leave your device</span></li>
        </ul>
        <Link className="mk-btn mk-btn--solid" href={start}>{signupOpen ? "Create an account" : "Get the desktop app"}</Link>
      </article>

      <article className="mk-plan" aria-labelledby="plan-team">
        <h3 className="mk-h3" id="plan-team">Team</h3>
        <p className="mk-plan-price">{team.amount}{team.period && <small> {team.period}</small>}</p>
        <p className="mk-plan-for">Team sync: one shared workspace for everyone.</p>
        <ul className="mk-checks">
          <li><Icon as={Check} /><span>Everything in Pro</span></li>
          <li><Icon as={Check} /><span>Invite teammates to one shared library</span></li>
          <li><Icon as={Check} /><span>Activity log for workspace owners</span></li>
          <li><Icon as={Check} /><span>Owners set how long notes are kept</span></li>
          <li><Icon as={Check} /><span>Workspaces are fully isolated from each other</span></li>
        </ul>
        <Link className="mk-btn mk-btn--quiet" href={start}>{signupOpen ? "Start a team workspace" : "Get the desktop app"}</Link>
      </article>
    </div>
  );
}
