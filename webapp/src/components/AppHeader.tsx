"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { logout } from "@/app/login/actions";

interface NavItem {
  href: string;
  label: string;
}

/**
 * The one persistent header for every signed-in page. It lives in the root
 * layout, so keyboard focus order, the skip link and the current-page
 * indicator behave the same everywhere. Hidden on public share pages, which
 * a recipient sees as a standalone document.
 */
export function AppHeader({ role, managed }: { role: "owner" | "member"; managed: boolean }) {
  const pathname = usePathname() ?? "";
  if (pathname.startsWith("/share/")) return null;

  const items: NavItem[] = [
    { href: "/meetings", label: "Meetings" },
    { href: "/actions", label: "Actions" },
    ...(role === "owner" ? [{ href: "/team", label: "Team" }] : []),
    ...(managed ? [{ href: "/billing", label: "Plans & usage" }] : []),
    { href: "/account", label: "Account" },
  ];

  return (
    <header className="app-header">
      <div className="app-header-inner">
        <Link href="/meetings" className="brand">AI Notetaker</Link>
        <nav aria-label="Main" className="app-nav">
          <ul>
            {items.map((item) => {
              const current = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <li key={item.href}>
                  <Link href={item.href} aria-current={current ? "page" : undefined}>{item.label}</Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <form action={logout} className="app-signout">
          <button type="submit" className="text-link-muted">Sign out</button>
        </form>
      </div>
    </header>
  );
}
