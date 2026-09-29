import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_OBJECT_KEY_LENGTH = 300;

interface ObjectBackend {
  client: S3Client;
  bucket: string;
  prefix: string;
  provider: "r2" | "s3";
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
