import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { after, before, test } from "node:test";

const bridge = new URL("../bin/ai-notetaker-mcp.mjs", import.meta.url).pathname;
let server;
let url;
const seen = [];

before(async () => {
  server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      seen.push({ headers: request.headers, body });
      const message = JSON.parse(body);
      if (request.headers.authorization !== "Bearer ant_good") return response.writeHead(401).end("{}");
      if (message.id === undefined) return response.writeHead(202).end();
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { echoed: message.method } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

function run(env, lines) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bridge], { env: { PATH: process.env.PATH, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout: stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)), stderr }));
    child.stdin.end(lines.map((line) => `${line}\n`).join(""));
  });
}

test("forwards requests with the bearer token, answers on stdout and stays silent for notifications", async () => {
  const result = await run({ NOTETAKER_URL: url, NOTETAKER_TOKEN: "ant_good" }, [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  ]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.stdout, [{ jsonrpc: "2.0", id: 1, result: { echoed: "tools/list" } }]);
  assert.equal(seen.at(-2).headers.authorization, "Bearer ant_good");
});

test("turns a rejected token into a readable error for the client", async () => {
  const result = await run({ NOTETAKER_URL: url, NOTETAKER_TOKEN: "ant_bad" }, [JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" })]);
  assert.equal(result.stdout[0].id, 7);
  assert.match(result.stdout[0].error.message, /token was rejected/);
});

test("answers unparseable input with a JSON-RPC parse error", async () => {
  const result = await run({ NOTETAKER_URL: url, NOTETAKER_TOKEN: "ant_good" }, ["not json"]);
  assert.equal(result.stdout[0].error.code, -32700);
});

test("refuses to start without configuration or over plain http to a remote host", async () => {
  assert.equal((await run({}, [])).code, 1);
  const remote = await run({ NOTETAKER_URL: "http://notes.example.com", NOTETAKER_TOKEN: "ant_good" }, []);
  assert.equal(remote.code, 1);
  assert.match(remote.stderr, /https/);
});
