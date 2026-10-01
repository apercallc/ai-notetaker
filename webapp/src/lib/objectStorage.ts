import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_OBJECT_KEY_LENGTH = 300;

interface ObjectBackend {
  client: S3Client;
  bucket: string;
  prefix: string;
  provider: "r2" | "s3";
  sweepContinuationToken?: string;
}

let cachedObjectBackend: { fingerprint: string; backend: ObjectBackend } | null = null;

function storageRoot(): string {
  return process.env.OBJECT_STORAGE_DIR ?? path.join(process.cwd(), ".data", "objects");
}

/**
 * Managed audio is private, temporary processing staging; workers delete it
 * after success and the expiry sweep removes abandoned/failed uploads.
 * Cloudflare R2 is supported through its S3 API, as are existing S3 buckets.
 * With neither configured, local installs keep their filesystem backend.
 */
function objectBackend(): ObjectBackend | null {
  const r2Bucket = process.env.R2_BUCKET?.trim();
  const legacyBucket = process.env.S3_BUCKET?.trim();
  const provider: ObjectBackend["provider"] = r2Bucket ? "r2" : "s3";
  const bucket = r2Bucket || legacyBucket;
  if (!bucket) return null;

  const region = provider === "r2"
    ? "auto"
    : process.env.S3_REGION?.trim() || process.env.AWS_REGION?.trim() || "auto";
  const endpoint = provider === "r2"
    ? process.env.R2_ENDPOINT?.trim() || (process.env.R2_ACCOUNT_ID?.trim()
      ? `https://${process.env.R2_ACCOUNT_ID.trim()}.r2.cloudflarestorage.com`
      : "")
    : process.env.S3_ENDPOINT?.trim() || "";
  const accessKeyId = (provider === "r2" ? process.env.R2_ACCESS_KEY_ID : process.env.S3_ACCESS_KEY_ID)?.trim();
  const secretAccessKey = (provider === "r2" ? process.env.R2_SECRET_ACCESS_KEY : process.env.S3_SECRET_ACCESS_KEY)?.trim();
  // R2's documented S3 endpoint uses the bucket as the virtual-host prefix.
  const forcePathStyle = provider === "r2" ? false : process.env.S3_FORCE_PATH_STYLE === "true";
  const prefix = ((provider === "r2" ? process.env.R2_PREFIX : process.env.S3_PREFIX)?.trim() || "").replace(/^\/+|\/+$/g, "");
  if (provider === "r2" && (!endpoint || !accessKeyId || !secretAccessKey)) {
    throw new Error("Cloudflare R2 requires an account endpoint and server-side API credentials");
  }
  const fingerprint = JSON.stringify({ provider, bucket, region, endpoint, accessKeyId, secretAccessKey, forcePathStyle, prefix });
  if (cachedObjectBackend?.fingerprint === fingerprint) return cachedObjectBackend.backend;

  const client = new S3Client({
    region,
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle,
    // Bound connect and socket-idle time so a stalled object store cannot hang a job (and its
    // lease heartbeat) forever.
    requestHandler: { connectionTimeout: 10_000, requestTimeout: 120_000 },
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
  });
  const backend: ObjectBackend = { client, bucket, prefix, provider };
  cachedObjectBackend = { fingerprint, backend };
  return backend;
}

function safeKey(key: string): string {
  if (!key || key.length > MAX_OBJECT_KEY_LENGTH || key.startsWith("/") || key.includes("..")) {
    throw new Error("invalid object key");
  }
  return key.replace(/[^a-zA-Z0-9/_-]/g, "_");
}

function backendKey(backend: ObjectBackend, key: string): string {
  return backend.prefix ? `${backend.prefix}/${key}` : key;
}

export function chunkObjectKey(workspaceId: string, uploadId: string, index: number, checksum: string): string {
  const digest = createHash("sha256").update(`${workspaceId}:${uploadId}:${index}:${checksum}`).digest("hex");
  return `uploads/${workspaceId}/${uploadId}/${index}-${digest}.chunk`;
}

