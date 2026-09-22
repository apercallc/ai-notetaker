import { execFileSync } from "node:child_process";

const container = "ai-notetaker-test-postgres";
const port = process.env.AI_NOTETAKER_TEST_DB_PORT ?? "5499";
const databaseUrl = `postgresql://notetaker:notetaker@localhost:${port}/ainotetaker_test`;
let started = false;

function run(command, args, env = {}) {
  execFileSync(command, args, {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

try {
  run("docker", [
    "run",
    "--rm",
    "--name",
    container,
    "-e",
    "POSTGRES_USER=notetaker",
    "-e",
    "POSTGRES_PASSWORD=notetaker",
    "-e",
    "POSTGRES_DB=ainotetaker_test",
    "-p",
    `${port}:5432`,
    "-d",
    "postgres:16-alpine",
  ]);
  started = true;

  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      execFileSync("docker", [
        "exec",
        container,
        "pg_isready",
        "-U",
        "notetaker",
        "-d",
        "ainotetaker_test",
      ], { stdio: "ignore" });
      break;
    } catch {
      if (attempt === 29) throw new Error("Postgres did not become ready in 30 seconds");
      await sleep(1000);
    }
  }

  const env = { DATABASE_URL: databaseUrl, AUTH_TOKEN: "local-test-token" };
  run("npx", ["prisma", "generate"], env);
  run("npx", ["prisma", "migrate", "deploy"], env);
  run("npm", ["test"], env);
} finally {
  if (started) {
    try {
      execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" });
    } catch {
      // The container may already have exited; Docker's --rm handles cleanup.
    }
  }
}
