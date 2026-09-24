import * as esbuild from "esbuild";
import { cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

const watch = process.argv.includes("--watch");

const entryPoints = [
  "src/background.ts",
  "src/popup/popup.ts",
  "src/settings/settings.ts",
  "src/onboarding/onboarding.ts",
  "src/meeting/meeting.ts",
  "src/actions/actions.ts",
  "src/meet/offscreen.ts",
];

const buildOptions = {
  entryPoints,
  bundle: true,
  outdir: "dist",
  outbase: "src",
  format: "esm",
  target: "chrome116",
  sourcemap: true,
  logLevel: "info",
};

async function copyStatic() {
  await mkdir("dist", { recursive: true });
  await cp("manifest.json", "dist/manifest.json");
  await cp("icons", "dist/icons", { recursive: true });
  for (const page of ["popup", "settings", "onboarding", "meeting", "actions"]) {
    await cp(`src/${page}/${page}.html`, `dist/${page}/${page}.html`);
    await cp(`src/${page}/${page}.css`, `dist/${page}/${page}.css`);
  }
  await cp("src/meet/offscreen.html", "dist/meet/offscreen.html");
  await cp("src/shared/theme.css", "dist/shared/theme.css");
}

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  await copyStatic();
  console.log("Watching for changes...");
} else {
  await esbuild.build(buildOptions);
  await copyStatic();
  console.log(`Build complete. Load dist/ as an unpacked extension in chrome://extensions.`);
}

if (!existsSync("dist/manifest.json")) {
  console.error("Build did not produce dist/manifest.json");
  process.exit(1);
}