export async function putObject(key: string, bytes: Uint8Array): Promise<void> {
  const normalized = safeKey(key);
  const backend = objectBackend();
  if (backend) {
    await backend.client.send(new PutObjectCommand({
      Bucket: backend.bucket,
      Key: backendKey(backend, normalized),
      Body: bytes,
      ContentLength: bytes.byteLength,
      ContentType: "application/octet-stream",
    }));
    return;
  }
  const target = path.join(/*turbopackIgnore: true*/ storageRoot(), normalized);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
}

export async function deleteObject(key: string): Promise<void> {
  const normalized = safeKey(key);
  const backend = objectBackend();
  if (backend) {
    await backend.client.send(new DeleteObjectCommand({
      Bucket: backend.bucket,
      Key: backendKey(backend, normalized),
    }));
    return;
  }
  await rm(path.join(/*turbopackIgnore: true*/ storageRoot(), normalized), { force: true });
}

export async function getObject(key: string): Promise<Uint8Array> {
  const normalized = safeKey(key);
  const backend = objectBackend();
  if (backend) {
    const response = await backend.client.send(new GetObjectCommand({
      Bucket: backend.bucket,
      Key: backendKey(backend, normalized),
    }));
    if (!response.Body) throw new Error("object storage returned an empty body");
    return new Uint8Array(await response.Body.transformToByteArray());
  }
  return new Uint8Array(await readFile(path.join(/*turbopackIgnore: true*/ storageRoot(), normalized)));
}

/** Staged audio is legitimately kept 24 hours at most; anything older is an orphan. */
export const STALE_STAGED_OBJECT_MS = 48 * 60 * 60 * 1_000;
const STAGED_PREFIX = "uploads/";
const SWEEP_LIST_PAGES = 5;

/**
 * Deletes staged audio older than `maxAgeMs`, independent of database state.
 * The privacy promise ("unfinished uploads are removed within 24 hours") must
 * not depend on the database rows that normally drive cleanup, and Railway
 * buckets have no lifecycle rules, so this is the storage-level backstop.
 * Bounded per call (a few thousand keys); repeated calls drain any backlog.
 */
export async function sweepStaleStagedObjects(now = new Date(), maxAgeMs = STALE_STAGED_OBJECT_MS): Promise<number> {
  const cutoff = now.getTime() - maxAgeMs;
  const backend = objectBackend();
  if (backend) {
    let deleted = 0;
    let token = backend.sweepContinuationToken;
    for (let page = 0; page < SWEEP_LIST_PAGES; page += 1) {
      const listing = await backend.client.send(new ListObjectsV2Command({
        Bucket: backend.bucket,
        Prefix: backendKey(backend, STAGED_PREFIX),
        ContinuationToken: token,
      }));
      for (const object of listing.Contents ?? []) {
        if (!object.Key || !object.LastModified || object.LastModified.getTime() > cutoff) continue;
        await backend.client.send(new DeleteObjectCommand({ Bucket: backend.bucket, Key: object.Key }));
        deleted += 1;
      }
      // Keep progress across bounded worker passes, including pages with only
      // fresh objects. Otherwise the first few thousand keys can indefinitely
      // hide older orphaned audio later in the listing. Advance only after all
      // deletions on this page succeed, so failed cleanup is retried.
      token = listing.IsTruncated ? listing.NextContinuationToken : undefined;
      backend.sweepContinuationToken = token;
      if (!token) break;
    }
    return deleted;
  }
  return sweepDirectory(path.join(/*turbopackIgnore: true*/ storageRoot(), STAGED_PREFIX), cutoff);
}

async function sweepDirectory(directory: string, cutoff: number): Promise<number> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  let deleted = 0;
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      deleted += await sweepDirectory(target, cutoff);
      if ((await readdir(target).catch(() => ["x"])).length === 0) await rm(target, { recursive: true, force: true });
    } else if ((await stat(target)).mtimeMs <= cutoff) {
      await rm(target, { force: true });
      deleted += 1;
    }
  }
  return deleted;
}
