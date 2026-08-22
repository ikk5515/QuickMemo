import { describe, expect, it } from "vitest";
import type { ObsidianVaultManifest } from "./types";
import { planObsidianVaultImport, VaultImportPlanError } from "./importPlan";
import { MAX_VAULT_FOLDER_DEPTH } from "../vaultIntegrity";

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

  it("plans Markdown, Canvas, Base and binary assets for encrypted writes", () => {
    const plan = planObsidianVaultImport(manifest({
      entries: [
        textEntry("A.md", "markdown"),
        textEntry("Board.canvas", "canvas", '{"nodes":[],"edges":[]}'),
        textEntry("Index.base", "base", "views: []"),
        { path: "image.png", kind: "asset", bytes: new Uint8Array([1]), mimeType: "image/png" }
      ]
    }), [], []);

    expect(plan.entries.map((entry) => entry.kind)).toEqual(["markdown", "canvas", "base", "asset"]);
    expect(plan.assetEntries).toBe(1);
    expect(plan.entries[3]).toMatchObject({
      kind: "asset",
      mimeType: "image/png",
      title: "image.png"
    });
    expect([...(plan.entries[3] as Extract<(typeof plan.entries)[number], { kind: "asset" }>).bytes]).toEqual([1]);
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

  it("uses the persistence UTF-8 byte limit for every planned text payload", () => {
    const first = textEntry("First.md", "markdown", "safe");
    const multibyteBody = "한".repeat(166_667);
    expect(multibyteBody.length).toBeLessThan(500_000);
    expect(new TextEncoder().encode(multibyteBody).byteLength).toBeGreaterThan(500_000);

    expect(() => planObsidianVaultImport(manifest({
      entries: [first, textEntry("Later.md", "markdown", multibyteBody)]
    }), [], [])).toThrow("UTF-8 기준 500KB");
  });

  it("rejects an asset that cannot fit the encrypted Firestore envelope", () => {
    expect(() => planObsidianVaultImport(manifest({
      entries: [{
        path: "large.bin",
        kind: "asset",
        bytes: new Uint8Array(350 * 1024 + 1),
        mimeType: "application/octet-stream"
      }]
    }), [], [])).toThrow("350KB 이하");
  });

  it("audits the complete proposed folder tree against the server-verifiable depth", () => {
    const segments = Array.from({ length: MAX_VAULT_FOLDER_DEPTH + 2 }, (_, index) => `f${index}`);
    const folders = segments.map((_, index) => segments.slice(0, index + 1).join("/"));

    expect(() => planObsidianVaultImport(manifest({ folders: folders.slice(0, -1) }), [], []))
      .not.toThrow();
    expect(() => planObsidianVaultImport(manifest({ folders }), [], []))
      .toThrow(VaultImportPlanError);
  });
});
