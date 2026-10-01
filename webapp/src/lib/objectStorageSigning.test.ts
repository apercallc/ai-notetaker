import { afterEach, describe, expect, it, vi } from "vitest";
import { directUploadsEnabled, signDirectUpload } from "./objectStorage";

afterEach(() => vi.unstubAllEnvs());
describe("real SDK direct upload signatures", () => {
  it("signs byte length and immutability headers without a network request", async () => {
    vi.stubEnv("MANAGED_DIRECT_UPLOADS", "true");
    vi.stubEnv("MANAGED_OBJECT_UPLOAD_ORIGIN", "https://audio.fixture-account.r2.cloudflarestorage.com");
    vi.stubEnv("R2_BUCKET", "audio"); vi.stubEnv("R2_ACCOUNT_ID", "fixture-account");
    vi.stubEnv("R2_ENDPOINT", ""); vi.stubEnv("R2_ACCESS_KEY_ID", "fixture-access");
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "fixture-secret");
    expect(directUploadsEnabled()).toBe(true);
    const signed = await signDirectUpload("uploads/workspace/upload/fixture", 4, 120);
    const url = new URL(signed.url);
    expect(url.origin).toBe("https://audio.fixture-account.r2.cloudflarestorage.com");
    expect(url.searchParams.get("X-Amz-SignedHeaders")?.split(";")).toEqual(expect.arrayContaining(["content-length", "content-type", "host", "if-none-match"]));
    expect(url.searchParams.get("x-amz-checksum-crc32")).toBeNull();
    expect(signed.headers).toEqual({ "Content-Type": "application/octet-stream", "If-None-Match": "*" });
    expect(signed.url).not.toContain("fixture-secret");
    vi.stubEnv("MANAGED_OBJECT_UPLOAD_ORIGIN", "https://wrong.example.com");
    await expect(signDirectUpload("uploads/workspace/upload/fixture", 4, 120)).rejects.toThrow("differs");
  });
});
