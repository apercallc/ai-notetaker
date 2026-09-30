import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deriveExtensionId, readManifestKey, rotate } from "./rotate-extension-id.mjs";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const PINNED_ID = "jidooookkdbbbhkkdmcajnnnhhphodok";

function newPublicKey() {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return publicKey.export({ type: "spki", format: "der" }).toString("base64");
}

/** A scratch git repo holding only the tracked files that mention the pinned ID, plus the manifest. */
function fixture() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "rotate-id-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
  const wanted = new Set(["extension/manifest.json"]);
  for (const relative of tracked) {
    if (!/\.(md|json|ts|tsx|mjs|rs|sh|ps1|template|example)$|postinst|postrm/u.test(relative)) continue;
    if (/^(webapp\/package-lock|extension\/package-lock|helper\/Cargo\.lock)/u.test(relative)) continue;
    try {
      if (fs.readFileSync(path.join(repoRoot, relative), "utf8").includes(PINNED_ID)) wanted.add(relative);
    } catch {
      // unreadable or binary: irrelevant
    }
  }
  for (const relative of wanted) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, relative), path.join(root, relative));
  }
  execFileSync("git", ["add", "-A"], { cwd: root });
  return root;
}

test("the derivation reproduces the ID Chrome derives from the committed key", () => {
  assert.equal(deriveExtensionId(readManifestKey(repoRoot)), PINNED_ID);
});

test("a garbled or non-key paste is rejected instead of producing a bogus ID", () => {
  assert.throws(() => deriveExtensionId("not-a-key"));
  assert.throws(() => deriveExtensionId(Buffer.from("hello world").toString("base64")));
});

test("rotating to a store key rewrites every pinned ID and the manifest key together", () => {
  const root = fixture();
  try {
    const key = newPublicKey();
    const expected = deriveExtensionId(key);
    const result = rotate(root, key);
    assert.equal(result.oldId, PINNED_ID);
    assert.equal(result.newId, expected);
    assert.match(result.newId, /^[a-p]{32}$/u);

    for (const relative of [
      "extension/manifest.json",
      "release/manifest.json",
      "webapp/src/lib/cors.ts",
      "scripts/validate-release-manifest.mjs",
      "helper/native-messaging-host-manifest/com.ainotetaker.helper.json.template",
      "helper/crates/app/scripts/debian/postinst",
      "helper/crates/app/scripts/macos/install-native-messaging.sh",
      "helper/crates/app/resources/windows/install-native-messaging.ps1",
    ]) {
      assert.ok(result.changed.includes(relative), `${relative} should have been rewritten`);
    }
    // No pinned occurrence survives anywhere that was rewritten.
    for (const relative of result.changed) {
      assert.ok(!fs.readFileSync(path.join(root, relative), "utf8").includes(PINNED_ID), `${relative} still names the old ID`);
    }
    // The pair stays consistent: the new manifest key derives the new ID.
    assert.equal(deriveExtensionId(readManifestKey(root)), expected);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, "release/manifest.json"), "utf8")).extension.id, expected);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a dry run reports the changes without touching any file", () => {
  const root = fixture();
  try {
    const before = fs.readFileSync(path.join(root, "extension/manifest.json"), "utf8");
    const result = rotate(root, newPublicKey(), { dryRun: true });
    assert.ok(result.changed.length > 5);
    assert.equal(fs.readFileSync(path.join(root, "extension/manifest.json"), "utf8"), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rotating to the key already in use changes nothing", () => {
  const root = fixture();
  try {
    const result = rotate(root, readManifestKey(root));
    assert.equal(result.unchanged, true);
    assert.deepEqual(result.changed, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
