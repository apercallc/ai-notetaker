/**
 * Public installation entry point. The page performs OS detection again and
 * offers a manual override; the extension only supplies a useful hint.
 */
export type InstallPlatform = "macos" | "windows" | "linux" | "unknown";

const INSTALL_PAGE_BASE_URL = "https://apercallc.github.io/ai-notetaker/";

export function detectInstallPlatform(): InstallPlatform {
  const browser = navigator as Navigator & { userAgentData?: { platform?: string } };
  const value = `${browser.userAgentData?.platform ?? ""} ${navigator.platform ?? ""} ${navigator.userAgent}`.toLowerCase();
  if (value.includes("mac")) return "macos";
  if (value.includes("win")) return "windows";
  if (value.includes("linux")) return "linux";
  return "unknown";
}

export function getInstallPageUrl(source: "onboarding" | "popup" | "meet-widget" | "desktop" = "onboarding"): string {
  const url = new URL(INSTALL_PAGE_BASE_URL);
  url.searchParams.set("platform", detectInstallPlatform());
  url.searchParams.set("source", source);
  // The public landing page is Meet-first. Only an explicit desktop-install
  // action should open its helper section as the primary destination.
  if (source === "desktop") url.searchParams.set("mode", "desktop");
  return url.toString();
}

/**
 * Builds an internal extension setup URL. Keep the default Meet mode explicit:
 * Chrome can restore an old onboarding tab, and omitting the mode would make
 * a future entry point depend on stale page state again.
 */
export function getExtensionOnboardingUrl(extensionBaseUrl: string, mode: "meet" | "desktop" = "meet"): string {
  const url = new URL("onboarding/onboarding.html", extensionBaseUrl);
  url.searchParams.set("mode", mode);
  if (mode === "desktop") url.searchParams.set("source", "desktop");
  return url.toString();
}
