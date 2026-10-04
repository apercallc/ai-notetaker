import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { PrivacyView } from "./Views";

it("describes desktop storage as primary and extension storage as legacy", () => {
  const html = renderToStaticMarkup(<PrivacyView />);

  expect(html).toContain("The desktop app keeps new local recordings and notes in a private data");
  expect(html).toContain("operating-system credential store");
  expect(html).toContain("only finished desktop note text syncs there");
  expect(html).toContain("Existing extension users keep their local notes in the browser profile");
  expect(html).not.toContain("In local mode, notes are stored in the extension on your device");
});
