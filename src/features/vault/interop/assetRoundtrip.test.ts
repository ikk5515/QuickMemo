import { describe, expect, it } from "vitest";
import { decodeVaultAsset, encodeVaultAsset } from "../vaultAsset";
import { planObsidianVaultImport } from "./importPlan";
import { exportObsidianVaultZip, readObsidianVaultZip } from "./zip";

describe("Obsidian asset encrypted round-trip boundary", () => {
  it("preserves path, MIME type and exact bytes through ZIP, import planning and asset-v1", () => {
    const originalBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
    const firstZip = exportObsidianVaultZip([{
      path: "자료/설계.pdf",
      kind: "asset",
      content: originalBytes,
      mimeType: "application/pdf"
    }]);
    const imported = readObsidianVaultZip(firstZip.bytes);
    const plan = planObsidianVaultImport(imported, [], []);
    const entry = plan.entries[0];

    expect(entry).toMatchObject({
      destinationPath: "자료/설계.pdf",
      kind: "asset",
      mimeType: "application/pdf",
      title: "설계.pdf"
    });
    if (entry.kind !== "asset") {
      throw new Error("Expected asset import entry");
    }

    // This string is what is encrypted by the existing per-entry AES-GCM key.
    const encryptedEnvelopeSource = encodeVaultAsset(entry.bytes, entry.mimeType);
    const decrypted = decodeVaultAsset(encryptedEnvelopeSource);
    const exportedAgain = exportObsidianVaultZip([{
      path: entry.destinationPath,
      kind: "asset",
      content: decrypted.bytes,
      mimeType: decrypted.mimeType
    }]);
    const finalEntry = readObsidianVaultZip(exportedAgain.bytes).entries[0];

    expect(finalEntry.path).toBe("자료/설계.pdf");
    expect(finalEntry.mimeType).toBe("application/pdf");
    expect([...finalEntry.bytes]).toEqual([...originalBytes]);
  });
});
