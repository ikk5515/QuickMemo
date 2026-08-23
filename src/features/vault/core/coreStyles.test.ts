import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(join(process.cwd(), "src/features/vault/core/core.css"), "utf8");

describe("Vault Core module styles", () => {
  it("uses neutral Vault surfaces instead of a full-screen accent backdrop", () => {
    expect(styles).toMatch(/\.vault-core-panel,[\s\S]*?background:\s*var\(--vault-surface/u);
    expect(styles).not.toMatch(/background:\s*(?:#(?:0f|1f|2f|3f)[0-9a-f]{4}|(?:green|lime|teal));/iu);
  });

  it("keeps touch controls at 44px and supports reduced motion", () => {
    const coarse = styles.slice(styles.indexOf("@media (pointer: coarse)"));
    expect(coarse).toMatch(/min-height:\s*44px;/u);
    expect(coarse).toMatch(/min-width:\s*44px;/u);
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("prevents Web viewer and slide content from overflowing narrow panes", () => {
    expect(styles).toMatch(/\.vault-web-viewer iframe,[\s\S]*?width:\s*100%;/u);
    expect(styles).toMatch(/@media \(max-width: 760px\)[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) auto auto;/u);
    expect(styles).toMatch(/\.vault-slides__stage[\s\S]*?overflow:\s*auto;/u);
  });
});
