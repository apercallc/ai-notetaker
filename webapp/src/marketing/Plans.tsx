import Link from "next/link";
import { Check } from "lucide-react";
import { getPlanCatalog } from "@/lib/billing";
import { FALLBACK_PRICE_LABELS } from "./content";
import { Icon } from "./Icon";

export interface YearlyDisplay {
  label: string;
  monthsFree: number | null;
}

export interface PlanDisplay {
  hosted_pro: string;
  hosted_team: string;
  /** Present only for plans that have a yearly Stripe price configured. */
  yearly?: { hosted_pro?: YearlyDisplay; hosted_team?: YearlyDisplay };
}

/**
 * Live prices from Stripe (cached ten minutes), falling back to the published
 * defaults so the page never shows a blank price when Stripe is unreachable.
 */
export async function planPrices(): Promise<PlanDisplay> {
  try {
    const catalog = await getPlanCatalog();
    const label = (id: "hosted_pro" | "hosted_team") => catalog.find((plan) => plan.id === id)?.priceLabel ?? FALLBACK_PRICE_LABELS[id];
    const yearlyOf = (id: "hosted_pro" | "hosted_team"): YearlyDisplay | undefined => {
      const yearly = catalog.find((plan) => plan.id === id)?.yearly;
      return yearly?.priceLabel ? { label: yearly.priceLabel, monthsFree: yearly.monthsFree } : undefined;
    };
    const yearly = { hosted_pro: yearlyOf("hosted_pro"), hosted_team: yearlyOf("hosted_team") };
    return { hosted_pro: label("hosted_pro"), hosted_team: label("hosted_team"), ...(yearly.hosted_pro || yearly.hosted_team ? { yearly } : {}) };
  } catch {
    return { ...FALLBACK_PRICE_LABELS };
  }
}

function splitPrice(label: string): { amount: string; period: string } {
  const [amount, ...rest] = label.split(" / ");
  return { amount: amount ?? label, period: rest.length ? `/ ${rest.join(" / ")}` : "" };
}

function YearlyNote({ yearly }: { yearly: YearlyDisplay | undefined }) {
  if (!yearly) return null;
  return (
    <p className="mk-plan-yearly">
      or {yearly.label.replace(" / ", " a ")}{yearly.monthsFree ? <strong> · {yearly.monthsFree} months free</strong> : null}
    </p>
  );
}

export function Plans({ prices, signupOpen }: { prices: PlanDisplay; signupOpen: boolean }) {
  const pro = splitPrice(prices.hosted_pro);
  const team = splitPrice(prices.hosted_team);
  const start = signupOpen ? "/login?tab=signup" : "/download";
  const startPlan = (_plan: "hosted_pro" | "hosted_team") => (signupOpen ? `/login?tab=signup&next=${encodeURIComponent("/billing")}` : "/download");
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
        <YearlyNote yearly={prices.yearly?.hosted_pro} />
        <p className="mk-plan-for">Cloud sync of your notes across all your devices.</p>
        <ul className="mk-checks">
          <li><Icon as={Check} /><span>Everything in Free</span></li>
          <li><Icon as={Check} /><span>Finished notes sync to every device you sign in on</span></li>
          <li><Icon as={Check} /><span>Searchable library of your notes on the web</span></li>
          <li><Icon as={Check} /><span>Folders, speaker names, Trash and data export</span></li>
          <li><Icon as={Check} /><span>Slack, Notion, webhooks and an MCP connection for AI assistants</span></li>
          <li><Icon as={Check} /><span>Recordings never leave your device</span></li>
        </ul>
        <Link className="mk-btn mk-btn--solid" href={startPlan("hosted_pro")}>{signupOpen ? "Start Pro" : "Get the desktop app"}</Link>
      </article>

      <article className="mk-plan" aria-labelledby="plan-team">
        <h3 className="mk-h3" id="plan-team">Team</h3>
        <p className="mk-plan-price">{team.amount}{team.period && <small> {team.period}</small>}</p>
        <YearlyNote yearly={prices.yearly?.hosted_team} />
        <p className="mk-plan-for">Team sync: one shared workspace for everyone.</p>
        <ul className="mk-checks">
          <li><Icon as={Check} /><span>Everything in Pro</span></li>
          <li><Icon as={Check} /><span>Invite teammates to one shared library</span></li>
          <li><Icon as={Check} /><span>Activity log for workspace owners</span></li>
          <li><Icon as={Check} /><span>Owners set how long notes are kept</span></li>
          <li><Icon as={Check} /><span>Workspaces are fully isolated from each other</span></li>
        </ul>
        <Link className="mk-btn mk-btn--quiet" href={startPlan("hosted_team")}>{signupOpen ? "Start Team" : "Get the desktop app"}</Link>
      </article>
    </div>
  );
}
