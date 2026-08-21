import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const vaultPageSource = readFileSync(join(process.cwd(), "src/pages/VaultPage.tsx"), "utf8");

describe("VaultPage security boundaries", () => {
  it("routes asset embeds through the signature-checked Blob preview instead of rendering asset JSON", () => {
    const embedRenderer = vaultPageSource.match(
      /function renderMarkdownEmbed[\s\S]*?async function copyCurrent/u
    )?.[0] ?? "";
    const assetBranch = embedRenderer.match(
      /if \(target\.entryKind === "asset"\)[\s\S]*?const targetBody/u
    )?.[0] ?? "";

    expect(assetBranch).toContain("decodedAssetsByEntryId.get(target.id)");
    expect(assetBranch).toContain("<VaultAssetPreview");
    expect(assetBranch).not.toContain("previewTextFromHtml");
    expect(assetBranch).not.toContain("target.body");
  });
});
