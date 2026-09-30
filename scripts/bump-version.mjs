#!/usr/bin/env node
// Bumps the release version in every file that carries it, in lockstep.
// The extension, webapp, helper and release manifest must always agree (they
// share a Native Messaging version handshake and release-build.yml verifies it).
//
// Usage: node scripts/bump-version.mjs <patch|minor|major|X.Y.Z|auto> [--root DIR]
//   auto: infer the bump from conventional commits since the latest v* tag and
//         print "none" (changing nothing) when only docs/chore/ci/test commits landed.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/u;

export function nextVersion(current, bump) {
  if (SEMVER.test(bump)) return bump;
  const match = SEMVER.exec(current);
  if (!match) throw new Error(`current version is not semver: ${current}`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  if (bump === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`unknown bump: ${bump}`);
}

// Pre-1.0 convention: a breaking change bumps minor, a feature bumps minor, anything
// else user-visible bumps patch. Housekeeping-only history releases nothing.
const HOUSEKEEPING = /^(docs|chore|ci|test|style|build)(\(.+\))?!?:/u;
const BREAKING = /^\w+(\(.+\))?!:|BREAKING CHANGE/mu;

export function bumpFromCommits(messages, current) {
  const subjects = messages.map((message) => message.split("\n")[0]);
  const releasable = subjects.filter((subject) => subject && !HOUSEKEEPING.test(subject));
  if (releasable.length === 0) return "none";
  const [major] = current.split(".").map(Number);
  if (messages.some((message) => BREAKING.test(message))) return major >= 1 ? "major" : "minor";
  return releasable.some((subject) => /^feat(\(.+\))?:/u.test(subject)) ? "minor" : "patch";
}

// Replace only the first `count` occurrences of the version field so unrelated
// packages that happen to share a version number are never touched.
function replaceFirstVersions(source, oldVersion, newVersion, count) {
  let remaining = count;
  const pattern = new RegExp(`("version"\\s*:\\s*")${oldVersion.replaceAll(".", "\\.")}(")`, "gu");
  return source.replace(pattern, (whole, open, close) => {
    if (remaining <= 0) return whole;
    remaining -= 1;
    return `${open}${newVersion}${close}`;
  });
}

const JSON_TARGETS = [
  // [file, number of leading "version" fields to rewrite]
  ["extension/manifest.json", 1],
  ["extension/package.json", 1],
  ["extension/package-lock.json", 2],
  ["webapp/package.json", 1],
  ["webapp/package-lock.json", 2],
  ["helper/crates/app/tauri.conf.json", 1],
  ["release/manifest.json", 2], // top-level version and extension.version
];
const WORKSPACE_CRATES = ["notetaker-app", "notetaker-audio", "notetaker-core"];

export function currentVersion(root) {
  return JSON.parse(fs.readFileSync(path.join(root, "release/manifest.json"), "utf8")).version;
}

export function bumpFiles(root, newVersion) {
  const oldVersion = currentVersion(root);
  if (!SEMVER.test(newVersion)) throw new Error(`invalid version: ${newVersion}`);
  const write = (relative, transform) => {
    const file = path.join(root, relative);
    const before = fs.readFileSync(file, "utf8");
    const after = transform(before);
    if (after === before) throw new Error(`${relative}: no version field matched ${oldVersion}`);
    fs.writeFileSync(file, after);
  };
  for (const [relative, count] of JSON_TARGETS) {
    write(relative, (source) => replaceFirstVersions(source, oldVersion, newVersion, count));
  }
  write("helper/Cargo.toml", (source) =>
    source.replace(new RegExp(`^(version\\s*=\\s*")${oldVersion.replaceAll(".", "\\.")}(")`, "mu"), `$1${newVersion}$2`));
  write("helper/Cargo.lock", (source) => {
    let result = source;
    for (const name of WORKSPACE_CRATES) {
      result = result.replace(
        new RegExp(`(name = "${name}"\\nversion = ")${oldVersion.replaceAll(".", "\\.")}(")`, "u"),
        `$1${newVersion}$2`,
      );
    }
    return result;
  });
  return { oldVersion, newVersion };
}

function latestTag(root) {
  try {
    return execFileSync("git", ["describe", "--tags", "--abbrev=0", "--match", "v*"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function commitMessagesSince(root, tag) {
  const range = tag ? `${tag}..HEAD` : "HEAD";
  const raw = execFileSync("git", ["log", range, "--format=%B%x1e"], { cwd: root, encoding: "utf8" });
  return raw.split("\x1e").map((message) => message.trim()).filter(Boolean);
}

function main() {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf("--root");
  const root = rootIndex >= 0 ? path.resolve(args.splice(rootIndex, 2)[1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const request = args[0];
  if (!request) {
    console.error("usage: bump-version.mjs <patch|minor|major|X.Y.Z|auto> [--root DIR]");
    process.exit(2);
  }
  const current = currentVersion(root);
  const bump = request === "auto" ? bumpFromCommits(commitMessagesSince(root, latestTag(root)), current) : request;
  if (bump === "none") {
    console.log("none");
    return;
  }
  const { newVersion } = bumpFiles(root, nextVersion(current, bump));
  console.log(newVersion);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
