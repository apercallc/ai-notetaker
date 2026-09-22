import fs from "node:fs";
import process from "node:process";

export function validateManifest(manifest) {
  const errors = [];
  const add = (condition, message) => {
    if (!condition) errors.push(message);
  };
  add(manifest && typeof manifest === "object", "manifest must be an object");
  if (!manifest || typeof manifest !== "object") return errors;

  add(manifest.schemaVersion === 1, "schemaVersion must be 1");
  add(manifest.product === "ai-notetaker", "product must be ai-notetaker");
  add(typeof manifest.version === "string" && /^\d+\.\d+\.\d+$/.test(manifest.version), "version must be semver X.Y.Z");
  add(manifest.status === "published" || manifest.status === "unpublished", "status must be published or unpublished");
  add(manifest.extension?.version === manifest.version, "extension.version must match version");
  add(manifest.extension?.id === "jidooookkdbbbhkkdmcajnnnhhphodok", "extension.id must match the committed stable extension ID");
  add(Number.isInteger(manifest.protocol?.version) && manifest.protocol.version >= 1, "protocol.version must be a positive integer");
  add(Number.isInteger(manifest.protocol?.minimumSupported) && manifest.protocol.minimumSupported >= 1, "protocol.minimumSupported must be a positive integer");
  add(manifest.protocol?.minimumSupported <= manifest.protocol?.version, "minimumSupported cannot exceed protocol.version");
  add(Array.isArray(manifest.artifacts), "artifacts must be an array");

  for (const [index, artifact] of (manifest.artifacts ?? []).entries()) {
    add(["macos", "windows", "linux"].includes(artifact.platform), `artifacts[${index}].platform is invalid`);
    add(["arm64", "x86_64", "universal", "amd64"].includes(artifact.architecture), `artifacts[${index}].architecture is invalid`);
    add(["dmg", "pkg", "msi", "nsis", "deb", "appimage"].includes(artifact.format), `artifacts[${index}].format is invalid`);
    add(typeof artifact.url === "string" && /^https:\/\//.test(artifact.url), `artifacts[${index}].url must be HTTPS`);
    add(typeof artifact.sha256 === "string" && /^[a-f0-9]{64}$/.test(artifact.sha256), `artifacts[${index}].sha256 must be a lowercase SHA-256`);
    add(["signed", "notarized", "signed_and_notarized", "checksummed"].includes(artifact.signatureStatus), `artifacts[${index}].signatureStatus is invalid`);
  }

  if (manifest.status === "published") {
    add(manifest.artifacts.length > 0, "published manifests must contain artifacts");
    add(typeof manifest.extension.chromeWebStoreUrl === "string" && /^https:\/\//.test(manifest.extension.chromeWebStoreUrl), "published manifests need an HTTPS Chrome Web Store URL");
    add(typeof manifest.extension.fallbackZipUrl === "string" && /^https:\/\//.test(manifest.extension.fallbackZipUrl), "published manifests need an HTTPS fallback extension ZIP URL");
  }

  for (const name of ["homebrew", "winget", "chocolatey"]) {
    add(typeof manifest.packageManagers?.[name]?.installCommand === "string", `packageManagers.${name}.installCommand is required`);
    add(typeof manifest.packageManagers?.[name]?.updateCommand === "string", `packageManagers.${name}.updateCommand is required`);
  }
  add(manifest.docker?.scope === "history-webapp-only", "docker scope must remain history-webapp-only");

  return errors;
}

if (process.argv[1] && process.argv[1].endsWith("validate-release-manifest.mjs")) {
  const path = process.argv[2] ?? "release/manifest.json";
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (error) {
    console.error(`Could not read ${path}: ${error.message}`);
    process.exit(1);
  }
  const errors = validateManifest(manifest);
  if (errors.length > 0) {
    console.error(errors.map((error) => `- ${error}`).join("\n"));
    process.exit(1);
  }
  console.log(`Valid AI Notetaker release manifest: ${path}`);
}
