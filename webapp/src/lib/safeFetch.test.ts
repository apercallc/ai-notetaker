import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SafeFetchError, isPublicAddress, safeRequest, validateOutboundUrl } from "./safeFetch";

describe("isPublicAddress", () => {
  it("accepts ordinary public addresses", () => {
    for (const address of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "2001:4860:4860::8888", "[2606:4700:4700::1111]"]) {
      expect(isPublicAddress(address), address).toBe(true);
    }
  });

  it("refuses loopback, private, link-local, metadata, carrier-grade NAT, multicast and reserved IPv4", () => {
    for (const address of ["127.0.0.1", "127.255.255.255", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "192.0.2.1", "198.18.0.1"]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    expect(isPublicAddress("172.32.0.1")).toBe(true);
    expect(isPublicAddress("100.63.255.255")).toBe(true);
  });

  it("refuses internal IPv6, including IPv4-mapped forms of private IPv4", () => {
    for (const address of ["::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "2001:db8::1", "::ffff:127.0.0.1", "::ffff:10.1.2.3", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "64:ff9b::7f00:1", "2002:7f00:1::1"]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    expect(isPublicAddress("::ffff:8.8.8.8")).toBe(true);
    expect(isPublicAddress("::ffff:808:808")).toBe(true);
  });

  it("treats anything unparseable as not public", () => {
    for (const address of ["", "localhost", "example.com", "999.1.1.1", "1.2.3"]) expect(isPublicAddress(address), address).toBe(false);
  });
});

describe("validateOutboundUrl", () => {
  it("accepts an https URL with a real host", () => {
    const result = validateOutboundUrl("https://hooks.example.com/path?x=1");
    expect("url" in result && result.url.hostname).toBe("hooks.example.com");
  });

  it("rejects other schemes, credentials, bare hosts and private names or literals", () => {
    for (const bad of [
      "", "not a url", "ftp://example.com/x", "http://example.com/x", "https://user:pass@example.com/x", "https://localhost/x",
      "https://service.internal/x", "https://printer.local/x", "https://intranet/x", "https://127.0.0.1/x", "https://[::1]/x",
      "https://169.254.169.254/latest/meta-data", "https://10.0.0.1/x", "https://192.168.0.10:8443/x", "https://[::ffff:127.0.0.1]/x",
      `https://example.com/${"x".repeat(2_100)}`,
    ]) {
      expect(validateOutboundUrl(bad), bad).toHaveProperty("error");
    }
  });

  it("lets an operator opt in to private targets and plain http", () => {
    expect(validateOutboundUrl("http://localhost:5678/webhook", { allowPrivate: true })).toHaveProperty("url");
    expect(validateOutboundUrl("http://10.0.0.5/x", { allowPrivate: true })).toHaveProperty("url");
    expect(validateOutboundUrl("http://example.com/x", { allowHttp: true })).toHaveProperty("url");
  });
});

describe("safeRequest", () => {
  let server: http.Server;
  let base: string;
  const seen: Array<{ method?: string; headers: http.IncomingHttpHeaders; body: string }> = [];

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        seen.push({ method: request.method, headers: request.headers, body: Buffer.concat(chunks).toString() });
        if (request.url === "/redirect") {
          response.writeHead(302, { location: "https://example.com/elsewhere" }).end();
        } else if (request.url === "/big") {
          response.writeHead(200).end("x".repeat(500_000));
        } else if (request.url === "/slow") {
          setTimeout(() => response.writeHead(200).end("late"), 2_000);
        } else {
          response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("refuses a private destination by default, even when it is a literal IP", async () => {
    await expect(safeRequest({ url: `${base}/x`, allowHttp: true })).rejects.toBeInstanceOf(SafeFetchError);
    expect(seen).toHaveLength(0);
  });

  it("refuses a hostname that resolves to a loopback address", async () => {
    // "localhost" is also rejected by name, so test the resolver guard with a name that is not filtered.
    const port = (server.address() as AddressInfo).port;
    await expect(safeRequest({ url: `http://127.0.0.1.nip.io:${port}/x`, allowHttp: true, timeoutMs: 3_000 })).rejects.toBeInstanceOf(SafeFetchError);
    expect(seen).toHaveLength(0);
  });

  it("sends the body and headers and returns status and text when private targets are allowed", async () => {
    const response = await safeRequest({ url: `${base}/hook`, method: "POST", headers: { "content-type": "application/json", "x-test": "1" }, body: '{"a":1}', allowPrivate: true });
    expect(response).toEqual({ status: 200, body: '{"ok":true}' });
    const request = seen.at(-1)!;
    expect(request.method).toBe("POST");
    expect(request.headers["x-test"]).toBe("1");
    expect(request.headers["content-length"]).toBe("7");
    expect(request.body).toBe('{"a":1}');
  });

  it("does not follow redirects", async () => {
    const response = await safeRequest({ url: `${base}/redirect`, allowPrivate: true });
    expect(response.status).toBe(302);
  });

  it("keeps only the first bytes of a huge response", async () => {
    const response = await safeRequest({ url: `${base}/big`, allowPrivate: true, maxResponseBytes: 1_000 });
    expect(response.body).toHaveLength(1_000);
  });

  it("gives up on a slow server", async () => {
    await expect(safeRequest({ url: `${base}/slow`, allowPrivate: true, timeoutMs: 300 })).rejects.toThrow("timed out");
  });

  it("reports a refused connection with a generic message that carries no internals", async () => {
    const error = await safeRequest({ url: "http://127.0.0.1:9/x", allowPrivate: true, timeoutMs: 2_000 }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(SafeFetchError);
    expect((error as Error).message).toBe("Couldn't connect to that address.");
  });
});
