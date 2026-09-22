import { spawn } from "node:child_process";

for (const name of ["DATABASE_URL", "AUTH_TOKEN"]) {
  if (!process.env[name]?.trim()) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
}

const migration = spawn("npx", ["prisma", "migrate", "deploy"], {
  stdio: "inherit",
  env: process.env,
});

migration.on("error", (error) => {
  console.error(`Could not run Prisma migrations: ${error.message}`);
  process.exit(1);
});

migration.on("exit", (code, signal) => {
  if (signal || code !== 0) {
    console.error(`Prisma migrations failed${signal ? ` with ${signal}` : ` with exit code ${code}`}`);
    process.exit(code ?? 1);
  }

  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    console.error("No webapp start command was provided");
    process.exit(1);
  }

  const server = spawn(command, args, { stdio: "inherit", env: process.env });
  const forwardSignal = (signalName) => server.kill(signalName);
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));
  process.on("SIGINT", () => forwardSignal("SIGINT"));
  server.on("error", (error) => {
    console.error(`Could not start the webapp: ${error.message}`);
    process.exit(1);
  });
  server.on("exit", (serverCode, serverSignal) => process.exit(serverCode ?? (serverSignal ? 1 : 0)));
});
