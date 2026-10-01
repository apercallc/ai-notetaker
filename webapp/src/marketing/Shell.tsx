import Image from "next/image";
import Link from "next/link";
import "./marketing.css";
import { display } from "./font";
import { NOT_LEGAL_ADVICE, SITE } from "./content";
import type { MarketingPath } from "./paths";

export interface ShellContext {
  /** Whether new hosted accounts can be created right now. */
  signupOpen: boolean;
  /** A signed-in visitor gets a shortcut back to their notes instead of sign-in. */
  signedIn: boolean;
}

const NAV: { href: MarketingPath; label: string }[] = [
  { href: "/how-it-works", label: "How it works" },
  { href: "/pricing", label: "Pricing" },
  { href: "/compare", label: "Compare" },
  { href: "/download", label: "Download" },
];

export function MarketingShell({
  children,
  current,
  context,
}: {
  children: React.ReactNode;
  current: MarketingPath;
  context: ShellContext;
}) {
  return (
    <div className={`mk ${display.variable}`}>
      <a className="mk-skip" href="#content">Skip to content</a>
      <header className="mk-header">
        <div className="mk-wrap mk-header-inner">
          <Link className="mk-brand" href="/">
            <Image src="/ai-notetaker-mark.svg" alt="" width={30} height={30} priority />
            {SITE.name}
          </Link>
          <nav className="mk-nav" aria-label="Main">
            {NAV.map((item) => (
              <Link key={item.href} href={item.href} aria-current={item.href === current ? "page" : undefined}>
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="mk-header-actions">
            {context.signedIn ? (
              <Link className="mk-btn mk-btn--solid" href="/meetings">Open your notes</Link>
            ) : (
              <>
                <Link className="mk-btn mk-btn--quiet" href="/login">Sign in</Link>
                {context.signupOpen && <Link className="mk-btn mk-btn--solid" href="/login?tab=signup" aria-label="Try Hosted AI free"><span className="mk-label-full">Try Hosted AI free</span><span className="mk-label-short">Try free</span></Link>}
              </>
            )}
          </div>
        </div>
      </header>
      <main id="content" tabIndex={-1}>{children}</main>
      <footer className="mk-footer">
        <div className="mk-wrap">
          <div className="mk-footer-grid">
            <div>
              <Link className="mk-brand" href="/">
                <Image src="/ai-notetaker-mark.svg" alt="" width={30} height={30} />
                {SITE.name}
              </Link>
              <p className="mk-small mk-footer-blurb">
                {SITE.tagline} Free and open source with your own AI keys, or hosted for a flat monthly price.
              </p>
            </div>
            <div>
              <h2>Product</h2>
              <ul>
                <li><Link href="/how-it-works">How it works</Link></li>
                <li><Link href="/pricing">Pricing</Link></li>
                <li><Link href="/compare">Compare</Link></li>
                <li><Link href="/download">Download</Link></li>
              </ul>
            </div>
            <div>
              <h2>Trust</h2>
              <ul>
                <li><Link href="/privacy">Privacy</Link></li>
                <li><Link href="/terms">Terms</Link></li>
                <li><a href={SITE.securityUrl}>Security policy</a></li>
                <li><a href={SITE.licenseUrl}>{SITE.license} license</a></li>
              </ul>
            </div>
            <div>
              <h2>Project</h2>
              <ul>
                <li><a href={SITE.repoUrl}>Source code</a></li>
                <li><a href={SITE.releasesUrl}>Releases</a></li>
                <li><a href={SITE.supportUrl}>Get help</a></li>
                <li><a href="/llms.txt">For AI assistants</a></li>
              </ul>
            </div>
          </div>
          <p className="mk-footer-note">{NOT_LEGAL_ADVICE}</p>
        </div>
      </footer>
    </div>
  );
}
