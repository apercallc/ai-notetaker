import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import robots from "../app/robots";
import sitemap from "../app/sitemap";
import { GET as llms } from "../app/llms.txt/route";
import { FALLBACK_PRICE_AMOUNTS, FALLBACK_PRICE_LABELS, FAQS, LIMITS, governingLaw, supportEmail } from "./content";
import { breadcrumbNode, faqNode, howToNode, serializeJsonLd, softwareNode } from "./jsonld";
import { MARKETING_PATHS, isMarketingPath } from "./paths";
import { chromeWebStoreUrl, formatBytes, pickAssets } from "./release";

const ORIGIN = "https://notes.example.test";
const originals = { managed: process.env.MANAGED_HOSTING, url: process.env.APP_URL };
const canonicalBrandMark = readFileSync(fileURLToPath(new URL("../../../branding/ai-notetaker-mark.svg", import.meta.url)), "utf8");

beforeEach(() => {
  process.env.MANAGED_HOSTING = "true";
  process.env.APP_URL = ORIGIN;
});

afterEach(() => {
  for (const [key, value] of [["MANAGED_HOSTING", originals.managed], ["APP_URL", originals.url]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("marketing paths", () => {
  it("matches exact public paths only", () => {
    for (const path of MARKETING_PATHS) expect(isMarketingPath(path)).toBe(true);
    for (const path of ["/meetings", "/pricing/", "/pricing/x", "/Pricing", "/login", "/api/health", "//", ""]) {
      expect(isMarketingPath(path), path).toBe(false);
    }
  });
});

describe("brand assets", () => {
  it("uses the canonical mark for the app icon and public logo", () => {
    expect(readFileSync(fileURLToPath(new URL("../app/icon.svg", import.meta.url)), "utf8")).toBe(canonicalBrandMark);
    expect(readFileSync(fileURLToPath(new URL("../../public/ai-notetaker-mark.svg", import.meta.url)), "utf8")).toBe(canonicalBrandMark);
  });
});

describe("release assets", () => {
  it("sorts a release's files into platform installers, including both Mac architectures", () => {
    const picked = pickAssets([
      { name: "SHA256SUMS", browser_download_url: "https://x/sums", size: 1 },
      { name: "AI Notetaker_0.2.0_aarch64.dmg", browser_download_url: "https://x/mac", size: 5_000_000 },
      { name: "AI.Notetaker_0.2.0_x86_64-installer.dmg", browser_download_url: "https://x/mac-intel", size: 5_100_000 },
      { name: "AI Notetaker_0.2.0_x64-setup.exe", browser_download_url: "https://x/win", size: 6_000_000 },
      { name: "ai-notetaker_0.2.0_amd64.deb", browser_download_url: "https://x/deb", size: 7_000_000 },
      { name: "ai-notetaker-extension-v0.2.0.zip", browser_download_url: "https://x/ext", size: 300_000 },
      { name: "manifest.json", browser_download_url: "https://x/m", size: 1 },
    ]);
    expect(picked.mac?.url).toBe("https://x/mac");
    expect(picked.macIntel?.url).toBe("https://x/mac-intel");
    expect(picked.windows?.url).toBe("https://x/win");
    expect(picked.linux?.url).toBe("https://x/deb");
    expect(picked.extension?.url).toBe("https://x/ext");
  });

  it("ignores malformed assets instead of throwing", () => {
    expect(pickAssets([{ name: 7 }, {}, { name: "a.dmg" }] as never)).toEqual({ extension: undefined, mac: undefined, macIntel: undefined, windows: undefined, linux: undefined });
  });

  it("accepts only a Chrome Web Store https URL", () => {
    expect(chromeWebStoreUrl({ CHROME_WEB_STORE_URL: "https://chromewebstore.google.com/detail/x/abc" })).toContain("chromewebstore.google.com");
    expect(chromeWebStoreUrl({ CHROME_WEB_STORE_URL: "http://chromewebstore.google.com/detail/x" })).toBeNull();
    expect(chromeWebStoreUrl({ CHROME_WEB_STORE_URL: "https://evil.example/detail/x" })).toBeNull();
    expect(chromeWebStoreUrl({ CHROME_WEB_STORE_URL: "not a url" })).toBeNull();
    expect(chromeWebStoreUrl({})).toBeNull();
  });

  it("formats sizes for people", () => {
    expect(formatBytes(0)).toBe("");
    expect(formatBytes(200 * 1024)).toBe("200 KB");
    expect(formatBytes(45 * 1024 * 1024)).toBe("45.0 MB");
    expect(formatBytes(250 * 1024 * 1024)).toBe("250 MB");
  });
});

describe("structured data", () => {
  it("keeps a </script> in any string from closing the script element", () => {
    const out = serializeJsonLd({ text: "</script><script>alert(1)</script>" });
    expect(out).not.toContain("</script>");
    expect(JSON.parse(out).text).toBe("</script><script>alert(1)</script>");
  });

  it("describes the same three offers the pricing page shows", () => {
    const software = softwareNode(ORIGIN) as { offers: { price: string; name: string }[] };
    expect(software.offers.map((offer) => [offer.name, offer.price])).toEqual([
      ["Free", "0.00"],
      ["Pro", FALLBACK_PRICE_AMOUNTS.hosted_pro.toFixed(2)],
      ["Team", FALLBACK_PRICE_AMOUNTS.hosted_team.toFixed(2)],
    ]);
  });

  it("publishes every FAQ entry as a Question with its answer", () => {
    const faq = faqNode(ORIGIN) as { mainEntity: { name: string; acceptedAnswer: { text: string } }[] };
    expect(faq.mainEntity).toHaveLength(FAQS.length);
    expect(faq.mainEntity[0]).toMatchObject({ name: FAQS[0].question, acceptedAnswer: { text: FAQS[0].answer } });
  });

  it("limits FAQPage markup to the topic the page actually shows", () => {
    const faq = faqNode(ORIGIN, "setup") as { mainEntity: { name: string }[] };
    expect(faq.mainEntity.map((q) => q.name)).toEqual(FAQS.filter((f) => f.topics?.includes("setup")).map((f) => f.question));
    expect(faq.mainEntity.length).toBeLessThan(FAQS.length);
  });

  it("builds absolute breadcrumb and HowTo URLs", () => {
    const crumbs = breadcrumbNode(ORIGIN, [{ name: "Home", path: "/" }, { name: "Pricing", path: "/pricing" }]) as { itemListElement: { position: number; item: string }[] };
    expect(crumbs.itemListElement.map((entry) => [entry.position, entry.item])).toEqual([[1, `${ORIGIN}/`], [2, `${ORIGIN}/pricing`]]);
    expect((howToNode(ORIGIN) as { url: string }).url).toBe(`${ORIGIN}/how-it-works`);
  });
});

describe("facts stay consistent", () => {
  it("keeps the FAQ price-independent and sells sync, not hosted AI", () => {
    const cost = FAQS.find((faq) => faq.question.startsWith("How much"))?.answer ?? "";
    expect(cost).toContain("current prices");
    expect(cost).not.toContain(FALLBACK_PRICE_LABELS.hosted_pro);
    expect(cost).not.toContain(FALLBACK_PRICE_LABELS.hosted_team);
    expect(cost).not.toMatch(/trial|meetings or|Hosted AI/i);
  });

  it("keeps the fallback labels and numeric amounts in step", () => {
    expect(FALLBACK_PRICE_LABELS.hosted_pro).toBe(`$${FALLBACK_PRICE_AMOUNTS.hosted_pro} / month`);
    expect(FALLBACK_PRICE_LABELS.hosted_team).toBe(`$${FALLBACK_PRICE_AMOUNTS.hosted_team} / month`);
  });
});

describe("crawler surfaces", () => {
  it("publishes an allow-list robots policy on the managed deployment and blocks private paths", () => {
    const policy = robots();
    const rules = Array.isArray(policy.rules) ? policy.rules : [policy.rules];
    expect(policy.sitemap).toBe(`${ORIGIN}/sitemap.xml`);
    for (const rule of rules) {
      expect(rule.allow).toBe("/");
      expect(rule.disallow).toEqual(expect.arrayContaining(["/api/", "/meetings", "/billing", "/share/"]));
    }
    const named = rules.flatMap((rule) => (Array.isArray(rule.userAgent) ? rule.userAgent : [rule.userAgent]));
    expect(named).toEqual(expect.arrayContaining(["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended", "*"]));
  });

  it("closes a self-hosted instance to every crawler", () => {
    delete process.env.MANAGED_HOSTING;
    expect(robots()).toEqual({ rules: [{ userAgent: "*", disallow: "/" }] });
    expect(sitemap()).toEqual([]);
  });

  it("lists every marketing page, absolute, and nothing private, in the sitemap", () => {
    const urls = sitemap().map((entry) => entry.url);
    expect(urls).toEqual(MARKETING_PATHS.map((path) => new URL(path, ORIGIN).toString()));
    expect(urls.join(" ")).not.toMatch(/meetings|billing|login|share/);
  });

  it("serves llms.txt from the shared facts on the managed deployment only", async () => {
    const response = llms();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    const body = await response.text();
    expect(body).toContain("# AI Notetaker");
    expect(body).toContain("See the pricing page for current prices");
    expect(body).not.toContain(FALLBACK_PRICE_LABELS.hosted_pro);
    expect(body).toContain(`${ORIGIN}/pricing`);
    expect(body).toContain(FAQS[0].question);
    delete process.env.MANAGED_HOSTING;
    expect(llms().status).toBe(404);
  });
});

describe("support email", () => {
  it("shows only a valid address the operator configured", () => {
    expect(supportEmail({})).toBeNull();
    expect(supportEmail({ SUPPORT_EMAIL: "  help@apercallc.com " })).toBe("help@apercallc.com");
    for (const bad of ["", "not an email", "a@b", "x@y.z", "a b@c.com", "<script>@x.com", "\"quoted\"@x.com", `${"a".repeat(250)}@x.com`]) {
      expect(supportEmail({ SUPPORT_EMAIL: bad }), bad).toBeNull();
    }
  });
});

describe("governing law setting", () => {
  it("is omitted unless the operator supplies a sensible jurisdiction", () => {
    expect(governingLaw({})).toBeNull();
    expect(governingLaw({ GOVERNING_LAW: "  the State of Texas " })).toBe("the State of Texas");
    for (const bad of ["<script>", "x".repeat(200), "Texas; DROP", ""]) expect(governingLaw({ GOVERNING_LAW: bad }), bad).toBeNull();
  });
});
