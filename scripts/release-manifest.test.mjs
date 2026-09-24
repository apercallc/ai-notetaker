import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { validateManifest } from "./validate-release-manifest.mjs";
import { renderReleasePackages } from "./render-release-packages.mjs";
import { generateReleaseManifest } from "./generate-release-manifest.mjs";
import os from "node:os";
import path from "node:path";

const manifest = JSON.parse(fs.readFileSync(new URL("../release/manifest.json", import.meta.url), "utf8"));

test("the checked-in release manifest is valid and intentionally unpublished", () => {
  assert.deepEqual(validateManifest(manifest), []);
  assert.equal(manifest.status, "unpublished");
  assert.deepEqual(manifest.artifacts, []);
});

test("published metadata cannot omit signed artifacts", () => {
  const published = structuredClone(manifest);
  published.status = "published";
  assert.match(validateManifest(published).join("\n"), /published manifests must contain artifacts/);
});

test("a mismatched extension ID is rejected", () => {
  const invalid = structuredClone(manifest);
  invalid.extension.id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  assert.match(validateManifest(invalid).join("\n"), /stable extension ID/);
});

test("published artifacts require a concrete format and architecture", () => {
  const published = structuredClone(manifest);
  published.status = "published";
  published.extension.chromeWebStoreUrl = "https://chromewebstore.google.com/detail/example";
  published.extension.fallbackZipUrl = "https://example.test/extension.zip";
  published.artifacts = [{ platform: "windows", url: "https://example.test/windows.exe", sha256: "b".repeat(64), signatureStatus: "signed" }];
  const errors = validateManifest(published).join("\n");
  assert.match(errors, /architecture is invalid/);
  assert.match(errors, /format is invalid/);
});

test("published metadata renders pinned package-manager templates", () => {
  const published = structuredClone(manifest);
  published.status = "published";
  published.extension.chromeWebStoreUrl = "https://chromewebstore.google.com/detail/example";
  published.extension.fallbackZipUrl = "https://example.test/extension.zip";
  published.artifacts = [
    { platform: "macos", architecture: "universal", format: "dmg", url: "https://example.test/macos.dmg", sha256: "a".repeat(64), signatureStatus: "signed_and_notarized" },
    { platform: "windows", architecture: "x86_64", format: "nsis", url: "https://example.test/windows.exe", sha256: "b".repeat(64), signatureStatus: "signed" },
  ];
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "ai-notetaker-release-test-"));
  renderReleasePackages(published, output);
  assert.match(fs.readFileSync(path.join(output, "homebrew/Casks/ai-notetaker.rb"), "utf8"), /a{64}/);
  assert.match(fs.readFileSync(path.join(output, "winget/AI.Notetaker.yaml"), "utf8"), /windows\.exe/);
});

test("release metadata is generated from checksummed native assets", () => {
  const assets = fs.mkdtempSync(path.join(os.tmpdir(), "ai-notetaker-release-assets-"));
  fs.mkdirSync(path.join(assets, "helper-macos"), { recursive: true });
  fs.mkdirSync(path.join(assets, "helper-windows"), { recursive: true });
  fs.mkdirSync(path.join(assets, "helper-ubuntu"), { recursive: true });
  fs.mkdirSync(path.join(assets, "extension"), { recursive: true });
  fs.writeFileSync(path.join(assets, "helper-macos", "AI Notetaker.dmg"), "mac");
  fs.writeFileSync(path.join(assets, "helper-windows", "AI Notetaker.exe"), "windows");
  fs.writeFileSync(path.join(assets, "helper-ubuntu", "AI Notetaker.deb"), "linux");
  fs.writeFileSync(path.join(assets, "extension", "ai-notetaker-extension-v0.1.0.zip"), "extension");

  const generated = generateReleaseManifest(manifest, {
    assetDirectory: assets,
    repository: "apercallc/ai-notetaker",
    tag: "v0.1.0",
    chromeWebStoreUrl: "https://chromewebstore.google.com/detail/example",
    signingConfirmed: true,
  });

  assert.equal(generated.status, "published");
  assert.equal(generated.artifacts.length, 3);
  assert.equal(generated.artifacts[0].signatureStatus, "checksummed");
  assert.match(generated.extension.fallbackZipUrl, /ai-notetaker-extension-v0.1.0.zip/);
  assert.match(generated.artifacts[0].url, /releases\/download\/v0\.1\.0/);
});
