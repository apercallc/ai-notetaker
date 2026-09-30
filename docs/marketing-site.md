# Marketing site

The public site is part of the webapp and is served by the project-operated
managed deployment at `https://ai-notetaker.apercallc.com`. It replaces the old
GitHub Pages site (`site/` now only holds redirects).

## Pages

`/`, `/how-it-works`, `/pricing`, `/download`, `/compare`, `/privacy`, `/terms`,
plus `/robots.txt`, `/sitemap.xml` and `/llms.txt`. The list of public paths is
`MARKETING_PATHS` in `webapp/src/marketing/paths.ts`.

## The auth exception, and why it is narrow

The webapp otherwise requires a session on every route. The marketing pages are
the one deliberate exception, so they are fenced in four ways:

1. **Managed only.** `proxy.ts` lets these paths through only when
   `MANAGED_HOSTING=true`; every page also calls `requireMarketing()` and 404s
   otherwise. A self-hosted instance never publishes them.
2. **Exact paths.** The proxy compares the whole pathname to a fixed set, so
   `/pricing/anything`, `/privacy/` and `/pricing.json` stay behind login.
3. **Static copy only.** These pages read no meeting, workspace or account data.
   The only per-visitor input is "signed in?" and "is signup open?", used to
   choose a button.
4. **No spoofing.** The proxy strips any client-sent `x-marketing` header and
   sets it itself; the root layout uses it only to drop the app chrome.

`robots.txt` disallows `/api/`, every app route and `/share/` (expiring share
links are private capabilities). On a self-hosted instance robots disallows
everything and the sitemap is empty.

## Single source of truth

`webapp/src/marketing/content.ts` holds the facts (plan limits come from
`lib/plans.ts`, prices from Stripe with a fallback). The pages, the JSON-LD
(`jsonld.tsx`) and `/llms.txt` all read it, so people, search engines and AI
assistants are told the same thing. `marketing.test.ts` checks they agree.

When you change a price in Stripe, update `FALLBACK_PRICE_LABELS` and
`FALLBACK_PRICE_AMOUNTS` (and the pricing page metadata description).

## Discoverability (SEO, answer engines, generative engines)

- Unique title, description and canonical per page; Open Graph and Twitter
  cards with a 1200x630 PNG (`webapp/public/marketing/og.png`).
- JSON-LD: Organization, WebSite, WebPage, SoftwareApplication with three
  Offers, FAQPage, HowTo, BreadcrumbList.
- Answer-shaped copy: visible FAQ that matches the FAQPage markup, a plain
  comparison table, and a "when a bot is better" section for credibility.
- `/llms.txt` for assistants; `robots.txt` names the main search and AI
  crawlers explicitly.
- Pages are server-rendered and dynamic (required for the CSP nonce), with no
  client JavaScript beyond what Next.js needs.

## Operating notes

- Set `CHROME_WEB_STORE_URL` on the deployment once the listing exists; the
  download page then shows "Add to Chrome".
- The download page reads the latest GitHub release (cached ten minutes) and
  shows a "first release is being prepared" notice until one exists.
- Sitemap `lastModified` is a constant in `app/sitemap.ts`; bump it when page
  content changes meaningfully.
- The contact points are GitHub issues and the security policy. Add a monitored
  support address before advertising one.
