import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bumpFiles, bumpFromCommits, currentVersion, nextVersion } from "./bump-version.mjs";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const FILES = [
  "extension/manifest.json",
  "extension/package.json",
  "extension/package-lock.json",
  "webapp/package.json",
  "webapp/package-lock.json",
  "helper/crates/app/tauri.conf.json",
  "release/manifest.json",
  "helper/Cargo.toml",
  "helper/Cargo.lock",
];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bump-version-"));
  for (const relative of FILES) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, relative), path.join(root, relative));
  }
  return root;
}

test("nextVersion handles bump kinds and explicit versions", () => {
  assert.equal(nextVersion("0.1.0", "patch"), "0.1.1");
  assert.equal(nextVersion("0.1.9", "minor"), "0.2.0");
  assert.equal(nextVersion("0.9.9", "major"), "1.0.0");
  assert.equal(nextVersion("0.1.0", "2.3.4"), "2.3.4");
  assert.throws(() => nextVersion("0.1.0", "sideways"));
});

test("bumpFromCommits skips housekeeping and ranks feat above fixes", () => {
  assert.equal(bumpFromCommits(["docs: x", "chore(deps): y", "ci: z"], "0.1.0"), "none");
  assert.equal(bumpFromCommits(["fix: a", "docs: b"], "0.1.0"), "patch");
  assert.equal(bumpFromCommits(["fix: a", "feat(x): b"], "0.1.0"), "minor");
  assert.equal(bumpFromCommits(["feat!: drop thing"], "0.1.0"), "minor");
  assert.equal(bumpFromCommits(["feat!: drop thing"], "1.2.0"), "major");
  assert.equal(bumpFromCommits(["fix: a\n\nBREAKING CHANGE: x"], "1.2.0"), "major");
  assert.equal(bumpFromCommits(["Merge branch main"], "0.1.0"), "patch");
});

test("bumpFiles moves every version field together and only those", () => {
  const root = fixture();
  const before = currentVersion(root);
  const thirdPartyBefore = /name = "vswhom"\nversion = "([^"]+)"/u.exec(fs.readFileSync(path.join(root, "helper/Cargo.lock"), "utf8"))?.[1];
  assert.ok(thirdPartyBefore, "fixture needs a third-party crate to prove it is left alone");
  const { newVersion } = bumpFiles(root, nextVersion(before, "minor"));
  assert.notEqual(newVersion, before);
  assert.equal(currentVersion(root), newVersion);
  const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
  assert.equal(JSON.parse(read("extension/manifest.json")).version, newVersion);
  assert.equal(JSON.parse(read("extension/package.json")).version, newVersion);
  assert.equal(JSON.parse(read("webapp/package.json")).version, newVersion);
  assert.equal(JSON.parse(read("helper/crates/app/tauri.conf.json")).version, newVersion);
  const release = JSON.parse(read("release/manifest.json"));
  assert.equal(release.extension.version, newVersion);
  for (const lock of ["extension/package-lock.json", "webapp/package-lock.json"]) {
    const parsed = JSON.parse(read(lock));
    assert.equal(parsed.version, newVersion);
    assert.equal(parsed.packages[""].version, newVersion);
  }
  assert.match(read("helper/Cargo.toml"), new RegExp(`^version = "${newVersion.replaceAll(".", "\\.")}"`, "mu"));
  const cargoLock = read("helper/Cargo.lock");
  for (const name of ["notetaker-app", "notetaker-audio", "notetaker-core"]) {
    assert.match(cargoLock, new RegExp(`name = "${name}"\\nversion = "${newVersion.replaceAll(".", "\\.")}"`, "u"));
  }
  // Third-party crates keep their own version, even if it happens to equal the old project version.
  assert.match(cargoLock, new RegExp(`name = "vswhom"\\nversion = "${thirdPartyBefore.replaceAll(".", "\\.")}"`, "u"));
  fs.rmSync(root, { recursive: true, force: true });
});
