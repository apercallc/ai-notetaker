import { mkdtemp, mkdir, rm, utimes, writeFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sweepStaleStagedObjects } from "./objectStorage";

let dir: string;
const saved = { dir: process.env.OBJECT_STORAGE_DIR, s3: process.env.S3_BUCKET, r2: process.env.R2_BUCKET };

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "ai-notetaker-sweep-"));
  process.env.OBJECT_STORAGE_DIR = dir;
  delete process.env.S3_BUCKET;
  delete process.env.R2_BUCKET;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  for (const [key, value] of [["OBJECT_STORAGE_DIR", saved.dir], ["S3_BUCKET", saved.s3], ["R2_BUCKET", saved.r2]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function put(relative: string, ageHours: number): Promise<string> {
  const target = path.join(dir, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "audio");
  const when = new Date(Date.now() - ageHours * 3_600_000);
  await utimes(target, when, when);
  return target;
}

describe("filesystem staged-audio sweep", () => {
  it("removes files older than 48 hours under uploads/, keeps fresh ones, prunes empty folders and ignores other prefixes", async () => {
    await put("uploads/ws/old-upload/0.chunk", 60);
    await put("uploads/ws/live-upload/0.chunk", 2);
    await put("recordings/legacy.wav", 500);

    await expect(sweepStaleStagedObjects()).resolves.toBe(1);
    expect(await readdir(path.join(dir, "uploads/ws"))).toEqual(["live-upload"]);
    expect(await readdir(path.join(dir, "recordings"))).toEqual(["legacy.wav"]);
  });

  it("is a no-op when nothing has been staged", async () => {
    await expect(sweepStaleStagedObjects()).resolves.toBe(0);
  });
});
