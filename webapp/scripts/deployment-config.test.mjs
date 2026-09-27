import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function readJson(file) {
  return JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), "utf8"));
}

describe("deployment process configuration", () => {
  it("keeps the Railway webapp and worker as separate runnable services", async () => {
    const [webapp, worker, packageJson] = await Promise.all([
      readJson("railway.json"),
      readJson("railway-worker.json"),
      readJson("package.json"),
    ]);

    expect(webapp.deploy.startCommand).toBe("npm run db:migrate && npm run start");
    expect(worker.deploy.startCommand).toBe("npm run managed:worker");
    expect(packageJson.scripts["managed:worker"]).toBe("node scripts/managed-worker.mjs");
    expect(worker.deploy.startCommand).not.toBe(webapp.deploy.startCommand);
  });
});
