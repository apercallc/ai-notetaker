import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_OBJECT_KEY_LENGTH = 300;

interface S3Backend {
  client: S3Client;
  bucket: string;
  prefix: string;
}

let cachedS3: { fingerprint: string; backend: S3Backend } | null = null;

function storageRoot(): string {
  return process.env.OBJECT_STORAGE_DIR ?? path.join(process.cwd(), ".data", "objects");
}

/**
 * Hosted deployments should use a private S3-compatible bucket so uploads do
 * not depend on one web process's ephemeral filesystem. Leaving S3_BUCKET
 * unset intentionally keeps the simple persistent-volume backend for local
 * Docker/self-hosted installs.
 */
function s3Backend(): S3Backend | null {
  const bucket = process.env.S3_BUCKET?.trim();
  if (!bucket) return null;

  const region = process.env.S3_REGION?.trim() || process.env.AWS_REGION?.trim() || "auto";
  const endpoint = process.env.S3_ENDPOINT?.trim() || "";
  const accessKeyId = process.env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY?.trim();
  const forcePathStyle = process.env.S3_FORCE_PATH_STYLE === "true";
  const prefix = (process.env.S3_PREFIX?.trim() || "").replace(/^\/+|\/+$/g, "");
  const fingerprint = JSON.stringify({ bucket, region, endpoint, accessKeyId, secretAccessKey, forcePathStyle, prefix });
  if (cachedS3?.fingerprint === fingerprint) return cachedS3.backend;

  const client = new S3Client({
    region,
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle,
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
  });
  const backend = { client, bucket, prefix };
  cachedS3 = { fingerprint, backend };
  return backend;
}

function safeKey(key: string): string {
  if (!key || key.length > MAX_OBJECT_KEY_LENGTH || key.startsWith("/") || key.includes("..")) {
    throw new Error("invalid object key");
  }
  return key.replace(/[^a-zA-Z0-9/_-]/g, "_");
}

function backendKey(backend: S3Backend, key: string): string {
  return backend.prefix ? `${backend.prefix}/${key}` : key;
}

export function chunkObjectKey(workspaceId: string, uploadId: string, index: number, checksum: string): string {
  const digest = createHash("sha256").update(`${workspaceId}:${uploadId}:${index}:${checksum}`).digest("hex");
  return `uploads/${workspaceId}/${uploadId}/${index}-${digest}.chunk`;
}

export async function putObject(key: string, bytes: Uint8Array): Promise<void> {
  const normalized = safeKey(key);
  const backend = s3Backend();
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
  const backend = s3Backend();
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
  const backend = s3Backend();
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
