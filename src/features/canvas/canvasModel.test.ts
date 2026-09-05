import { describe, expect, it } from "vitest";
import { parseCanvasDocument, safeVaultPath } from "./canvasModel";

function parseDocument(source: string) { return parseCanvasDocument(source).document; }

const richCanvasSource = JSON.stringify({
  appExtension: { keep: true },
  nodes: [
    { id: "text", type: "text", x: 0, y: 10, width: 220, height: 120, text: "hello", color: "1", custom: "kept" },
    { id: "file", type: "file", x: 300, y: 40, width: 260, height: 160, file: "Folder/Note.md", subpath: "#Heading" },
    { id: "link", type: "link", x: 600, y: 40, width: 260, height: 160, url: "https://example.com" },
    { id: "group", type: "group", x: -30, y: -30, width: 940, height: 300, label: "Research", background: "image.png", backgroundStyle: "cover" }
  ],
  edges: [
    {
      id: "edge",
      fromNode: "text",
      fromSide: "right",
      fromEnd: "none",
      toNode: "file",
      toSide: "left",
      toEnd: "arrow",
      label: "supports",
      custom: 42
    }
  ]
});

describe("JSON Canvas safe model", () => {
  it("uses JSON Canvas nodes and edges as the canonical source", () => {
    expect(parseCanvasDocument('{"nodes":[],"edges":[]}').document).toEqual({ nodes: [], edges: [] });
  });

  it("rejects malformed documents without executing embedded values", () => {
    expect(parseDocument('{"nodes":"bad","edges":[]}')).toEqual({ nodes: [], edges: [] });
    expect(parseDocument("<script>alert(1)</script>")).toEqual({ nodes: [], edges: [] });
  });

  it("accepts optional top-level nodes and edges from JSON Canvas 1.0", () => {
    expect(parseDocument('{"nodes":[]}')).toEqual({ nodes: [], edges: [] });
    expect(parseDocument('{"edges":[]}')).toEqual({ nodes: [], edges: [] });
    expect(parseDocument('{"extension":{"version":1}}')).toEqual({
      extension: { version: 1 },
      nodes: [],
      edges: []
    });
  });

  it("marks lossy or invalid parses read-only instead of silently authorizing a rewrite", () => {
    const malformed = parseCanvasDocument('{"nodes":"bad","edges":[]}');
    expect(malformed.editable).toBe(false);
    expect(malformed.warnings).not.toHaveLength(0);

    const partiallyInvalid = parseCanvasDocument(JSON.stringify({
      nodes: [
        { id: "valid", type: "text", x: 0, y: 0, width: 100, height: 100, text: "keep" },
        { id: "invalid", type: "text", x: 0, y: 0, width: -1, height: 100, text: "do not overwrite source" }
      ],
      edges: []
    }));
    expect(partiallyInvalid.document.nodes).toHaveLength(1);
    expect(partiallyInvalid.editable).toBe(false);
  });

  it("does not authorize rewriting a canvas that exceeds the safe edit limit", () => {
    const tooLarge = parseCanvasDocument(JSON.stringify({
      nodes: [],
      edges: [],
      extensionPayload: "x".repeat(5 * 1024 * 1024)
    }));
    expect(tooLarge.editable).toBe(false);
    expect(tooLarge.document).toEqual({ nodes: [], edges: [] });
    expect(tooLarge.warnings.join(" ")).toContain("원본은 변경하지 않습니다");
  });

  it("preserves JSON Canvas 1.0 fields and extension data", () => {
    const parsed = parseDocument(richCanvasSource);
    expect(parsed.appExtension).toEqual({ keep: true });
    expect(parsed.nodes[0]).toMatchObject({ color: "1", custom: "kept", text: "hello" });
    expect(parsed.nodes[1]).toMatchObject({ file: "Folder/Note.md", subpath: "#Heading" });
    expect(parsed.nodes[3]).toMatchObject({ background: "image.png", backgroundStyle: "cover", label: "Research" });
    expect(parsed.edges[0]).toMatchObject({ custom: 42, fromSide: "right", label: "supports", toEnd: "arrow", toSide: "left" });
  });

  it("drops duplicate, invalid, and dangling records while preserving valid cards", () => {
    const parsed = parseDocument(JSON.stringify({
      nodes: [
        { id: "a", type: "text", x: 0, y: 0, width: 100, height: 100, text: "first" },
        { id: "a", type: "text", x: 2, y: 2, width: 100, height: 100, text: "duplicate" },
        { id: "bad-size", type: "text", x: 0, y: 0, width: -1, height: 100, text: "bad" },
        { id: "bad-type", type: "video", x: 0, y: 0, width: 100, height: 100 }
      ],
      edges: [
        { id: "dangling", fromNode: "a", toNode: "missing" },
        { id: "self", fromNode: "a", toNode: "a", toEnd: "arrow" },
        { id: "self", fromNode: "a", toNode: "a" }
      ]
    }));
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.nodes[0].text).toBe("first");
    expect(parsed.edges).toHaveLength(1);
    expect(parsed.edges[0].id).toBe("self");
  });

  it("opens only canonical vault-relative file paths", () => {
    expect(safeVaultPath("Folder/노트.md")).toBe("Folder/노트.md");
    expect(safeVaultPath("../secret.md")).toBeNull();
    expect(safeVaultPath("Folder/../secret.md")).toBeNull();
    expect(safeVaultPath("/absolute.md")).toBeNull();
    expect(safeVaultPath("https://example.com/note.md")).toBeNull();
    expect(safeVaultPath("C:\\notes\\secret.md")).toBeNull();
  });

});
