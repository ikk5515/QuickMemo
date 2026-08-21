import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { exportObsidianVaultZip, readObsidianVaultZip } from "./zip";

function canvasSource() {
  return JSON.stringify({
    nodes: [{ id: "n", type: "text", text: "Hello", x: 0, y: 0, width: 200, height: 100 }],
    edges: []
  });
}

describe("Obsidian ZIP interoperability", () => {
  it("round-trips Markdown, Canvas, Base, assets, Unicode paths, and empty folders", () => {
    const exported = exportObsidianVaultZip([
      { path: "노트/시작.md", content: "# 시작\n\n[[다음]]" },
      { path: "Boards/Main.canvas", content: canvasSource() },
      { path: "Views/Tasks.base", content: "views:\n  - type: table\n" },
      { path: "첨부/image.png", content: new Uint8Array([137, 80, 78, 71]) }
    ], { folders: ["빈 폴더"] });

    const imported = readObsidianVaultZip(exported.bytes);
    expect(imported.entries.map(({ path, kind }) => ({ path, kind }))).toEqual([
      { path: "Boards/Main.canvas", kind: "canvas" },
      { path: "Views/Tasks.base", kind: "base" },
      { path: "노트/시작.md", kind: "markdown" },
      { path: "첨부/image.png", kind: "asset" }
    ]);
    expect(imported.folders).toContain("빈 폴더");
    expect(imported.entries.find((entry) => entry.path === "노트/시작.md")?.text).toContain("[[다음]]");
    expect([...imported.entries.find((entry) => entry.kind === "asset")!.bytes]).toEqual([137, 80, 78, 71]);
  });

  it("creates deterministic archives for stable downloads and tests", () => {
    const first = exportObsidianVaultZip([{ path: "Note.md", content: "same" }]).bytes;
    const second = exportObsidianVaultZip([{ path: "Note.md", content: "same" }]).bytes;
    expect(first).toEqual(second);
  });

  it("rejects traversal and absolute archive paths before inflation", () => {
    const traversal = zipSync({ "../outside.md": new TextEncoder().encode("no") });
    expect(() => readObsidianVaultZip(traversal)).toThrowError(
      expect.objectContaining({ code: "invalid-path" })
    );

    const absolute = zipSync({ "/outside.md": new TextEncoder().encode("no") });
    expect(() => readObsidianVaultZip(absolute)).toThrowError(
      expect.objectContaining({ code: "invalid-path" })
    );
  });

  it("rejects suspicious compression ratios before allocating inflated content", () => {
    const archive = zipSync({ "large.bin": new Uint8Array(100_000) }, { level: 9 });
    expect(() => readObsidianVaultZip(archive, {
      limits: { maxCompressionRatio: 2, minRatioCheckBytes: 1 }
    })).toThrowError(expect.objectContaining({ code: "entry-too-large" }));
  });

  it("bounds archive bytes, entry count, and total inflated bytes", () => {
    const archive = zipSync({
      "a.bin": new Uint8Array([1, 2, 3, 4]),
      "b.bin": new Uint8Array([5, 6, 7, 8])
    }, { level: 0 });

    expect(() => readObsidianVaultZip(archive, { limits: { maxArchiveBytes: 10 } })).toThrowError(
      expect.objectContaining({ code: "archive-too-large" })
    );
    expect(() => readObsidianVaultZip(archive, { limits: { maxEntries: 1 } })).toThrowError(
      expect.objectContaining({ code: "too-many-entries" })
    );
    expect(() => readObsidianVaultZip(archive, {
      limits: { maxEntryBytes: 4, maxTextEntryBytes: 4, maxTotalBytes: 7 }
    })).toThrowError(expect.objectContaining({ code: "total-size-exceeded" }));
  });

  it("applies duplicate policy to case-insensitive archive collisions", () => {
    const archive = zipSync({
      "Note.md": new TextEncoder().encode("one"),
      "note.md": new TextEncoder().encode("two")
    });
    expect(() => readObsidianVaultZip(archive)).toThrowError(
      expect.objectContaining({ code: "duplicate-path" })
    );
    const imported = readObsidianVaultZip(archive, { duplicatePolicy: "rename" });
    expect(imported.entries.map((entry) => entry.path)).toEqual(["Note.md", "note 2.md"]);
  });

  it("skips .obsidian and system metadata without inflating them", () => {
    const archive = zipSync({
      ".obsidian/workspace.json": new TextEncoder().encode("{}"),
      "__MACOSX/._Note.md": new Uint8Array([1]),
      ".DS_Store": new Uint8Array([2]),
      "Note.md": new TextEncoder().encode("kept")
    });
    const imported = readObsidianVaultZip(archive);
    expect(imported.entries.map((entry) => entry.path)).toEqual(["Note.md"]);
    expect(imported.skipped).toHaveLength(3);
  });

  it("can remove a single top-level ZIP wrapper", () => {
    const archive = zipSync({
      "My Vault/Notes/A.md": new TextEncoder().encode("A"),
      "My Vault/Assets/a.bin": new Uint8Array([1])
    });
    expect(readObsidianVaultZip(archive, { stripCommonRoot: true }).entries.map((entry) => entry.path)).toEqual([
      "Assets/a.bin",
      "Notes/A.md"
    ]);
  });
});
