import { describe, expect, it } from "vitest";
import { buildObsidianExportManifest, validateObsidianImportManifest } from "./manifest";

function validCanvas(file = "Notes/Source.md") {
  return JSON.stringify({
    nodes: [
      { id: "file-1", type: "file", file, x: 0, y: 0, width: 320, height: 240 },
      { id: "text-1", type: "text", text: "[[Source]]", x: 400, y: 0, width: 240, height: 160 }
    ],
    edges: [{ id: "edge-1", fromNode: "file-1", toNode: "text-1" }]
  });
}

describe("Obsidian export manifest", () => {
  it("exports Markdown, Canvas, Base, and assets with paths rather than storage IDs", () => {
    const manifest = buildObsidianExportManifest([
      { path: "Notes/Start.md", kind: "markdown", content: "# Start\n\n[[Other]]" },
      { path: "Boards/Research.canvas", kind: "canvas", content: validCanvas() },
      { path: "Views/Projects.base", kind: "base", content: "filters:\n  and: []\n" },
      { path: "assets/photo.png", kind: "asset", content: new Uint8Array([1, 2, 3]), mimeType: "image/png" }
    ]);

    expect(manifest.entries.map(({ path, kind }) => ({ path, kind }))).toEqual([
      { path: "Boards/Research.canvas", kind: "canvas" },
      { path: "Notes/Start.md", kind: "markdown" },
      { path: "Views/Projects.base", kind: "base" },
      { path: "assets/photo.png", kind: "asset" }
    ]);
    expect(manifest.folders).toEqual(["Boards", "Notes", "Views", "assets"]);
    expect(manifest.entries[0]).not.toHaveProperty("id");
    expect(manifest.entries.find((entry) => entry.kind === "base")?.text).toContain("filters:");
  });

  it("allows the same filename in different folders", () => {
    const manifest = buildObsidianExportManifest([
      { path: "A/Index.md", content: "A" },
      { path: "B/Index.md", content: "B" }
    ]);
    expect(manifest.entries).toHaveLength(2);
  });

  it("handles portable path collisions using an explicit policy", () => {
    const sources = [
      { path: "Note.md", content: "first" },
      { path: "note.md", content: "second" },
      { path: "NOTE.md", content: "third" }
    ];
    expect(() => buildObsidianExportManifest(sources)).toThrowError(
      expect.objectContaining({ code: "duplicate-path" })
    );

    const kept = buildObsidianExportManifest(sources, { duplicatePolicy: "keep-first" });
    expect(kept.entries.map((entry) => entry.path)).toEqual(["Note.md"]);
    expect(kept.skipped).toHaveLength(2);

    const renamed = buildObsidianExportManifest(sources, { duplicatePolicy: "rename" });
    expect(renamed.entries.map((entry) => entry.path)).toEqual(["NOTE 3.md", "Note.md", "note 2.md"]);
    expect(renamed.warnings).toHaveLength(2);
  });

  it("strips an explicit archive wrapper while retaining the vault tree", () => {
    const manifest = validateObsidianImportManifest([
      { path: "My Vault/Notes/Start.md", content: "hello" },
      { path: "My Vault/assets/file.bin", content: new Uint8Array([9]) }
    ], { stripCommonRoot: true });
    expect(manifest.entries.map((entry) => entry.path)).toEqual(["Notes/Start.md", "assets/file.bin"]);
    expect(manifest.folders).toEqual(["Notes", "assets"]);
  });

  it("skips Obsidian settings and operating-system metadata by default", () => {
    const manifest = buildObsidianExportManifest([
      { path: ".obsidian/workspace.json", content: "{}" },
      { path: "__MACOSX/._Note.md", content: "metadata" },
      { path: "Note.md", content: "kept" }
    ]);
    expect(manifest.entries.map((entry) => entry.path)).toEqual(["Note.md"]);
    expect(manifest.skipped.map((entry) => entry.reason).sort()).toEqual([
      "obsidian-config",
      "system-metadata"
    ]);
  });

  it("rejects a file that also needs to be a folder", () => {
    expect(() => buildObsidianExportManifest([
      { path: "Project", content: new Uint8Array([1]) },
      { path: "Project/Note.md", content: "nested" }
    ])).toThrowError(expect.objectContaining({ code: "path-conflict" }));
  });

  it("rejects mismatched declared kinds on export", () => {
    expect(() => buildObsidianExportManifest([
      { path: "Note.md", kind: "asset", content: "not an asset" }
    ])).toThrowError(expect.objectContaining({ code: "invalid-content" }));
  });

  it("requires valid UTF-8 for text-based vault entries", () => {
    expect(() => validateObsidianImportManifest([
      { path: "Note.md", content: new Uint8Array([0xff, 0xfe]) }
    ])).toThrowError(expect.objectContaining({ code: "invalid-content" }));
  });

  it("validates JSON Canvas file paths, edges, and external URL schemes", () => {
    expect(buildObsidianExportManifest([
      { path: "Board.canvas", content: validCanvas() }
    ]).entries[0].kind).toBe("canvas");

    expect(() => buildObsidianExportManifest([
      { path: "Board.canvas", content: validCanvas("../outside.md") }
    ])).toThrowError(expect.objectContaining({ code: "invalid-path" }));

    const unsafeLink = JSON.stringify({
      nodes: [{ id: "link", type: "link", url: "javascript:alert(1)", x: 0, y: 0, width: 100, height: 100 }],
      edges: []
    });
    expect(() => buildObsidianExportManifest([
      { path: "Board.canvas", content: unsafeLink }
    ])).toThrowError(expect.objectContaining({ code: "canvas-invalid" }));

    const missingTarget = JSON.stringify({
      nodes: [{ id: "a", type: "text", text: "A", x: 0, y: 0, width: 100, height: 100 }],
      edges: [{ id: "e", fromNode: "a", toNode: "missing" }]
    });
    expect(() => buildObsidianExportManifest([
      { path: "Board.canvas", content: missingTarget }
    ])).toThrowError(expect.objectContaining({ code: "canvas-invalid" }));
  });

  it("enforces entry, aggregate, and entry-count limits", () => {
    expect(() => buildObsidianExportManifest([
      { path: "large.bin", content: new Uint8Array(6) }
    ], { limits: { maxEntryBytes: 5, maxTextEntryBytes: 5, maxTotalBytes: 5 } })).toThrowError(
      expect.objectContaining({ code: "entry-too-large" })
    );

    expect(() => buildObsidianExportManifest([
      { path: "a.bin", content: new Uint8Array(4) },
      { path: "b.bin", content: new Uint8Array(4) }
    ], { limits: { maxEntryBytes: 5, maxTextEntryBytes: 5, maxTotalBytes: 7 } })).toThrowError(
      expect.objectContaining({ code: "total-size-exceeded" })
    );

    expect(() => buildObsidianExportManifest([
      { path: "a.md", content: "a" },
      { path: "b.md", content: "b" }
    ], { limits: { maxEntries: 1 } })).toThrowError(expect.objectContaining({ code: "too-many-entries" }));
  });
});
