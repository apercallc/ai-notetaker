import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { getAppUrl } from "@/lib/deploymentConfig";
import { managedHostingEnabled } from "@/lib/managedAuth";
import { SESSION_COOKIE } from "@/lib/sessionCookie";
import { getSessionUser } from "@/lib/sessions";
import { signupAvailability } from "@/lib/signupPolicy";
import { SITE } from "./content";
import type { ShellContext } from "./Shell";

/** Marketing pages exist only on the managed deployment; anywhere else they are a plain 404. */
export function requireMarketing(): void {
  if (!managedHostingEnabled()) notFound();
}

export function siteOrigin(): string {
  return getAppUrl();
}

/** Who is looking and whether signup is open. A database hiccup never breaks a public page. */
export async function marketingContext(): Promise<ShellContext> {
  let signedIn = false;
  try {
    const store = await cookies();
    signedIn = Boolean(await getSessionUser(store.get(SESSION_COOKIE)?.value));
  } catch (error) {
    console.error("marketing session lookup failed", error instanceof Error ? error.message : String(error));
  }
  return { signedIn, signupOpen: signupAvailability().allowed };
}

/** Canonical + Open Graph + Twitter metadata for one marketing page. */
export function pageMetadata(input: { path: string; title: string; description: string }): Metadata {
  const image = { url: "/marketing/og.png", width: 1200, height: 630, alt: `${SITE.name}: ${SITE.tagline}` };
  return {
    title: { absolute: input.title },
    description: input.description,
    alternates: { canonical: input.path },
    robots: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1 },
    openGraph: {
      type: "website",
      siteName: SITE.name,
      title: input.title,
      description: input.description,
      url: input.path,
      images: [image],
    },
    twitter: { card: "summary_large_image", title: input.title, description: input.description, images: [image.url] },
  };
}
