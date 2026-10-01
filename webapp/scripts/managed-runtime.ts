import "dotenv/config";
import { prisma } from "../src/lib/db";
import { withMaintenanceLease } from "../src/lib/maintenanceCursor";
import { isBenignJobRace, nextManagedJob, runManagedJob, runManagedMaintenance } from "../src/lib/managedWorker";

// Actual provider/storage work runs here, outside the Next.js web process.
// One job at a time per replica; two capture channels can run concurrently.
// Scale with an explicit replica ceiling and the shared spend budgets.
if (process.env.MANAGED_HOSTING !== "true") throw new Error("Managed runtime requires MANAGED_HOSTING=true");
const cleaner = process.argv.includes("--cleaner");
const once = process.argv.includes("--once");
// Reuse the existing worker at small scale; a dedicated cleaner is optional.
const maintainInWorker = process.env.MANAGED_WORKER_MAINTENANCE !== "false";
let nextMaintenanceAt = 0;
let stopping = false;
const stop = () => { stopping = true; };
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
let wake: (() => void) | undefined;
function pause(ms: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    wake = () => { clearTimeout(timer); resolve(); };
    if (stopping) wake();
  });
}
process.once("SIGTERM", () => wake?.());
process.once("SIGINT", () => wake?.());
try {
  do {
    let delay = cleaner ? 60_000 : 5_000;
    try {
      if (cleaner) await withMaintenanceLease(runManagedMaintenance);
      else {
        if (maintainInWorker && Date.now() >= nextMaintenanceAt) {
          nextMaintenanceAt = Date.now() + 60_000;
          try {
            await withMaintenanceLease(runManagedMaintenance);
          } catch (error) {
            console.error("managed maintenance failed", { errorClass: error instanceof Error ? error.name : "Error" });
            if (once) process.exitCode = 1;
          }
        }
        const job = await nextManagedJob();
        if (job) {
          await runManagedJob(job.workspaceId, job.jobId);
          delay = 0; // Drain backlog without a fixed five-second gap per job.
        }
      }
    } catch (error) {
      if (!isBenignJobRace(error)) console.error("managed runtime operation failed", { errorClass: error instanceof Error ? error.name : "Error" });
      delay = 10_000;
      if (once && !isBenignJobRace(error)) process.exitCode = 1;
    }
    if (!once && !stopping) await pause(delay);
  } while (!once && !stopping);
} finally {
  await prisma.$disconnect();
}
