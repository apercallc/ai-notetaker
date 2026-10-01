"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { CheckSquare, CreditCard, FolderOpen, MessageSquare, Settings, Users, type LucideIcon } from "lucide-react";
import { logout } from "@/app/login/actions";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Shorter label for the narrow bottom tab bar. */
  short?: string;
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
    { href: "/meetings", label: "Library", icon: FolderOpen },
    { href: "/actions", label: "Actions", icon: CheckSquare },
    ...(managed ? [{ href: "/ask", label: "Ask", icon: MessageSquare }] : []),
    ...(role === "owner" ? [{ href: "/team", label: "Team", icon: Users }] : []),
    ...(managed ? [{ href: "/billing", label: "Plans & usage", short: "Plans", icon: CreditCard }] : []),
    { href: "/account", label: "Settings", icon: Settings },
  ];

  return (
    <header className="app-header">
      <div className="app-header-inner">
        <Link href="/meetings" className="brand">
          <Image className="brand-mark" src="/ai-notetaker-mark.svg" width={48} height={48} alt="" aria-hidden="true" />
          <span>AI Notetaker</span>
        </Link>
        <nav aria-label="Main" className="app-nav">
          <ul>
            {items.map((item) => {
              const current = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <li key={item.href}>
                  <Link href={item.href} aria-current={current ? "page" : undefined}>
                    <item.icon className="nav-icon" size={18} strokeWidth={1.75} aria-hidden="true" />
                    <span className="nav-label-full">{item.label}</span>
                    <span className="nav-label-short" aria-hidden="true">{item.short ?? item.label}</span>
                  </Link>
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
