import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generateUpdaterManifest } from "./generate-updater-manifest.mjs";

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "updater-manifest-"));
  for (const [name, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), contents);
  }
  return dir;
}
const full = {
  "helper-macos-arm64-v1.2.3/x/bundle/macos/AI.Notetaker.app.tar.gz": "a",
  "helper-macos-arm64-v1.2.3/x/bundle/macos/AI.Notetaker.app.tar.gz.sig": "SIG-ARM\n",
  "helper-macos-x86_64-v1.2.3/x/bundle/macos/AI.Notetaker.app.tar.gz": "b",
  "helper-macos-x86_64-v1.2.3/x/bundle/macos/AI.Notetaker.app.tar.gz.sig": "SIG-X86",
  "helper-windows-latest-v1.2.3/x/bundle/nsis/AI.Notetaker_1.2.3_x64-setup.exe": "c",
  "helper-windows-latest-v1.2.3/x/bundle/nsis/AI.Notetaker_1.2.3_x64-setup.exe.sig": "SIG-WIN",
};

test("builds a platform map with unique macOS archive names and embedded signatures", () => {
  const dir = fixture(full);
  const { manifest, copies } = generateUpdaterManifest({ assetDirectory: dir, tag: "v1.2.3", repository: "o/r", now: new Date("2026-10-07T00:00:00Z") });
  assert.equal(manifest.version, "1.2.3");
  assert.equal(manifest.pub_date, "2026-10-07T00:00:00.000Z");
  assert.deepEqual(Object.keys(manifest.platforms).sort(), ["darwin-aarch64", "darwin-x86_64", "windows-x86_64"]);
  assert.equal(manifest.platforms["darwin-aarch64"].signature, "SIG-ARM");
  assert.equal(manifest.platforms["darwin-aarch64"].url, "https://github.com/o/r/releases/download/v1.2.3/AI.Notetaker_1.2.3_arm64.app.tar.gz");
  assert.equal(manifest.platforms["darwin-x86_64"].url, "https://github.com/o/r/releases/download/v1.2.3/AI.Notetaker_1.2.3_x86_64.app.tar.gz");
  assert.equal(manifest.platforms["windows-x86_64"].url, "https://github.com/o/r/releases/download/v1.2.3/AI.Notetaker_1.2.3_x64-setup.exe");
  assert.equal(copies.length, 2);
});

test("blocks the release when a platform or a signature is missing", () => {
  const noWindows = { ...full };
  delete noWindows["helper-windows-latest-v1.2.3/x/bundle/nsis/AI.Notetaker_1.2.3_x64-setup.exe"];
  delete noWindows["helper-windows-latest-v1.2.3/x/bundle/nsis/AI.Notetaker_1.2.3_x64-setup.exe.sig"];
  assert.throws(() => generateUpdaterManifest({ assetDirectory: fixture(noWindows), tag: "v1.2.3", repository: "o/r" }), /windows-x86_64/);
  const noSig = { ...full };
  delete noSig["helper-macos-x86_64-v1.2.3/x/bundle/macos/AI.Notetaker.app.tar.gz.sig"];
  assert.throws(() => generateUpdaterManifest({ assetDirectory: fixture(noSig), tag: "v1.2.3", repository: "o/r" }), /no \.sig/);
});
