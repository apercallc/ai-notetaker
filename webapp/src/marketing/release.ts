import { SITE } from "./content";

export interface ReleaseAsset {
  name: string;
  url: string;
  bytes: number;
}

export interface DownloadLinks {
  tag: string;
  pageUrl: string;
  extension?: ReleaseAsset;
  mac?: ReleaseAsset;
  macIntel?: ReleaseAsset;
  windows?: ReleaseAsset;
  linux?: ReleaseAsset;
}

interface GithubAsset {
  name?: unknown;
  browser_download_url?: unknown;
  size?: unknown;
}

const toAsset = (asset: GithubAsset): ReleaseAsset | null =>
  typeof asset.name === "string" && typeof asset.browser_download_url === "string"
    ? { name: asset.name, url: asset.browser_download_url, bytes: typeof asset.size === "number" ? asset.size : 0 }
    : null;

/** Sorts a release's native artifacts into platform download links. */
export function pickAssets(assets: GithubAsset[]): Omit<DownloadLinks, "tag" | "pageUrl"> {
  const files = assets.map(toAsset).filter((asset): asset is ReleaseAsset => asset !== null);
  const find = (test: (name: string) => boolean) => files.find((file) => test(file.name.toLowerCase()));
  const macArm = find((name) => name.endsWith(".dmg") && (name.includes("arm64") || name.includes("aarch64")));
  const macIntel = find((name) => name.endsWith(".dmg") && (name.includes("x86_64") || name.includes("x64")));
  return {
    extension: find((name) => name.startsWith("ai-notetaker-extension") && name.endsWith(".zip")),
    mac: macArm ?? find((name) => name.endsWith(".dmg") && !name.includes("x86_64") && !name.includes("x64")),
    macIntel,
    windows: find((name) => name.endsWith(".exe") || name.endsWith(".msi")),
    linux: find((name) => name.endsWith(".deb")),
  };
}

/**
 * The newest published release, or null before the first release exists or when
 * GitHub is unreachable. The download page then links to the releases page
 * instead of guessing file names. Cached for ten minutes.
 */
export async function latestRelease(): Promise<DownloadLinks | null> {
  try {
    const response = await fetch("https://api.github.com/repos/apercallc/ai-notetaker/releases/latest", {
      headers: { accept: "application/vnd.github+json", "user-agent": "ai-notetaker-site" },
      signal: AbortSignal.timeout(5_000),
      next: { revalidate: 600 },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { tag_name?: unknown; html_url?: unknown; assets?: unknown };
    if (typeof body.tag_name !== "string") return null;
    return {
      tag: body.tag_name,
      pageUrl: typeof body.html_url === "string" ? body.html_url : SITE.releasesUrl,
      ...pickAssets(Array.isArray(body.assets) ? (body.assets as GithubAsset[]) : []),
    };
  } catch {
    return null;
  }
}

/** The Chrome Web Store listing, once it exists. Set CHROME_WEB_STORE_URL on the deployment. */
export function chromeWebStoreUrl(env: Record<string, string | undefined> = process.env): string | null {
  const value = env.CHROME_WEB_STORE_URL?.trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    const ok = parsed.protocol === "https:" && ["chromewebstore.google.com", "chrome.google.com"].includes(parsed.hostname);
    return ok ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function formatBytes(bytes: number): string {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(mb >= 100 ? 0 : 1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
