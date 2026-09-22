import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { validateManifest } from "./validate-release-manifest.mjs";

function replaceTemplate(template, replacements) {
  return Object.entries(replacements).reduce((result, [key, value]) => result.replaceAll(`__${key}__`, value), template);
}

function findArtifact(manifest, platform, formats) {
  return manifest.artifacts.find((artifact) => artifact.platform === platform && formats.includes(artifact.format));
}

export function renderReleasePackages(manifest, outputDirectory) {
  const errors = validateManifest(manifest);
  if (errors.length > 0) throw new Error(errors.join("; "));
  if (manifest.status !== "published") throw new Error("package output requires a published release manifest");

  const mac = findArtifact(manifest, "macos", ["dmg", "pkg"]);
  const windows = findArtifact(manifest, "windows", ["nsis", "msi"]);
  if (!mac) throw new Error("published manifest needs a macOS DMG or PKG for Homebrew");
  if (!windows) throw new Error("published manifest needs a Windows NSIS or MSI artifact");

  const replacements = (artifact) => ({
    VERSION: manifest.version,
    URL: artifact.url,
    SHA256: artifact.sha256,
  });
  const files = [
    ["homebrew/ai-notetaker.rb.in", "homebrew/Casks/ai-notetaker.rb", replacements(mac)],
    ["winget/AI.Notetaker.yaml.in", "winget/AI.Notetaker.yaml", replacements(windows)],
    ["chocolatey/ai-notetaker.nuspec.in", "chocolatey/ai-notetaker.nuspec", replacements(windows)],
    ["chocolatey/tools/chocolateyinstall.ps1.in", "chocolatey/tools/chocolateyinstall.ps1", replacements(windows)],
  ];

  for (const [templatePath, outputPath, values] of files) {
    const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "packaging", templatePath);
    const destination = path.join(outputDirectory, outputPath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, replaceTemplate(fs.readFileSync(source, "utf8"), values));
  }
}

if (process.argv[1] && process.argv[1].endsWith("render-release-packages.mjs")) {
  const manifestPath = process.argv[2] ?? "release/manifest.json";
  const outputDirectory = process.argv[3] ?? path.join(os.tmpdir(), "ai-notetaker-release-packages");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  renderReleasePackages(manifest, outputDirectory);
  console.log(`Rendered release packages to ${outputDirectory}`);
}
