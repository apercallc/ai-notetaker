import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { PrivacyView } from "./Views";

it("describes desktop storage as primary and extension storage as legacy", () => {
  const html = renderToStaticMarkup(<PrivacyView />);

  expect(html).toContain("The desktop app keeps new local recordings and notes in a private data");
  expect(html).toContain("operating-system credential store");
  expect(html).toContain("finished desktop note text syncs to your workspace and workspace notes are copied into the desktop library");
  expect(html).toContain("Web edits refresh workspace copies on sync");
  expect(html).toContain("desktop-origin notes are protected from automatic overwrites");
  expect(html).toContain("Deletions and settings do not sync back");
  expect(html).toContain("Existing extension users keep their local notes in the browser profile");
  expect(html).not.toContain("In local mode, notes are stored in the extension on your device");
});
