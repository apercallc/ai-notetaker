import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

/**
 * Outbound HTTP to addresses a user typed (webhooks), hardened against
 * server-side request forgery: only public addresses are contacted, the check
 * runs on the address actually connected to (so DNS rebinding cannot swap in an
 * internal one), redirects are never followed, and time and response size are
 * bounded. Fixed vendor endpoints (Slack, Notion) use it too; it costs nothing.
 *
 * A self-hosted operator who deliberately targets their own network (for
 * example a local n8n) can set INTEGRATIONS_ALLOW_PRIVATE_NETWORKS=true.
 */
export class SafeFetchError extends Error {}

const blocked = new net.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["100::", 64], ["2001::", 32], ["2001:db8::", 32],
  ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) blocked.addSubnet(network, prefix, "ipv6");

/** True only for a globally routable unicast address. Unparseable input is not public. */
export function isPublicAddress(address: string): boolean {
  const host = address.replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  const family = net.isIP(host);
  if (family === 0) return false;
  if (family === 6) {
    // IPv4-mapped (::ffff:a.b.c.d) addresses follow the IPv4 rules.
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(host);
    if (mapped) return isPublicAddress(mapped[1]!);
    const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
    if (hexMapped) {
      const high = Number.parseInt(hexMapped[1]!, 16);
      const low = Number.parseInt(hexMapped[2]!, 16);
      return isPublicAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
  }
  return !blocked.check(host, family === 6 ? "ipv6" : "ipv4");
}

export function privateNetworksAllowed(env: Record<string, string | undefined> = process.env): boolean {
  // Never on managed hosting: tenants must not be able to aim webhooks at internal addresses.
  return env.INTEGRATIONS_ALLOW_PRIVATE_NETWORKS === "true" && env.MANAGED_HOSTING !== "true";
}

const PRIVATE_NAME = /(^|\.)(localhost|local|internal|localdomain|home\.arpa|lan|intranet)$/i;

export interface UrlRules {
  allowPrivate?: boolean;
  /** Plain http, for a self-hosted receiver on a private network. */
  allowHttp?: boolean;
}

/** Parses and screens a destination URL. Returns the URL or a message safe to show the person who typed it. */
export function validateOutboundUrl(raw: string, rules: UrlRules = {}): { url: URL } | { error: string } {
  const text = raw.trim();
  if (!text || text.length > 2_048) return { error: "Enter a URL (up to 2,048 characters)." };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { error: "That doesn't look like a valid URL." };
  }
  const httpAllowed = rules.allowHttp ?? rules.allowPrivate ?? false;
  if (url.protocol !== "https:" && !(httpAllowed && url.protocol === "http:")) return { error: "Use an https:// URL." };
  if (url.username || url.password) return { error: "Don't put a username or password in the URL." };
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) return { error: "That URL has no host." };
  if (!rules.allowPrivate) {
    if (PRIVATE_NAME.test(host)) return { error: "That address is on a private network and can't be used." };
    if (net.isIP(host) !== 0 && !isPublicAddress(host)) return { error: "That address is on a private network and can't be used." };
    if (net.isIP(host) === 0 && !host.includes(".")) return { error: "Use a full host name such as hooks.example.com." };
  }
  return { url };
}

function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: LookupOptions, callback: (...args: unknown[]) => void): void => {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error);
      const list = addresses as LookupAddress[];
      if (list.length === 0) return callback(new SafeFetchError("The host did not resolve."));
      if (!allowPrivate && list.some((entry) => !isPublicAddress(entry.address))) return callback(new SafeFetchError("That host resolves to a private network address."));
      if (options.all) callback(null, list);
      else callback(null, list[0]!.address, list[0]!.family);
    });
  };
}

export interface SafeRequest {
  url: string | URL;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** Response bytes kept; the rest is discarded. */
  maxResponseBytes?: number;
  allowPrivate?: boolean;
  allowHttp?: boolean;
}

export interface SafeResponse {
  status: number;
  /** At most `maxResponseBytes` of the response, as text. */
  body: string;
}

export function safeRequest(request: SafeRequest): Promise<SafeResponse> {
  const allowPrivate = request.allowPrivate ?? privateNetworksAllowed();
  const checked = typeof request.url === "string" ? validateOutboundUrl(request.url, { allowPrivate, allowHttp: request.allowHttp }) : { url: request.url };
  if ("error" in checked) return Promise.reject(new SafeFetchError(checked.error));
  const url = checked.url;
  const timeoutMs = request.timeoutMs ?? 10_000;
  const maxBytes = request.maxResponseBytes ?? 64 * 1024;
  const payload = request.body === undefined ? undefined : Buffer.from(request.body, "utf8");
  const transport = url.protocol === "https:" ? https : http;

  return new Promise<SafeResponse>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      action();
    };
    const req = transport.request(
      url,
      {
        method: request.method ?? "POST",
        headers: { ...(request.headers ?? {}), ...(payload ? { "content-length": String(payload.length) } : {}) },
        lookup: guardedLookup(allowPrivate) as never,
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          if (size < maxBytes) chunks.push(chunk.subarray(0, maxBytes - size));
          size += chunk.length;
          if (size > maxBytes) {
            // Past the cap: answer with what was kept and stop downloading the rest.
            finish(() => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
            response.destroy();
          }
        });
        response.on("end", () => finish(() => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") })));
        response.on("error", () => finish(() => reject(new SafeFetchError("The connection was interrupted."))));
      },
    );
    const deadline = setTimeout(() => {
      req.destroy();
      finish(() => reject(new SafeFetchError("The request timed out.")));
    }, timeoutMs);
    req.on("error", (error) => finish(() => reject(error instanceof SafeFetchError ? error : new SafeFetchError("Couldn't connect to that address."))));
    if (payload) req.write(payload);
    req.end();
  });
}
