import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dialogStyles = readFileSync(
  join(process.cwd(), "src/features/vault/VaultNoteAttachmentsDialog.css"),
  "utf8"
);
const vaultStyles = readFileSync(join(process.cwd(), "src/styles/vault.css"), "utf8");

function firstRuleBody(styles: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return styles.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "u"))?.[1] ?? "";
}

describe("Vault note attachment theme and layout", () => {
  it("maps body-portal colors to global semantic light and dark tokens", () => {
    const backdrop = firstRuleBody(dialogStyles, ".vault-attachments-backdrop");

    expect(backdrop).toContain("--vault-panel: var(--color-modal-bg)");
    expect(backdrop).toContain("--vault-border: var(--color-border-subtle)");
    expect(backdrop).toContain("--vault-text: var(--color-text-primary)");
    expect(backdrop).toContain("--vault-text-muted: var(--color-text-muted)");
    expect(firstRuleBody(dialogStyles, ".vault-attachments-feedback.error"))
      .toContain("var(--color-danger");
  });

  it("keeps the metadata shelf fixed while every Markdown mode gets the remaining height", () => {
    expect(firstRuleBody(vaultStyles, ".vault-note-content.has-note-attachments"))
      .toMatch(/display:\s*grid;[\s\S]*grid-template-rows:\s*auto minmax\(0, 1fr\);/u);
    expect(firstRuleBody(vaultStyles, ".vault-note-content.has-note-attachments > :not(.vault-note-attachments-inline)"))
      .toContain("min-height: 0");
    expect(firstRuleBody(vaultStyles, ".vault-note-content.has-note-attachments > .vault-markdown-renderer"))
      .toContain("overflow: auto");
    expect(firstRuleBody(vaultStyles, ".vault-note-attachments-inline-list"))
      .toContain("overflow: hidden");
  });
});
