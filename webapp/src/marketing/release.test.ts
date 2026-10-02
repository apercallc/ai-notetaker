import { afterEach, describe, expect, it, vi } from "vitest";
import { latestRelease } from "./release";

afterEach(() => vi.unstubAllGlobals());

describe("latest published release", () => {
  it("uses the current GitHub release tag and assets for website downloads", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      tag_name: "v9.8.7",
      html_url: "https://github.com/apercallc/ai-notetaker/releases/tag/v9.8.7",
      assets: [{
        name: "ai-notetaker-extension-v9.8.7.zip",
        browser_download_url: "https://github.com/apercallc/ai-notetaker/releases/download/v9.8.7/extension.zip",
        size: 1024,
      }],
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(latestRelease()).resolves.toMatchObject({
      tag: "v9.8.7",
      pageUrl: "https://github.com/apercallc/ai-notetaker/releases/tag/v9.8.7",
      extension: {
        url: "https://github.com/apercallc/ai-notetaker/releases/download/v9.8.7/extension.zip",
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/apercallc/ai-notetaker/releases/latest",
      expect.objectContaining({ next: { revalidate: 600 } }),
    );
  });

  it("returns no release when GitHub has no published release", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 })));
    await expect(latestRelease()).resolves.toBeNull();
  });
});
