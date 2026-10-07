// Builds the signed-update manifest (latest.json) the desktop app's in-place updater reads.
//
//   node scripts/generate-updater-manifest.mjs <asset-dir> <tag> <owner/repo>
//
// <asset-dir> holds the downloaded helper build artifacts (helper-macos-arm64/, helper-macos-x86_64/,
// helper-windows/, ...). Per-architecture macOS update archives share one file name, so they are
// copied into <asset-dir> under unique names. The release is blocked if any expected platform is
// missing or unsigned, because shipping a manifest that cannot update some users is worse than
// failing loudly here.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(entryPath) : [entryPath];
  });
}

const REQUIRED = ["darwin-aarch64", "darwin-x86_64", "windows-x86_64"];

export function generateUpdaterManifest({ assetDirectory, tag, repository, notes = "", now = new Date() }) {
  const version = tag.replace(/^v/u, "");
  const base = `https://github.com/${repository}/releases/download/${tag}`;
  const files = walk(assetDirectory);
  const platforms = {};
  const copies = [];

  const sigFor = (file) => {
    const sig = `${file}.sig`;
    if (!fs.existsSync(sig)) throw new Error(`${path.basename(file)} has no .sig signature file`);
    const text = fs.readFileSync(sig, "utf8").trim();
    if (!text) throw new Error(`${path.basename(sig)} is empty`);
    return text;
  };

  for (const file of files) {
    const relative = path.relative(assetDirectory, file);
    const top = relative.split(path.sep)[0].toLowerCase();
    const name = path.basename(file);
    if (name.endsWith(".app.tar.gz") && top.includes("macos")) {
      const arch = top.includes("arm64") || top.includes("aarch64") ? "aarch64" : top.includes("x86_64") || top.includes("x64") ? "x86_64" : null;
      if (!arch) throw new Error(`cannot tell the architecture of ${relative}`);
      const uniqueName = `AI.Notetaker_${version}_${arch === "aarch64" ? "arm64" : "x86_64"}.app.tar.gz`;
      platforms[`darwin-${arch}`] = { signature: sigFor(file), url: `${base}/${uniqueName}` };
      copies.push([file, path.join(assetDirectory, uniqueName)]);
    } else if (/-setup\.exe$/u.test(name) && top.includes("windows")) {
      platforms["windows-x86_64"] = { signature: sigFor(file), url: `${base}/${encodeURIComponent(name.replace(/ /gu, "."))}` };
    }
  }

  const missing = REQUIRED.filter((key) => !platforms[key]);
  if (missing.length) throw new Error(`updater artifacts missing for: ${missing.join(", ")}`);
  return {
    manifest: { version, notes: notes || `AI Notetaker ${version}. See the release notes on GitHub.`, pub_date: now.toISOString(), platforms },
    copies,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [assetDirectory, tag, repository] = process.argv.slice(2);
  if (!assetDirectory || !tag || !repository) {
    console.error("usage: generate-updater-manifest.mjs <asset-dir> <tag> <owner/repo>");
    process.exit(2);
  }
  const { manifest, copies } = generateUpdaterManifest({ assetDirectory, tag, repository });
  for (const [from, to] of copies) fs.copyFileSync(from, to);
  fs.writeFileSync(path.join(assetDirectory, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`latest.json: ${Object.keys(manifest.platforms).join(", ")}`);
}
