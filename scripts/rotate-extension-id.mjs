#!/usr/bin/env node
// Switches the project to the extension ID the Chrome Web Store assigned.
//
// Why this exists: the Chrome Web Store picks the ID of a new item. Our
// extension.manifest `key` pins a different, development ID, and that ID is
// hard-coded in the helper's Native Messaging manifests (macOS, Windows,
// Linux), the managed-API CORS allowlist, the release validator and the docs.
// If the two differ, the helper silently refuses the store build.
//
// The supported way to keep them equal is to copy the store's public key into
// the manifest (Developer Dashboard > your item > Package > View public key).
// Give that key to this script: it derives the ID itself (so a typo cannot
// produce a mismatched pair), rewrites every pinned ID, and replaces the key.
//
// Usage: node scripts/rotate-extension-id.mjs <public-key-base64> [--dry-run] [--root DIR]
import { createHash, createPublicKey } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ID_PATTERN = /^[a-p]{32}$/u;
// Historical plans and specs record what was true when they were written.
const SKIP_PREFIXES = ["docs/superpowers/", "node_modules/", ".git/"];
const TEXT_EXTENSIONS = /\.(md|json|ts|tsx|mjs|js|rs|toml|yml|yaml|sh|ps1|template|example|txt)$|(^|\/)(postinst|postrm)$/u;

/** Chrome derives an extension ID from the first 128 bits of SHA-256(DER public key), hex mapped 0-f to a-p. */
export function deriveExtensionId(publicKeyBase64) {
  const der = Buffer.from(publicKeyBase64.replace(/\s+/gu, ""), "base64");
  // Throws unless this is a real public key, so a garbled paste fails loudly.
  createPublicKey({ key: der, format: "der", type: "spki" });
  const hex = createHash("sha256").update(der).digest("hex").slice(0, 32);
  return [...hex].map((digit) => String.fromCharCode("a".charCodeAt(0) + Number.parseInt(digit, 16))).join("");
}

function trackedFiles(root) {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.split("\0").filter(Boolean);
}

export function readManifestKey(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "extension/manifest.json"), "utf8"));
  if (typeof manifest.key !== "string" || !manifest.key) throw new Error("extension/manifest.json has no key field");
  return manifest.key;
}

export function rotate(root, newKeyBase64, { dryRun = false } = {}) {
  const newKey = newKeyBase64.replace(/\s+/gu, "");
  const oldKey = readManifestKey(root);
  const oldId = deriveExtensionId(oldKey);
  const newId = deriveExtensionId(newKey);
  if (!ID_PATTERN.test(newId)) throw new Error(`derived ID is malformed: ${newId}`);
  if (newId === oldId) return { oldId, newId, changed: [], unchanged: true };

  const changed = [];
  for (const relative of trackedFiles(root)) {
    if (SKIP_PREFIXES.some((prefix) => relative.startsWith(prefix)) || !TEXT_EXTENSIONS.test(relative)) continue;
    const file = path.join(root, relative);
    let source;
    try {
      source = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    let next = source.split(oldId).join(newId);
    if (relative === "extension/manifest.json") next = next.split(oldKey).join(newKey);
    if (next !== source) {
      changed.push(relative);
      if (!dryRun) fs.writeFileSync(file, next);
    }
  }
  if (!changed.includes("extension/manifest.json")) throw new Error("the manifest key was not updated; aborting before anything is half-applied");
  return { oldId, newId, changed, unchanged: false };
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const rootIndex = args.indexOf("--root");
  const root = rootIndex >= 0 ? path.resolve(args.splice(rootIndex, 2)[1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const key = args.find((arg) => !arg.startsWith("--"));
  if (!key) {
    console.error("usage: rotate-extension-id.mjs <public-key-base64> [--dry-run] [--root DIR]");
    process.exit(2);
  }
  const result = rotate(root, key, { dryRun });
  if (result.unchanged) {
    console.log(`The key already derives ${result.newId}; nothing to do.`);
    return;
  }
  console.log(`${dryRun ? "Would change" : "Changed"} ${result.changed.length} files: ${result.oldId} -> ${result.newId}`);
  for (const file of result.changed) console.log(`  ${file}`);
  if (!dryRun) console.log("\nNext: run the webapp, helper and script tests, commit, and let the auto-release publish the new build.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
