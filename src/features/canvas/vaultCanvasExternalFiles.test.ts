import { describe, expect, it, vi } from "vitest";
import { MAX_INLINE_VAULT_ASSET_BYTES } from "../vault/vaultAsset";
import { importVaultCanvasExternalFiles } from "./vaultCanvasExternalFiles";

function testFile(name: string, size: number, type = "image/png") {
  const source = new Uint8Array(size).fill(7);
  const file = new File([source], name, { type });
  Object.defineProperty(file, "arrayBuffer", {
    configurable: true,
    value: async () => source.slice().buffer
  });
  return file;
}

describe("importVaultCanvasExternalFiles", () => {
  it("reserves unique names, rejects oversized files, and zeroes copied bytes", async () => {
    const copiedBytes: Uint8Array[] = [];
    const titles: string[] = [];
    const result = await importVaultCanvasExternalFiles({
      assertCurrent: () => undefined,
      createAsset: async ({ bytes, title }) => {
        copiedBytes.push(bytes);
        titles.push(title);
      },
      existingTitles: ["그림.png"],
      files: [
        testFile("그림.png", 4),
        testFile("그림.png", 5),
        testFile("too-large.png", MAX_INLINE_VAULT_ASSET_BYTES + 1)
      ],
      folderPath: "첨부"
    });

    expect(titles).toEqual(["그림.png 2", "그림.png 3"]);
    expect(result).toEqual({
      paths: ["첨부/그림.png 2", "첨부/그림.png 3"],
      rejected: 1
    });
    expect(copiedBytes.every((bytes) => bytes.every((value) => value === 0))).toBe(true);
  });

  it("aborts instead of continuing after the Vault access scope changes", async () => {
    const createAsset = vi.fn(async () => undefined);
    await expect(importVaultCanvasExternalFiles({
      assertCurrent: () => {
        throw new DOMException("scope changed", "AbortError");
      },
      createAsset,
      existingTitles: [],
      files: [testFile("그림.png", 4)],
      folderPath: ""
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(createAsset).not.toHaveBeenCalled();
  });
});
