import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const NATIVE_EXTENSIONS = new Map([
  [".dmg", "dmg"],
  [".pkg", "pkg"],
  [".msi", "msi"],
  [".exe", "nsis"],
  [".deb", "deb"],
  [".appimage", "appimage"],
]);

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(entryPath) : [entryPath];
  });
}

function architectureFor(fileName, platform) {
  const name = fileName.toLowerCase();
  if (name.includes("arm64") || name.includes("aarch64")) return "arm64";
  if (name.includes("x86_64") || name.includes("x64") || name.includes("amd64")) return "x86_64";
  return platform === "macos" ? "universal" : "x86_64";
}

function platformFor(relativePath) {
  const firstDirectory = relativePath.split(path.sep)[0];
  if (firstDirectory.includes("macos")) return "macos";
  if (firstDirectory.includes("windows")) return "windows";
  if (firstDirectory.includes("ubuntu") || firstDirectory.includes("linux")) return "linux";
  return null;
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function generateReleaseManifest(baseManifest, {
  assetDirectory,
  repository,
  tag,
  chromeWebStoreUrl = null,
  signingConfirmed = false,
}) {
  const versionTag = tag.replace(/^v/u, "");
  if (versionTag !== baseManifest.version) {
    throw new Error(`release tag ${tag} does not match manifest version ${baseManifest.version}`);
  }

  const releaseBaseUrl = `https://github.com/${repository}/releases/download/${tag}`;
  const files = walk(assetDirectory);
  const artifacts = files.flatMap((filePath) => {
    const relativePath = path.relative(assetDirectory, filePath);
    const extension = path.extname(filePath).toLowerCase();
    const format = NATIVE_EXTENSIONS.get(extension);
    const platform = platformFor(relativePath);
    if (!format || !platform) return [];
    const fileName = path.basename(filePath);
    return [{
      platform,
      architecture: architectureFor(fileName, platform),
      format,
      url: `${releaseBaseUrl}/${encodeURIComponent(fileName)}`,
      sha256: sha256(filePath),
      // The build proves integrity here. Signing/notarization is recorded by
      // the release owner only after the native platform checks are complete.
      signatureStatus: "checksummed",
    }];
  });

  const extensionFile = files.find((filePath) => path.basename(filePath) === `ai-notetaker-extension-${tag}.zip`);
  const manifest = structuredClone(baseManifest);
  manifest.status = chromeWebStoreUrl && signingConfirmed ? "published" : "unpublished";
  manifest.extension.chromeWebStoreUrl = chromeWebStoreUrl;
  manifest.extension.fallbackZipUrl = extensionFile
    ? `${releaseBaseUrl}/${encodeURIComponent(path.basename(extensionFile))}`
    : null;
  manifest.artifacts = artifacts;
  return manifest;
}

if (process.argv[1] && process.argv[1].endsWith("generate-release-manifest.mjs")) {
  const [, , baseManifestPath = "release/manifest.json", assetDirectory = "release-assets", outputPath = "release-manifest.json"] = process.argv;
  const repository = process.env.GITHUB_REPOSITORY ?? "apercallc/ai-notetaker";
  const tag = process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME;
  if (!tag) throw new Error("RELEASE_TAG or GITHUB_REF_NAME is required");
  const manifest = generateReleaseManifest(JSON.parse(fs.readFileSync(baseManifestPath, "utf8")), {
    assetDirectory,
    repository,
    tag,
    chromeWebStoreUrl: process.env.CHROME_WEB_STORE_URL || null,
    signingConfirmed: process.env.RELEASE_SIGNING_CONFIRMED === "true",
  });
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Generated ${outputPath} with ${manifest.artifacts.length} native artifacts (${manifest.status})`);
}
