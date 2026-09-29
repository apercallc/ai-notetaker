import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { validateManifest } from "./validate-release-manifest.mjs";
import { generateReleaseManifest } from "./generate-release-manifest.mjs";
import os from "node:os";
import path from "node:path";

const manifest = JSON.parse(fs.readFileSync(new URL("../release/manifest.json", import.meta.url), "utf8"));

test("the checked-in release manifest is valid and intentionally unpublished", () => {
  assert.deepEqual(validateManifest(manifest), []);
  assert.equal(manifest.status, "unpublished");
  assert.deepEqual(manifest.artifacts, []);
});

test("published metadata cannot omit native artifacts", () => {
  const published = structuredClone(manifest);
  published.status = "published";
  const errors = validateManifest(published).join("\n");
  assert.match(errors, /published manifests must contain artifacts/);
  assert.match(errors, /extension fallback ZIP/);
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

test("published manifests need a supported extension install channel and platform artifacts", () => {
  const published = structuredClone(manifest);
  published.status = "published";
  published.artifacts = [
    { platform: "macos", architecture: "arm64", format: "dmg", url: "https://github.com/apercallc/ai-notetaker/releases/download/v0.1.0/a.dmg", sha256: "a".repeat(64), signatureStatus: "unsigned" },
    { platform: "windows", architecture: "x86_64", format: "nsis", url: "https://github.com/apercallc/ai-notetaker/releases/download/v0.1.0/a.exe", sha256: "b".repeat(64), signatureStatus: "unsigned" },
  ];
  const errors = validateManifest(published).join("\n");
  assert.match(errors, /Chrome Web Store URL or extension fallback ZIP URL/);
  assert.match(errors, /linux deb artifact/);
});

test("only Chrome Web Store detail URLs and release ZIP fallback URLs are accepted", () => {
  const published = structuredClone(manifest);
  published.status = "published";
  published.extension.chromeWebStoreUrl = "https://example.com/detail/not-the-store";
  published.extension.fallbackZipUrl = "https://example.com/ai-notetaker-extension-v0.1.0.zip";
  published.artifacts = [
    { platform: "macos", architecture: "arm64", format: "dmg", url: "https://github.com/apercallc/ai-notetaker/releases/download/v0.1.0/a.dmg", sha256: "a".repeat(64), signatureStatus: "unsigned" },
    { platform: "windows", architecture: "x86_64", format: "nsis", url: "https://github.com/apercallc/ai-notetaker/releases/download/v0.1.0/a.exe", sha256: "b".repeat(64), signatureStatus: "unsigned" },
    { platform: "linux", architecture: "x86_64", format: "deb", url: "https://github.com/apercallc/ai-notetaker/releases/download/v0.1.0/a.deb", sha256: "c".repeat(64), signatureStatus: "unsigned" },
  ];
  const errors = validateManifest(published).join("\n");
  assert.match(errors, /Chrome Web Store detail URL/);
  assert.match(errors, /GitHub release extension ZIP URL/);
});

test("release metadata is generated from direct unsigned native assets", () => {
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
  });

  assert.equal(generated.status, "published");
  assert.equal(generated.artifacts.length, 3);
  assert.equal(generated.artifacts[0].signatureStatus, "unsigned");
  assert.match(generated.extension.fallbackZipUrl, /ai-notetaker-extension-.+\.zip/);
  assert.match(generated.artifacts[0].url, /releases\/download\/v0\.1\.0/);
});
