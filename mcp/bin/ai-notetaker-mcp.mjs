#!/usr/bin/env node
// Bridges an MCP client that speaks stdio (Claude Desktop, Cursor, ...) to the
// read-only MCP endpoint of an AI Notetaker instance. No dependencies.
//
//   NOTETAKER_URL    your instance, e.g. https://notes.example.com
//   NOTETAKER_TOKEN  a read-only token from Settings > Integrations
import { createInterface } from "node:readline";

const base = (process.env.NOTETAKER_URL ?? "").trim().replace(/\/+$/, "");
const token = (process.env.NOTETAKER_TOKEN ?? "").trim();
if (!base || !token) {
  console.error("ai-notetaker-mcp: set NOTETAKER_URL and NOTETAKER_TOKEN (create a read-only token in Settings > Integrations).");
  process.exit(1);
}
let endpoint;
try {
  const url = new URL(`${base}/api/mcp`);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !local) throw new Error("use https");
  endpoint = url.toString();
} catch {
  console.error("ai-notetaker-mcp: NOTETAKER_URL must be an https:// address (http is allowed only for localhost).");
  process.exit(1);
}

const workspace = (process.env.NOTETAKER_WORKSPACE_ID ?? "").trim();
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const failure = (id, message) => send({ jsonrpc: "2.0", id, error: { code: -32000, message } });
let inFlight = 0;
let closed = false;
const maybeExit = () => { if (closed && inFlight === 0) process.exit(0); };

createInterface({ input: process.stdin })
  .on("line", async (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    const id = message && typeof message === "object" && "id" in message ? message.id : undefined;
    inFlight += 1;
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token}`, ...(workspace ? { "x-workspace-id": workspace } : {}) },
        body: line,
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 202) return;
      const text = await response.text();
      if (response.ok) send(JSON.parse(text));
      else if (id !== undefined) failure(id, response.status === 401 ? "The token was rejected. Create a new read-only token in Settings." : `The notes server answered HTTP ${response.status}.`);
    } catch {
      if (id !== undefined) failure(id, "Could not reach the notes server.");
    } finally {
      inFlight -= 1;
      maybeExit();
    }
  })
  .on("close", () => {
    closed = true;
    maybeExit();
  });
