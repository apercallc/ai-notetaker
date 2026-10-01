import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { directUploadOrigin } from "./directUploadConfig";
import { readMaintenanceCursor, writeMaintenanceCursor } from "./maintenanceCursor";
import { prisma } from "./db";
import type { Prisma } from "@prisma/client";

const MAX_OBJECT_KEY_LENGTH = 300;

interface ObjectBackend {
  client: S3Client;
  bucket: string;
  prefix: string;
  provider: "r2" | "s3";
  identity: string;
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
    requestChecksumCalculation: "WHEN_REQUIRED",
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle,
    // Bound connect and socket-idle time so a stalled object store cannot hang a job (and its
    // lease heartbeat) forever.
    requestHandler: { connectionTimeout: 10_000, requestTimeout: 120_000 },
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
  });
  const backend: ObjectBackend = { client, bucket, prefix, provider, identity: `${provider}:${bucket}:${prefix}:${endpoint}` };
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

function deletionBackendId(): string {
  return createHash("sha256").update(objectBackend()?.identity ?? `filesystem:${storageRoot()}`).digest("hex");
}

export async function queueObjectDeletion(key: string, notBefore = new Date(), tx: Prisma.TransactionClient = prisma): Promise<void> {
  const objectKey = safeKey(key);
  const backendId = deletionBackendId();
  const id = createHash("sha256").update(`${backendId}:${objectKey}`).digest("hex");
  await tx.deferredObjectDeletion.upsert({ where: { id }, create: { id, backendId, objectKey, nextAttemptAt: notBefore }, update: { nextAttemptAt: notBefore } });
}

export async function queueObjectDeletions(objects: Array<{ objectKey: string; signedUntil: Date | null }>, tx: Prisma.TransactionClient): Promise<void> {
  const backendId = deletionBackendId();
  const valid = objects.filter((object) => {
    try { safeKey(object.objectKey); return true; } catch { return false; }
  });
  for (let offset = 0; offset < valid.length; offset += 500) {
    await tx.deferredObjectDeletion.createMany({ skipDuplicates: true, data: valid.slice(offset, offset + 500).map((object) => {
      const objectKey = safeKey(object.objectKey);
      return { id: createHash("sha256").update(`${backendId}:${objectKey}`).digest("hex"), backendId, objectKey, nextAttemptAt: object.signedUntil ?? new Date() };
    }) });
  }
}

/** Bounded durable retries; poison objects cannot hold up fresh listing pages. */
export async function drainObjectDeletions(): Promise<void> {
  const rows = await prisma.deferredObjectDeletion.findMany({ where: { backendId: deletionBackendId(), nextAttemptAt: { lte: new Date() } }, orderBy: { nextAttemptAt: "asc" }, take: 100 });
  for (let offset = 0; offset < rows.length; offset += 16) {
    await Promise.all(rows.slice(offset, offset + 16).map(async (row) => {
      try {
        await deleteObject(row.objectKey);
        await prisma.deferredObjectDeletion.deleteMany({ where: { id: row.id } });
      } catch {
        await prisma.deferredObjectDeletion.updateMany({ where: { id: row.id }, data: { attempts: { increment: 1 }, nextAttemptAt: new Date(Date.now() + Math.min(3_600_000, 60_000 * 2 ** Math.min(row.attempts, 6))) } });
      }
    }));
  }
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

export function directUploadsEnabled(): boolean {
  return process.env.MANAGED_DIRECT_UPLOADS === "true" && Boolean(directUploadOrigin()) && objectBackend() !== null;
}

/** Single-use immutable PUT; size and conditional header are signed. */
export async function signDirectUpload(key: string, byteLength: number, expiresIn: number): Promise<{ url: string; headers: Record<string, string> }> {
  const backend = objectBackend();
  if (!backend || !directUploadsEnabled()) throw new Error("direct uploads are disabled");
  const command = new PutObjectCommand({ Bucket: backend.bucket, Key: backendKey(backend, safeKey(key)),
    ContentLength: byteLength, ContentType: "application/octet-stream", IfNoneMatch: "*" });
  const url = await getSignedUrl(backend.client, command, {
    expiresIn, signableHeaders: new Set(["content-length", "content-type", "if-none-match"]),
  });
  if (new URL(url).origin !== directUploadOrigin()) throw new Error("signed upload origin differs from MANAGED_OBJECT_UPLOAD_ORIGIN");
  return { url, headers: { "Content-Type": "application/octet-stream", "If-None-Match": "*" } };
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
    const cursorId = `object-sweep:${backend.provider}:${backend.bucket}:${backend.prefix}`;
    let token = await readMaintenanceCursor(cursorId);
    for (let page = 0; page < SWEEP_LIST_PAGES; page += 1) {
      const listing = await backend.client.send(new ListObjectsV2Command({
        Bucket: backend.bucket,
        Prefix: backendKey(backend, STAGED_PREFIX),
        ContinuationToken: token,
      }));
      for (const object of listing.Contents ?? []) {
        if (!object.Key || !object.LastModified || object.LastModified.getTime() > cutoff) continue;
        try {
          await backend.client.send(new DeleteObjectCommand({ Bucket: backend.bucket, Key: object.Key }));
          deleted += 1;
        } catch {
          const relative = backend.prefix ? object.Key.slice(backend.prefix.length + 1) : object.Key;
          await queueObjectDeletion(relative);
        }
      }
      // Keep progress across bounded worker passes, including pages with only
      // fresh objects. Otherwise the first few thousand keys can indefinitely
      // hide older orphaned audio later in the listing. Advance only after all
      // deletions on this page succeed, so failed cleanup is retried.
      token = listing.IsTruncated ? listing.NextContinuationToken : undefined;
      backend.sweepContinuationToken = token;
      await writeMaintenanceCursor(cursorId, token);
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
