import { afterEach, describe, expect, it, vi } from "vitest";

const sent: Array<{ kind: string; input: Record<string, unknown> }> = [];
const clients: Array<Record<string, unknown>> = [];
let listing: Array<{ Key: string; LastModified: Date }> = [];
let listResponse: ((input: Record<string, unknown>) => unknown) | undefined;
let deleteFailureKey: string | undefined;

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    constructor(public readonly config: Record<string, unknown>) { clients.push(config); }

    async send(command: { kind: string; input: Record<string, unknown> }) {
      sent.push(command);
      if (command.kind === "get") {
        return { Body: { transformToByteArray: async () => new Uint8Array([7, 8, 9]) } };
      }
      if (command.kind === "list") return listResponse?.(command.input) ?? { Contents: listing, IsTruncated: false };
      if (command.kind === "delete" && command.input.Key === deleteFailureKey) throw new Error("storage unavailable");
      return {};
    }
  },
  ListObjectsV2Command: class {
    readonly kind = "list";
    constructor(readonly input: Record<string, unknown>) {}
  },
  PutObjectCommand: class {
    readonly kind = "put";
    constructor(readonly input: Record<string, unknown>) {}
  },
  GetObjectCommand: class {
    readonly kind = "get";
    constructor(readonly input: Record<string, unknown>) {}
  },
  DeleteObjectCommand: class {
    readonly kind = "delete";
    constructor(readonly input: Record<string, unknown>) {}
  },
}));

import { deleteObject, getObject, putObject, sweepStaleStagedObjects } from "./objectStorage";

const originalS3 = {
  bucket: process.env.S3_BUCKET,
  region: process.env.S3_REGION,
  endpoint: process.env.S3_ENDPOINT,
  accessKeyId: process.env.S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE,
  prefix: process.env.S3_PREFIX,
};

const originalR2 = {
  accountId: process.env.R2_ACCOUNT_ID,
  bucket: process.env.R2_BUCKET,
  endpoint: process.env.R2_ENDPOINT,
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  prefix: process.env.R2_PREFIX,
};

