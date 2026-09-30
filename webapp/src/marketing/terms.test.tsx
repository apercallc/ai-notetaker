import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { TermsView } from "./Views";

const saved = process.env.GOVERNING_LAW;
afterEach(() => {
  if (saved === undefined) delete process.env.GOVERNING_LAW;
  else process.env.GOVERNING_LAW = saved;
});

describe("terms of use", () => {
  it("states refund, export/deletion and liability terms, and omits governing law until configured", () => {
    delete process.env.GOVERNING_LAW;
    const html = renderToStaticMarkup(<TermsView />);
    expect(html).toContain("not refunded");
    expect(html).toContain("14 days");
    expect(html).toContain("Your data, export and deletion");
    expect(html).toContain("12 months");
    expect(html).not.toContain("Governing law");
  });

  it("adds the governing-law clause when the operator sets a jurisdiction", () => {
    process.env.GOVERNING_LAW = "the State of Texas";
    const html = renderToStaticMarkup(<TermsView />);
    expect(html).toContain("Governing law");
    expect(html).toContain("the State of Texas");
  });
});
