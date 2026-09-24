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

export function getInstallPageUrl(source: "onboarding" | "popup" | "meet-widget" = "onboarding"): string {
  const url = new URL(INSTALL_PAGE_BASE_URL);
  url.searchParams.set("platform", detectInstallPlatform());
  url.searchParams.set("source", source);
  return url.toString();
}