function restoreS3Env(): void {
  const values: Record<string, string | undefined> = {
    S3_BUCKET: originalS3.bucket,
    S3_REGION: originalS3.region,
    S3_ENDPOINT: originalS3.endpoint,
    S3_ACCESS_KEY_ID: originalS3.accessKeyId,
    S3_SECRET_ACCESS_KEY: originalS3.secretAccessKey,
    S3_FORCE_PATH_STYLE: originalS3.forcePathStyle,
    S3_PREFIX: originalS3.prefix,
  };
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function restoreR2Env(): void {
  const values: Record<string, string | undefined> = {
    R2_ACCOUNT_ID: originalR2.accountId,
    R2_BUCKET: originalR2.bucket,
    R2_ENDPOINT: originalR2.endpoint,
    R2_ACCESS_KEY_ID: originalR2.accessKeyId,
    R2_SECRET_ACCESS_KEY: originalR2.secretAccessKey,
    R2_PREFIX: originalR2.prefix,
  };
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("object storage backends", () => {
  afterEach(() => {
    sent.length = 0;
    clients.length = 0;
    listing = [];
    listResponse = undefined;
    deleteFailureKey = undefined;
    restoreS3Env();
    restoreR2Env();
  });

  it("uses the configured private legacy S3 bucket for writes, reads, and deletes", async () => {
    process.env.S3_BUCKET = "private-meetings";
    process.env.S3_REGION = "us-east-1";
    process.env.S3_ENDPOINT = "https://objects.example.test";
    process.env.S3_ACCESS_KEY_ID = "access";
    process.env.S3_SECRET_ACCESS_KEY = "secret";
    process.env.S3_FORCE_PATH_STYLE = "true";
    process.env.S3_PREFIX = "tenant-data";

    await putObject("uploads/workspace/upload/0.chunk", new Uint8Array([1, 2]));
    await expect(getObject("uploads/workspace/upload/0.chunk")).resolves.toEqual(new Uint8Array([7, 8, 9]));
    await deleteObject("uploads/workspace/upload/0.chunk");

    expect(sent.map(({ kind }) => kind)).toEqual(["put", "get", "delete"]);
    expect(sent[0]?.input).toMatchObject({ Bucket: "private-meetings", Key: "tenant-data/uploads/workspace/upload/0_chunk", ContentLength: 2 });
    expect(sent[1]?.input).toMatchObject({ Bucket: "private-meetings", Key: "tenant-data/uploads/workspace/upload/0_chunk" });
    expect(sent[2]?.input).toMatchObject({ Bucket: "private-meetings", Key: "tenant-data/uploads/workspace/upload/0_chunk" });
  });

  it("stores managed audio in the configured private Cloudflare R2 bucket", async () => {
    process.env.R2_ACCOUNT_ID = "account-id";
    process.env.R2_BUCKET = "private-audio";
    process.env.R2_ACCESS_KEY_ID = "r2-access";
    process.env.R2_SECRET_ACCESS_KEY = "r2-secret";
    process.env.R2_PREFIX = "tenant-audio";
    delete process.env.R2_ENDPOINT;

    await putObject("uploads/workspace/upload/0.chunk", new Uint8Array([1, 2]));
    await expect(getObject("uploads/workspace/upload/0.chunk")).resolves.toEqual(new Uint8Array([7, 8, 9]));
    await deleteObject("uploads/workspace/upload/0.chunk");

    expect(clients[0]).toMatchObject({
      region: "auto",
      endpoint: "https://account-id.r2.cloudflarestorage.com",
      forcePathStyle: false,
      credentials: { accessKeyId: "r2-access", secretAccessKey: "r2-secret" },
    });
    expect(sent[0]?.input).toMatchObject({ Bucket: "private-audio", Key: "tenant-audio/uploads/workspace/upload/0_chunk" });
    expect(sent.map(({ kind }) => kind)).toEqual(["put", "get", "delete"]);
  });

  it("fails closed when an R2 bucket is set without private API credentials", async () => {
    process.env.R2_BUCKET = "private-audio";
    delete process.env.R2_ACCOUNT_ID;
    delete process.env.R2_ENDPOINT;
    delete process.env.R2_ACCESS_KEY_ID;
    delete process.env.R2_SECRET_ACCESS_KEY;

    await expect(putObject("uploads/workspace/upload/0.chunk", new Uint8Array([1]))).rejects.toThrow("Cloudflare R2 requires");
  });

  it("sweeps only staged audio older than the cutoff from the private bucket, honouring the key prefix", async () => {
    process.env.S3_BUCKET = "private-meetings";
    process.env.S3_ACCESS_KEY_ID = "access";
    process.env.S3_SECRET_ACCESS_KEY = "secret";
    process.env.S3_PREFIX = "tenant-data";
    const now = new Date("2026-10-01T12:00:00Z");
    listing = [
      { Key: "tenant-data/uploads/w/u/0-old.chunk", LastModified: new Date("2026-09-28T12:00:00Z") },
      { Key: "tenant-data/uploads/w/u/1-fresh.chunk", LastModified: new Date("2026-10-01T06:00:00Z") },
      { Key: "tenant-data/uploads/w/u/2-edge.chunk", LastModified: new Date("2026-09-29T12:00:00Z") },
    ];
    await expect(sweepStaleStagedObjects(now)).resolves.toBe(2);
    expect(sent[0]).toMatchObject({ kind: "list", input: { Bucket: "private-meetings", Prefix: "tenant-data/uploads/" } });
    const deleted = sent.filter((command) => command.kind === "delete").map((command) => command.input.Key);
    expect(deleted).toEqual(["tenant-data/uploads/w/u/0-old.chunk", "tenant-data/uploads/w/u/2-edge.chunk"]);
    listing = [];
  });

  it("rejects traversal-like object keys before touching storage", async () => {
    await expect(putObject("../outside", new Uint8Array([1]))).rejects.toThrow("invalid object key");
  });

  it("resumes bounded sweeps past fresh pages and starts over after reaching the end", async () => {
    process.env.S3_BUCKET = "paginated-sweep";
    delete process.env.R2_BUCKET;
    const now = new Date("2026-10-01T12:00:00Z");
    listResponse = (input) => {
      const page = Number(input.ContinuationToken ?? 0);
      return {
        Contents: [{ Key: `uploads/page-${page}`, LastModified: page < 5 ? now : new Date("2026-09-28T12:00:00Z") }],
        IsTruncated: page < 6,
        NextContinuationToken: page < 6 ? String(page + 1) : undefined,
      };
    };

    await expect(sweepStaleStagedObjects(now)).resolves.toBe(0);
    expect(sent.filter(({ kind }) => kind === "list")).toHaveLength(5);
    sent.length = 0;
    await expect(sweepStaleStagedObjects(now)).resolves.toBe(2);
    expect(sent.filter(({ kind }) => kind === "list").map(({ input }) => input.ContinuationToken)).toEqual(["5", "6"]);
    expect(sent.filter(({ kind }) => kind === "delete").map(({ input }) => input.Key)).toEqual(["uploads/page-5", "uploads/page-6"]);
    sent.length = 0;
    await sweepStaleStagedObjects(now);
    expect(sent[0]?.input.ContinuationToken).toBeUndefined();
  });

  it("retries a failed cleanup page without losing sweep progress", async () => {
    process.env.S3_BUCKET = "failed-page-sweep";
    delete process.env.R2_BUCKET;
    const now = new Date("2026-10-01T12:00:00Z");
    listResponse = (input) => {
      const page = Number(input.ContinuationToken ?? 0);
      return {
        Contents: [{ Key: `uploads/page-${page}`, LastModified: new Date("2026-09-28T12:00:00Z") }],
        IsTruncated: page < 2,
        NextContinuationToken: String(page + 1),
      };
    };
    deleteFailureKey = "uploads/page-1";
    await expect(sweepStaleStagedObjects(now)).rejects.toThrow("storage unavailable");
    deleteFailureKey = undefined;
    sent.length = 0;
    await expect(sweepStaleStagedObjects(now)).resolves.toBe(2);
    expect(sent.filter(({ kind }) => kind === "list").map(({ input }) => input.ContinuationToken)).toEqual(["1", "2"]);
  });
});
