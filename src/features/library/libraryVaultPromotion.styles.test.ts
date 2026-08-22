import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(
  join(process.cwd(), "src/features/library/libraryVaultPromotion.css"),
  "utf8"
);

describe("Library Vault promotion responsive styles", () => {
  it("keeps both actions usable at phone widths", () => {
    expect(stylesheet).toMatch(/@media\s*\(max-width:\s*640px\)/u);
    expect(stylesheet).toMatch(
      /\.library-vault-promotion-button,\s*\.library-vault-open-button\s*\{[^}]*min-height:\s*44px;[^}]*white-space:\s*normal;[^}]*width:\s*100%;/su
    );
  });

  it("allows the action row and status text to wrap without horizontal overflow", () => {
    expect(stylesheet).toMatch(/\.library-vault-promotion\s*\{[^}]*flex-wrap:\s*wrap;[^}]*max-width:\s*100%;/su);
    expect(stylesheet).toMatch(/\.library-vault-promotion-status\s*\{[^}]*flex-basis:\s*100%;/su);
  });
});
