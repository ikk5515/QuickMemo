import { describe, expect, it } from "vitest";
import type { ObsidianVaultManifest } from "./types";
import { planObsidianVaultImport, VaultImportPlanError } from "./importPlan";

function manifest(overrides: Partial<ObsidianVaultManifest> = {}): ObsidianVaultManifest {
  return {
    entries: [],
    folders: [],
    skipped: [],
    totalBytes: 0,
    warnings: [],
    ...overrides
  };
}

function textEntry(path: string, kind: "markdown" | "canvas" | "base", text = "") {
  return {
    path,
    kind,
    bytes: new TextEncoder().encode(text),
    text,
    mimeType: kind === "canvas" ? "application/json" : "text/markdown"
  } as const;
}

describe("planObsidianVaultImport", () => {
  it("reuses existing folders and renames file collisions before writing", () => {
    const plan = planObsidianVaultImport(manifest({
      folders: ["Work"],
      entries: [textEntry("Work/Note.md", "markdown", "# Note")]
    }), [{ id: "folder-a", path: "Work" }], ["Work/Note.md"]);

    expect(plan.folders).toEqual([expect.objectContaining({ existingFolderId: "folder-a", path: "Work" })]);
    expect(plan.entries[0]).toMatchObject({
      destinationPath: "Work/Note 2.md",
      folderPath: "Work",
      title: "Note 2"
    });
    expect(plan.renamedEntries).toBe(1);
  });

  it("plans Markdown, Canvas and Base while explicitly counting skipped assets", () => {
    const plan = planObsidianVaultImport(manifest({
      entries: [
        textEntry("A.md", "markdown"),
        textEntry("Board.canvas", "canvas", '{"nodes":[],"edges":[]}'),
        textEntry("Index.base", "base", "views: []"),
        { path: "image.png", kind: "asset", bytes: new Uint8Array([1]), mimeType: "image/png" }
      ]
    }), [], []);

    expect(plan.entries.map((entry) => entry.kind)).toEqual(["markdown", "canvas", "base"]);
    expect(plan.skippedAssets).toBe(1);
  });

  it("fails before writes for oversize text, invalid folder names and file-folder conflicts", () => {
    expect(() => planObsidianVaultImport(manifest({
      entries: [textEntry("Huge.md", "markdown", "a".repeat(500_001))]
    }), [], [])).toThrow(VaultImportPlanError);
    expect(() => planObsidianVaultImport(manifest({ folders: ["a".repeat(121)] }), [], []))
      .toThrow("1~120자");
    expect(() => planObsidianVaultImport(manifest({ folders: ["Work"] }), [], ["Work"]))
      .toThrow("경로가 충돌");
  });
});
