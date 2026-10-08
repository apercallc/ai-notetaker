import * as esbuild from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";

const watch = process.argv.includes("--watch");
// Sourcemaps only for local development (--watch or --sourcemap). Release zips
// must not ship .map files or sourceMappingURL comments.
const sourcemap = watch || process.argv.includes("--sourcemap");

const entryPoints = [
  "src/background.ts",
  "src/popup/popup.ts",
  "src/settings/settings.ts",
  "src/settings/recorderSettings.ts",
  "src/onboarding/onboarding.ts",
  "src/meeting/meeting.ts",
  "src/meet/offscreen.ts",
  "src/meet/captureWorklet.ts",
  "src/meet/microphone.ts",
  "src/content/meetWidget.ts",
  "src/content/directMain.ts",
  "src/content/directBridge.ts",
];

const buildOptions = {
  entryPoints,
  bundle: true,
  outdir: "dist",
  outbase: "src",
  format: "esm",
  target: "chrome116",
  sourcemap,
  logLevel: "info",
  // The content script inlines its stylesheet into a closed shadow root.
  loader: { ".css": "text" },
};

async function copyStatic() {
  await mkdir("dist", { recursive: true });
  await cp("manifest.json", "dist/manifest.json");
  await cp("icons", "dist/icons", { recursive: true });
  for (const page of ["popup", "settings", "onboarding", "meeting"]) {
    await cp(`src/${page}/${page}.html`, `dist/${page}/${page}.html`);
    await cp(`src/${page}/${page}.css`, `dist/${page}/${page}.css`);
  }
  await cp("src/settings/legacy.html", "dist/settings/legacy.html");
  await cp("src/meet/offscreen.html", "dist/meet/offscreen.html");
  await cp("src/meet/microphone.html", "dist/meet/microphone.html");
  await cp("src/meet/microphone.css", "dist/meet/microphone.css");
  await cp("src/shared/theme.css", "dist/shared/theme.css");
}

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  await copyStatic();
  console.log("Watching for changes...");
} else {
  // A stale dist/ (old sourcemaps, removed pages) must never reach a release zip.
  await rm("dist", { recursive: true, force: true });
  await esbuild.build(buildOptions);
  await copyStatic();
  console.log(`Build complete. Load dist/ as an unpacked extension in chrome://extensions.`);
}

if (!existsSync("dist/manifest.json")) {
  console.error("Build did not produce dist/manifest.json");
  process.exit(1);
}
