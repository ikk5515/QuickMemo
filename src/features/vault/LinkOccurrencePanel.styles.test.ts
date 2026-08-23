import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(join(process.cwd(), "src/features/vault/linkOccurrencePanel.css"), "utf8");

describe("LinkOccurrencePanel responsive styles", () => {
  it("keeps interactive controls at least 44px on mobile and coarse pointers", () => {
    const touchStyles = styles.slice(styles.indexOf("@media (max-width: 1024px), (pointer: coarse) {"));

    expect(touchStyles).toMatch(/\.vault-link-panel-toolbar input,[\s\S]*?\.vault-link-occurrences button \{[\s\S]*?min-height: 44px;/u);
    expect(touchStyles).toMatch(/\.vault-link-panel-toolbar button,[\s\S]*?\.vault-link-group-open \{[\s\S]*?width: 44px;/u);
  });

  it("reflows the toolbar at 390px and limits offscreen group layout work", () => {
    expect(styles).toMatch(/\.vault-link-group \{[\s\S]*?content-visibility: auto;/u);
    expect(styles).toMatch(/@media \(max-width: 390px\) \{[\s\S]*?\.vault-link-panel-toolbar \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) 44px;/u);
    expect(styles).toMatch(/@media \(max-width: 390px\) \{[\s\S]*?\.vault-link-panel-toolbar select \{[\s\S]*?grid-column: 1 \/ -1;/u);
  });
});
