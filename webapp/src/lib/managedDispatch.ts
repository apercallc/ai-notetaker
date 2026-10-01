import { workerJobRunUrl } from "./deploymentConfig";

/** Pushes a freshly queued job to the worker; if that fails the polling worker still picks it up. */
export function dispatchManagedJob(jobId: string, workspaceId: string): void {
  // The durable database queue is consumed by the standalone worker. HTTP
  // execution is an explicit compatibility option, never the production default.
  if (process.env.MANAGED_WORKER_MODE !== "http") return;
  const workerToken = process.env.MANAGED_WORKER_TOKEN;
  if (!workerToken) return;
  // The target comes from WORKER_URL/APP_URL configuration, never from the
  // request URL or Host header, which the caller controls. If it cannot be
  // resolved the job simply stays queued for the polling worker.
  let url: URL;
  try {
    url = workerJobRunUrl(jobId);
  } catch (error) {
    console.error("managed job dispatch skipped: worker URL is not configured", { jobId, workspaceId, error: error instanceof Error ? error.message : String(error) });
    return;
  }
  void fetch(url, {
    method: "POST",
    headers: { "x-worker-token": workerToken, "x-workspace-id": workspaceId },
  }).catch((error) => {
    console.error("managed job dispatch failed", { jobId, workspaceId, error: error instanceof Error ? error.message : String(error) });
  });
}
