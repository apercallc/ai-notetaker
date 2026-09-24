import { afterEach, describe, expect, it, vi } from "vitest";

const sent: Array<{ kind: string; input: Record<string, unknown> }> = [];

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    constructor(public readonly config: Record<string, unknown>) {}

    async send(command: { kind: string; input: Record<string, unknown> }) {
      sent.push(command);
      if (command.kind === "get") {
        return { Body: { transformToByteArray: async () => new Uint8Array([7, 8, 9]) } };
      }
      return {};
    }
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

import { deleteObject, getObject, putObject } from "./objectStorage";

const originalS3 = {
  bucket: process.env.S3_BUCKET,
  region: process.env.S3_REGION,
  endpoint: process.env.S3_ENDPOINT,
  accessKeyId: process.env.S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE,
  prefix: process.env.S3_PREFIX,
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

describe("object storage backends", () => {
  afterEach(() => {
    sent.length = 0;
    restoreS3Env();
  });

  it("uses the configured private S3-compatible bucket for writes, reads, and deletes", async () => {
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

  it("rejects traversal-like object keys before touching storage", async () => {
    await expect(putObject("../outside", new Uint8Array([1]))).rejects.toThrow("invalid object key");
  });
});
