import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CANVAS_NODE_INTERACTION_THRESHOLD_PX,
  JSON_CANVAS_VAULT_ENTRY_MIME,
  JsonCanvasView,
  alignJsonCanvasNodes,
  canvasPdfPageFromSubpath,
  createDroppedJsonCanvasFileNode,
  containedJsonCanvasNodeIds,
  containingJsonCanvasGroupId,
  distributeJsonCanvasNodes,
  duplicateJsonCanvasSelection,
  effectiveJsonCanvasEdgeEnds,
  emptyJsonCanvas,
  expandJsonCanvasGroupSelection,
  jsonCanvasEdgeEndsForDirection,
  jsonCanvasEdgeNavigationNodeId,
  parseJsonCanvasVaultEntryDragPayload,
  parseCanvasDocument,
  reorderJsonCanvasNodes,
  safeCanvasColor,
  safeCanvasDocument,
  safeHttpUrl,
  safeVaultPath,
  serializeJsonCanvasVaultEntryDragPayload,
  setJsonCanvasVaultEntryDragData,
  serializeCanvas,
  translateJsonCanvasNodes
} from "./JsonCanvasView";
import * as canvasModel from "./canvasModel";
import type { CanvasFlowEdge, CanvasFlowNode, JsonCanvasDocument } from "./canvasModel";

const jsonCanvasViewSource = readFileSync(join(process.cwd(), "src/features/canvas/JsonCanvasView.tsx"), "utf8");

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

function previewablePngBytes(width = 800, height = 600) {
  const bytes = new Uint8Array(57);
  const view = new DataView(bytes.buffer);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  view.setUint32(8, 13);
  bytes.set(new TextEncoder().encode("IHDR"), 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  view.setUint32(33, 0);
  bytes.set(new TextEncoder().encode("IDAT"), 37);
  view.setUint32(45, 0);
  bytes.set(new TextEncoder().encode("IEND"), 49);
  return bytes;
}

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class ResizeObserverMock {
    disconnect() {}
    observe() {}
    unobserve() {}
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("JSON Canvas safe model", () => {
  it("uses JSON Canvas nodes and edges as the canonical source", () => {
    expect(safeCanvasDocument(emptyJsonCanvas)).toEqual({ nodes: [], edges: [] });
  });

  it("rejects malformed documents without executing embedded values", () => {
    expect(safeCanvasDocument('{"nodes":"bad","edges":[]}')).toEqual({ nodes: [], edges: [] });
    expect(safeCanvasDocument("<script>alert(1)</script>")).toEqual({ nodes: [], edges: [] });
  });

  it("accepts optional top-level nodes and edges from JSON Canvas 1.0", () => {
    expect(safeCanvasDocument('{"nodes":[]}')).toEqual({ nodes: [], edges: [] });
    expect(safeCanvasDocument('{"edges":[]}')).toEqual({ nodes: [], edges: [] });
    expect(safeCanvasDocument('{"extension":{"version":1}}')).toEqual({
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
    const parsed = safeCanvasDocument(richCanvasSource);
    expect(parsed.appExtension).toEqual({ keep: true });
    expect(parsed.nodes[0]).toMatchObject({ color: "1", custom: "kept", text: "hello" });
    expect(parsed.nodes[1]).toMatchObject({ file: "Folder/Note.md", subpath: "#Heading" });
    expect(parsed.nodes[3]).toMatchObject({ background: "image.png", backgroundStyle: "cover", label: "Research" });
    expect(parsed.edges[0]).toMatchObject({ custom: 42, fromSide: "right", label: "supports", toEnd: "arrow", toSide: "left" });
  });

  it("drops duplicate, invalid, and dangling records while preserving valid cards", () => {
    const parsed = safeCanvasDocument(JSON.stringify({
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

  it("keeps unsafe URL text inert and only resolves http/https", () => {
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("data:text/html,test")).toBeNull();
    expect(safeHttpUrl("/relative/path")).toBeNull();
    expect(safeHttpUrl("https://user:password@example.com/private")).toBeNull();
    expect(safeHttpUrl("https://example.com/path?q=1")).toBe("https://example.com/path?q=1");
    expect(safeCanvasDocument(JSON.stringify({
      nodes: [{ id: "unsafe", type: "link", x: 0, y: 0, width: 100, height: 100, url: "javascript:alert(1)" }],
      edges: []
    })).nodes[0].url).toBe("javascript:alert(1)");
  });

  it("opens only canonical vault-relative file paths", () => {
    expect(safeVaultPath("Folder/노트.md")).toBe("Folder/노트.md");
    expect(safeVaultPath("../secret.md")).toBeNull();
    expect(safeVaultPath("Folder/../secret.md")).toBeNull();
    expect(safeVaultPath("/absolute.md")).toBeNull();
    expect(safeVaultPath("https://example.com/note.md")).toBeNull();
    expect(safeVaultPath("C:\\notes\\secret.md")).toBeNull();
  });

  it("maps only JSON Canvas preset and hex colors to CSS", () => {
    expect(safeCanvasColor("1")).toBe("#ef4444");
    expect(safeCanvasColor("#abc")).toBe("#abc");
    expect(safeCanvasColor("#12345678")).toBe("#12345678");
    expect(safeCanvasColor("#12345")).toBe("#8b82f6");
    expect(safeCanvasColor("url(https://bad.example)")).toBe("#8b82f6");
  });

  it("uses the JSON Canvas default arrow when toEnd is omitted", () => {
    expect(effectiveJsonCanvasEdgeEnds({})).toEqual({ fromEnd: "none", toEnd: "arrow" });
    expect(effectiveJsonCanvasEdgeEnds({ fromEnd: "arrow", toEnd: "none" })).toEqual({ fromEnd: "arrow", toEnd: "none" });
  });

  it("maps every supported edge direction and navigation endpoint without extension fields", () => {
    expect(jsonCanvasEdgeEndsForDirection("none-arrow")).toEqual({ fromEnd: "none", toEnd: "arrow" });
    expect(jsonCanvasEdgeEndsForDirection("arrow-none")).toEqual({ fromEnd: "arrow", toEnd: "none" });
    expect(jsonCanvasEdgeEndsForDirection("arrow-arrow")).toEqual({ fromEnd: "arrow", toEnd: "arrow" });
    expect(jsonCanvasEdgeEndsForDirection("none-none")).toEqual({ fromEnd: "none", toEnd: "none" });
    expect(jsonCanvasEdgeEndsForDirection("script-arrow")).toBeNull();
    expect(jsonCanvasEdgeNavigationNodeId({ fromNode: "source", toNode: "target" }, "source")).toBe("source");
    expect(jsonCanvasEdgeNavigationNodeId({ fromNode: "source", toNode: "target" }, "target")).toBe("target");
  });
});

describe("Vault entry drag contract", () => {
  it("serializes only a bounded opaque entry ID under the explicit Canvas MIME type", () => {
    const payload = serializeJsonCanvasVaultEntryDragPayload("entry_123-abc");
    expect(payload).toBe('{"version":1,"entryId":"entry_123-abc"}');
    expect(JSON_CANVAS_VAULT_ENTRY_MIME).toBe("application/x-quickmemo-vault-entry+json");
    expect(payload).not.toContain("owner");
    expect(payload).not.toContain("path");
    expect(payload).not.toContain("content");
    expect(serializeJsonCanvasVaultEntryDragPayload("https://example.com/note")).toBeNull();
    expect(serializeJsonCanvasVaultEntryDragPayload("entry/with/path")).toBeNull();
  });

  it("rejects payloads that smuggle owner, path, scheme, or plaintext fields", () => {
    expect(parseJsonCanvasVaultEntryDragPayload('{"version":1,"entryId":"entry-1"}')).toEqual({
      version: 1,
      entryId: "entry-1"
    });
    expect(parseJsonCanvasVaultEntryDragPayload(
      '{"version":1,"entryId":"entry-1","ownerId":"owner"}'
    )).toBeNull();
    expect(parseJsonCanvasVaultEntryDragPayload(
      '{"version":1,"entryId":"entry-1","path":"Secret/Note.md"}'
    )).toBeNull();
    expect(parseJsonCanvasVaultEntryDragPayload(
      '{"version":1,"entryId":"entry-1","content":"plaintext secret"}'
    )).toBeNull();
    expect(parseJsonCanvasVaultEntryDragPayload(
      '{"version":1,"entryId":"javascript:alert(1)"}'
    )).toBeNull();
    expect(parseJsonCanvasVaultEntryDragPayload("not-json")).toBeNull();
  });

  it("writes no text/plain fallback or decrypted metadata to DataTransfer", () => {
    const stored = new Map<string, string>();
    const dataTransfer = {
      clearData: vi.fn(() => stored.clear()),
      effectAllowed: "uninitialized",
      setData: vi.fn((type: string, value: string) => stored.set(type, value))
    } as unknown as DataTransfer;

    expect(setJsonCanvasVaultEntryDragData(dataTransfer, "entry-1")).toBe(true);
    expect([...stored.keys()]).toEqual([JSON_CANVAS_VAULT_ENTRY_MIME]);
    expect(stored.has("text/plain")).toBe(false);
    expect(stored.get(JSON_CANVAS_VAULT_ENTRY_MIME)).toBe(
      '{"version":1,"entryId":"entry-1"}'
    );
    expect(dataTransfer.effectAllowed).toBe("copy");
  });

  it("snaps safe drop coordinates and retries generated IDs that collide", () => {
    const generatedIds = ["existing", "existing", "fresh"];
    const node = createDroppedJsonCanvasFileNode({
      createId: () => generatedIds.shift() ?? "never",
      existingNodeIds: new Set(["existing"]),
      path: "Folder/Note.md",
      position: { x: 41, y: 59 },
      snapToGrid: true
    });

    expect(node).toEqual({
      id: "fresh",
      type: "file",
      x: 40,
      y: 60,
      width: 300,
      height: 180,
      file: "Folder/Note.md"
    });
    expect(createDroppedJsonCanvasFileNode({
      createId: () => "existing",
      existingNodeIds: new Set(["existing"]),
      path: "Folder/Note.md",
      position: { x: 1, y: 2 },
      snapToGrid: false
    })).toBeNull();
    expect(createDroppedJsonCanvasFileNode({
      existingNodeIds: new Set(),
      path: "javascript:alert(1)",
      position: { x: 1, y: 2 },
      snapToGrid: false
    })).toBeNull();
    expect(createDroppedJsonCanvasFileNode({
      existingNodeIds: new Set(),
      path: "Folder/Note.md",
      position: { x: Number.POSITIVE_INFINITY, y: 2 },
      snapToGrid: false
    })).toBeNull();
  });
});

describe("JSON Canvas editing operations", () => {
  it("derives group membership from geometry without adding proprietary parent fields", () => {
    const document: JsonCanvasDocument = {
      nodes: [
        { id: "group", type: "group", x: 0, y: 0, width: 500, height: 400, label: "group" },
        { id: "inside", type: "text", x: 20, y: 40, width: 100, height: 80, text: "inside" },
        { id: "nested", type: "group", x: 180, y: 80, width: 200, height: 180, label: "nested" },
        { id: "nested-card", type: "text", x: 210, y: 120, width: 100, height: 80, text: "nested" },
        { id: "overlap", type: "text", x: 450, y: 40, width: 100, height: 80, text: "not fully inside" },
        { id: "outside", type: "text", x: 700, y: 20, width: 100, height: 80, text: "outside" }
      ],
      edges: []
    };

    expect(containedJsonCanvasNodeIds(document, new Set(["group"]))).toEqual(new Set([
      "inside",
      "nested",
      "nested-card"
    ]));
    expect(expandJsonCanvasGroupSelection(document, new Set(["group"]))).toEqual(new Set([
      "group",
      "inside",
      "nested",
      "nested-card"
    ]));
    expect(document.nodes.every((node) => !("parent" in node) && !("parentId" in node))).toBe(true);
  });

  it("translates an expanded group selection without moving overlapping or outside cards", () => {
    const document: JsonCanvasDocument = {
      nodes: [
        { id: "group", type: "group", x: 0, y: 0, width: 400, height: 300, label: "group" },
        { id: "inside", type: "text", x: 20, y: 20, width: 100, height: 80, text: "inside" },
        { id: "overlap", type: "text", x: 350, y: 20, width: 100, height: 80, text: "overlap" }
      ],
      edges: []
    };
    const selected = expandJsonCanvasGroupSelection(document, new Set(["group"]));
    const translated = translateJsonCanvasNodes(document, selected, 40, -20);

    expect(translated.nodes.map(({ id, x, y }) => ({ id, x, y }))).toEqual([
      { id: "group", x: 40, y: -20 },
      { id: "inside", x: 60, y: 0 },
      { id: "overlap", x: 350, y: 20 }
    ]);
    expect(translateJsonCanvasNodes(document, selected, Number.NaN, 2)).toBe(document);
  });

  it("assigns overlapping cards to the smallest then topmost enclosing group deterministically", () => {
    const document: JsonCanvasDocument = {
      nodes: [
        { id: "wide", type: "group", x: 0, y: 0, width: 500, height: 400, label: "wide" },
        { id: "tie-bottom", type: "group", x: 40, y: 40, width: 240, height: 200, label: "bottom" },
        { id: "tie-top", type: "group", x: 40, y: 40, width: 240, height: 200, label: "top" },
        { id: "card", type: "text", x: 80, y: 80, width: 100, height: 80, text: "card" }
      ],
      edges: []
    };
    const card = document.nodes[3];

    expect(containingJsonCanvasGroupId(document, card)).toBe("tie-top");
    expect(containedJsonCanvasNodeIds(document, new Set(["wide"]))).toEqual(new Set([
      "tie-bottom",
      "tie-top",
      "card"
    ]));
    expect(containedJsonCanvasNodeIds(document, new Set(["tie-bottom"]))).toEqual(new Set());
    expect(containedJsonCanvasNodeIds(document, new Set(["tie-top"]))).toEqual(new Set(["card"]));
  });

  it("duplicates selected cards, their extension fields, and internal edges", () => {
    const document = safeCanvasDocument(richCanvasSource);
    let nextNode = 0;
    let nextEdge = 0;
    const duplicated = duplicateJsonCanvasSelection(
      document,
      new Set(["text", "file"]),
      (kind) => kind === "node" ? `copy-${++nextNode}` : `copy-edge-${++nextEdge}`
    );

    expect(duplicated.document.nodes).toHaveLength(6);
    expect(duplicated.document.edges).toHaveLength(2);
    expect(duplicated.newNodeIds).toEqual(new Set(["copy-1", "copy-2"]));
    expect(duplicated.document.nodes[4]).toMatchObject({ custom: "kept", id: "copy-1", x: 32, y: 42 });
    expect(duplicated.document.edges[1]).toMatchObject({ custom: 42, fromNode: "copy-1", id: "copy-edge-1", toNode: "copy-2" });
    expect(duplicated.document.appExtension).toEqual({ keep: true });
  });

  it("does not duplicate an edge whose other endpoint is outside the selection", () => {
    const document = safeCanvasDocument(richCanvasSource);
    const duplicated = duplicateJsonCanvasSelection(document, new Set(["text"]), (kind) => `${kind}-copy`);
    expect(duplicated.document.nodes).toHaveLength(5);
    expect(duplicated.document.edges).toHaveLength(1);
  });

  it("duplicates a selected group with all fully contained cards and their internal edges", () => {
    const document: JsonCanvasDocument = {
      nodes: [
        { id: "group", type: "group", x: 0, y: 0, width: 400, height: 300, label: "group" },
        { id: "inside-a", type: "text", x: 20, y: 20, width: 100, height: 80, text: "a" },
        { id: "inside-b", type: "text", x: 180, y: 20, width: 100, height: 80, text: "b" },
        { id: "outside", type: "text", x: 500, y: 20, width: 100, height: 80, text: "outside" }
      ],
      edges: [
        { id: "inside-edge", fromNode: "inside-a", toNode: "inside-b" },
        { id: "outside-edge", fromNode: "inside-b", toNode: "outside" }
      ]
    };
    let nodeIndex = 0;
    let edgeIndex = 0;
    const result = duplicateJsonCanvasSelection(document, new Set(["group"]), (kind) => (
      kind === "node" ? `copy-${++nodeIndex}` : `copy-edge-${++edgeIndex}`
    ));

    expect(result.document.nodes).toHaveLength(7);
    expect(result.document.edges).toHaveLength(3);
    expect(result.newNodeIds).toEqual(new Set(["copy-1", "copy-2", "copy-3"]));
    expect(result.document.edges.at(-1)).toMatchObject({
      fromNode: "copy-2",
      id: "copy-edge-1",
      toNode: "copy-3"
    });
  });

  it("aligns selected cards by each supported boundary without moving others", () => {
    const document: JsonCanvasDocument = {
      nodes: [
        { id: "a", type: "text", x: 10, y: 20, width: 100, height: 50, text: "a" },
        { id: "b", type: "text", x: 80, y: 100, width: 60, height: 80, text: "b" },
        { id: "c", type: "text", x: 999, y: 999, width: 10, height: 10, text: "c" }
      ],
      edges: []
    };
    const selected = new Set(["a", "b"]);

    expect(alignJsonCanvasNodes(document, selected, "left").nodes.map((node) => node.x)).toEqual([10, 10, 999]);
    expect(alignJsonCanvasNodes(document, selected, "right").nodes.map((node) => node.x)).toEqual([40, 80, 999]);
    expect(alignJsonCanvasNodes(document, selected, "top").nodes.map((node) => node.y)).toEqual([20, 20, 999]);
    expect(alignJsonCanvasNodes(document, selected, "bottom").nodes.map((node) => node.y)).toEqual([130, 100, 999]);
    expect(alignJsonCanvasNodes(document, selected, "center").nodes.map((node) => node.x)).toEqual([25, 45, 999]);
    expect(alignJsonCanvasNodes(document, selected, "middle").nodes.map((node) => node.y)).toEqual([75, 60, 999]);
  });

  it("does not allocate a new document when fewer than two cards can be aligned", () => {
    const document = safeCanvasDocument(richCanvasSource);
    expect(alignJsonCanvasNodes(document, new Set(["text"]), "left")).toBe(document);
  });

  it("distributes three or more selected cards with equal horizontal or vertical gaps", () => {
    const document: JsonCanvasDocument = {
      canvasExtension: "preserved",
      nodes: [
        { id: "a", type: "text", x: 0, y: 0, width: 100, height: 50, text: "a", extension: 1 },
        { id: "b", type: "text", x: 120, y: 90, width: 60, height: 100, text: "b" },
        { id: "c", type: "text", x: 400, y: 350, width: 100, height: 50, text: "c" },
        { id: "outside", type: "text", x: 999, y: 999, width: 20, height: 20, text: "outside" }
      ],
      edges: []
    };
    const selected = new Set(["a", "b", "c"]);

    const horizontal = distributeJsonCanvasNodes(document, selected, "horizontal");
    const vertical = distributeJsonCanvasNodes(document, selected, "vertical");

    expect(horizontal.nodes.map((node) => node.x)).toEqual([0, 220, 400, 999]);
    expect(vertical.nodes.map((node) => node.y)).toEqual([0, 150, 350, 999]);
    expect(horizontal.nodes[0]).toMatchObject({ extension: 1, text: "a" });
    expect(horizontal.canvasExtension).toBe("preserved");
    expect(distributeJsonCanvasNodes(document, new Set(["a", "b"]), "horizontal")).toBe(document);
  });

  it("moves selected cards to the front or back without changing relative order or fields", () => {
    const document = safeCanvasDocument(richCanvasSource);
    const selected = new Set(["file", "group"]);

    const front = reorderJsonCanvasNodes(document, selected, "front");
    const back = reorderJsonCanvasNodes(document, selected, "back");

    expect(front.nodes.map((node) => node.id)).toEqual(["text", "link", "file", "group"]);
    expect(back.nodes.map((node) => node.id)).toEqual(["file", "group", "text", "link"]);
    expect(front.nodes[3]).toBe(document.nodes[3]);
    expect(front.edges).toBe(document.edges);
    expect(front.appExtension).toEqual({ keep: true });
    expect(reorderJsonCanvasNodes(document, new Set(), "front")).toBe(document);
    expect(reorderJsonCanvasNodes(document, new Set(document.nodes.map((node) => node.id)), "back")).toBe(document);
  });

  it("serializes measured position and size while retaining card and edge fields", () => {
    const document = safeCanvasDocument(richCanvasSource);
    const nodes: CanvasFlowNode[] = document.nodes.map((canvas, index) => ({
      data: { canvas },
      id: canvas.id,
      measured: index === 0 ? { width: 333.4, height: 199.6 } : undefined,
      position: { x: canvas.x + 0.49, y: canvas.y + 0.51 },
      style: index === 1 ? { width: 444.4, height: 222.2 } : undefined,
      type: "canvasCard"
    }));
    const edges: CanvasFlowEdge[] = document.edges.map((canvas) => ({
      data: canvas,
      id: canvas.id,
      source: canvas.fromNode,
      target: canvas.toNode
    }));

    const serialized = safeCanvasDocument(serializeCanvas(nodes, edges, document));
    expect(serialized.appExtension).toEqual({ keep: true });
    expect(serialized.nodes[0]).toMatchObject({ custom: "kept", height: 200, width: 333, x: 0, y: 11 });
    expect(serialized.nodes[1]).toMatchObject({ height: 222, subpath: "#Heading", width: 444 });
    expect(serialized.edges[0]).toMatchObject({ custom: 42, fromSide: "right", label: "supports", toEnd: "arrow" });
  });
});

describe("JsonCanvasView controls", () => {
  it("uses primary background drag for panning and keeps Shift-drag selection", () => {
    expect(jsonCanvasViewSource).toContain("panOnDrag={[0, 1]}");
    expect(jsonCanvasViewSource).toContain('const CANVAS_NO_DRAG_CLASS_NAME = "nodrag"');
    expect(jsonCanvasViewSource).toContain('const CANVAS_NO_PAN_CLASS_NAME = "nopan"');
    expect(jsonCanvasViewSource).toContain('selectionKeyCode="Shift"');
    expect(jsonCanvasViewSource).toContain("selectionOnDrag={false}");
  });

  it("keeps node dragging distinct from pane panning and persists the final snapped position", async () => {
    const onChange = vi.fn();
    const serializeSpy = vi.spyOn(canvasModel, "canvasDocumentFromFlow");
    render(createElement(JsonCanvasView, {
      fileOptions: [],
      onChange,
      onOpenFile: vi.fn(),
      source: JSON.stringify({
        nodes: [{ id: "new-card", type: "text", x: 0, y: 0, width: 280, height: 160, text: "새 메모" }],
        edges: []
      })
    }));

    const canvas = screen.getByLabelText("Canvas");
    await waitFor(() => expect(canvas).toHaveAttribute("aria-busy", "false"));
    serializeSpy.mockClear();
    const flow = canvas.querySelector<HTMLElement>(".react-flow");
    expect(flow).not.toBeNull();
    vi.spyOn(flow!, "getBoundingClientRect").mockReturnValue({
      bottom: 800,
      height: 800,
      left: 0,
      right: 1_000,
      top: 0,
      width: 1_000,
      x: 0,
      y: 0,
      toJSON: () => ({})
    });
    const card = screen.getByTestId("rf__node-new-card");
    expect(card).toHaveClass("nopan");
    expect(card).not.toHaveClass("nodrag");
    const eventView = card.ownerDocument.defaultView!;
    const mouseDown = createEvent.mouseDown(card, { button: 0, buttons: 1, clientX: 200, clientY: 200 });
    const thresholdMove = createEvent.mouseMove(eventView, { buttons: 1, clientX: 208, clientY: 208 });
    const mouseMove = createEvent.mouseMove(eventView, { buttons: 1, clientX: 260, clientY: 240 });
    const mouseUp = createEvent.mouseUp(eventView, { button: 0, buttons: 0, clientX: 260, clientY: 240 });
    Object.defineProperty(mouseDown, "view", { value: eventView });
    Object.defineProperty(thresholdMove, "view", { value: eventView });
    Object.defineProperty(mouseMove, "view", { value: eventView });
    Object.defineProperty(mouseUp, "view", { value: eventView });

    await act(async () => fireEvent(card, mouseDown));
    await act(async () => fireEvent(eventView, thresholdMove));
    await waitFor(() => expect(card).toHaveClass("dragging"));
    await act(async () => {
      fireEvent(eventView, mouseMove);
      fireEvent(eventView, mouseUp);
      await Promise.resolve();
    });

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    const emitted = safeCanvasDocument(onChange.mock.lastCall?.[0] as string);
    expect(emitted.nodes[0]).toMatchObject({ id: "new-card", x: 60, y: 40 });
    expect(serializeSpy).toHaveBeenCalledTimes(1);
    serializeSpy.mockRestore();
  });

  it("does not rewrite a valid document merely because it was mounted", async () => {
    const onChange = vi.fn();
    render(createElement(JsonCanvasView, {
      fileOptions: [],
      onChange,
      onOpenFile: vi.fn(),
      source: richCanvasSource
    }));
    await Promise.resolve();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("adds editable cards through accessible controls and emits JSON", async () => {
    const onChange = vi.fn();
    render(createElement(
      JsonCanvasView,
      {
        fileOptions: [{ label: "연구 노트", path: "Research/Note.md" }],
        onChange,
        onOpenFile: vi.fn(),
        source: emptyJsonCanvas
      }
    ));

    await userEvent.click(screen.getByRole("button", { name: "텍스트 카드 추가" }));
    const emitted = safeCanvasDocument(onChange.mock.lastCall?.[0] as string);
    expect(emitted.nodes).toHaveLength(1);
    expect(emitted.nodes[0]).toMatchObject({ text: "새 메모", type: "text" });
  });

  it("keeps compact color visuals inside accessible palette buttons", () => {
    render(createElement(JsonCanvasView, {
      fileOptions: [],
      onChange: vi.fn(),
      onOpenFile: vi.fn(),
      source: emptyJsonCanvas
    }));

    const defaultColor = screen.getByRole("button", { name: "기본 색상" });
    const purpleColor = screen.getByRole("button", { name: "색상 1" });
    expect(defaultColor.querySelector(".vault-canvas-color-swatch--default")).toHaveAttribute("aria-hidden", "true");
    expect(purpleColor.querySelector(".vault-canvas-color-swatch")).toHaveStyle({
      backgroundColor: safeCanvasColor("1")
    });
  });

  it("searches a large Vault without rendering thousands of file options", async () => {
    const fileOptions = Array.from({ length: 5_000 }, (_, index) => ({
      label: `노트 ${index}`,
      path: `Folder/Note-${index}.md`
    }));
    const onChange = vi.fn();
    render(createElement(JsonCanvasView, {
      fileOptions,
      onChange,
      onOpenFile: vi.fn(),
      source: emptyJsonCanvas
    }));

    expect(document.querySelectorAll("option").length).toBeLessThan(20);
    await userEvent.click(screen.getByRole("button", { name: "추가할 노트 선택" }));

    const resultList = screen.getByRole("list", { name: "Canvas 파일 검색 결과" });
    expect(within(resultList).getAllByRole("button")).toHaveLength(50);
    expect(screen.getByText(/5,000개 중 50개/)).toBeInTheDocument();

    const search = screen.getByRole("searchbox", { name: "파일 이름 또는 경로 검색" });
    await userEvent.type(search, "4999");
    const match = within(resultList).getByRole("button", { name: /노트 4999/ });
    await userEvent.click(match);
    await userEvent.click(screen.getByRole("button", { name: "선택한 노트 카드 추가" }));

    const emitted = safeCanvasDocument(onChange.mock.lastCall?.[0] as string);
    expect(emitted.nodes).toHaveLength(1);
    expect(emitted.nodes[0]).toMatchObject({ file: "Folder/Note-4999.md", type: "file" });
    expect(screen.queryByRole("dialog", { name: "Canvas 파일 선택" })).not.toBeInTheDocument();
  });

  it("indexes large file option lists once instead of scanning them for every card", async () => {
    let pathReads = 0;
    const fileOptions = Array.from({ length: 5_000 }, (_, index) => {
      const path = `Folder/Note-${index}.md`;
      return {
        label: `노트 ${index}`,
        get path() {
          pathReads += 1;
          return path;
        }
      };
    });
    const file = "Folder/Note-4999.md";
    render(createElement(JsonCanvasView, {
      fileOptions,
      onChange: vi.fn(),
      onOpenFile: vi.fn(),
      readOnly: true,
      source: JSON.stringify({
        nodes: Array.from({ length: 12 }, (_, index) => ({
          id: `file-${index}`,
          type: "file",
          x: index * 8,
          y: index * 8,
          width: 300,
          height: 180,
          file
        })),
        edges: []
      })
    }));

    await vi.waitFor(() => expect(screen.getAllByText("노트 4999")).toHaveLength(12));
    expect(pathReads).toBeLessThanOrEqual(fileOptions.length * 3);
  });

  it("never turns a non-http link card into an anchor", () => {
    render(createElement(
      JsonCanvasView,
      {
        fileOptions: [],
        onChange: vi.fn(),
        onOpenFile: vi.fn(),
        readOnly: true,
        source: JSON.stringify({
          nodes: [{ id: "bad-link", type: "link", x: 0, y: 0, width: 300, height: 150, url: "javascript:alert(1)" }],
          edges: []
        })
      }
    ));

    expect(screen.queryByRole("link", { name: "안전하게 열기" })).not.toBeInTheDocument();
    expect(screen.getByText("http/https 링크만 열 수 있습니다.")).toBeInTheDocument();
  });

  it("uses a new browsing context without an opener for safe links", () => {
    render(createElement(JsonCanvasView, {
      fileOptions: [],
      onChange: vi.fn(),
      onOpenFile: vi.fn(),
      readOnly: true,
      source: JSON.stringify({
        nodes: [{ id: "safe-link", type: "link", x: 0, y: 0, width: 300, height: 150, url: "https://example.com" }],
        edges: []
      })
    }));
    const link = screen.getByText("안전하게 열기").closest("a");
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveAttribute("referrerpolicy", "no-referrer");
  });

  it("keeps web cards inert until the user explicitly opens a no-opener link", () => {
    render(createElement(JsonCanvasView, {
      fileOptions: [],
      onChange: vi.fn(),
      onOpenFile: vi.fn(),
      readOnly: true,
      source: JSON.stringify({
        nodes: [{ id: "web", type: "link", x: 0, y: 0, width: 360, height: 240, url: "https://example.com/embed" }],
        edges: []
      })
    }));

    expect(screen.getByText("example.com")).toBeInTheDocument();
    expect(screen.getByText(/자동으로 불러오지 않습니다/)).toBeInTheDocument();
    expect(screen.queryByTitle(/웹 카드 미리보기/)).not.toBeInTheDocument();
    expect(screen.getByText("안전하게 열기").closest("a")).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("renders an encrypted image asset card without accepting an object URL as model data", async () => {
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:canvas-asset");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const rendered = render(createElement(JsonCanvasView, {
      fileOptions: [{
        asset: {
          bytes: previewablePngBytes(),
          mimeType: "image/png"
        },
        kind: "asset",
        label: "diagram.png",
        path: "Assets/diagram.png"
      }],
      onChange: vi.fn(),
      onOpenFile: vi.fn(),
      readOnly: true,
      source: JSON.stringify({
        nodes: [{ id: "asset", type: "file", x: 0, y: 0, width: 360, height: 240, file: "Assets/diagram.png" }],
        edges: []
      })
    }));

    await vi.waitFor(() => expect(document.querySelector('img[alt="diagram.png"]')).toHaveAttribute("src", "blob:canvas-asset"));
    expect(screen.queryByText("blob:canvas-asset")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Canvas 파일 선택")).not.toBeInTheDocument();
    expect(screen.getByText("diagram.png")).toBeInTheDocument();
    rendered.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:canvas-asset");
    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
  });

  it("renders authorized Markdown file content through the inert sanitized renderer", () => {
    render(createElement(JsonCanvasView, {
      fileOptions: [{
        content: "# 연결된 노트\n\n- 첫 번째 항목\n\n<script>alert(1)</script>",
        kind: "markdown",
        label: "Note.md",
        path: "Note.md"
      }],
      onChange: vi.fn(),
      onOpenFile: vi.fn(),
      readOnly: true,
      source: JSON.stringify({
        nodes: [{ id: "note", type: "file", x: 0, y: 0, width: 360, height: 260, file: "Note.md" }],
        edges: []
      })
    }));

    const preview = screen.getByLabelText("Markdown 노트 미리보기");
    expect(preview).toHaveAttribute("inert");
    expect(preview.querySelector("h1")).toHaveTextContent("연결된 노트");
    expect(within(preview).getByText("첫 번째 항목")).toBeInTheDocument();
    expect(preview.querySelector("script")).toBeNull();
    expect(preview).toHaveTextContent("<script>alert(1)</script>");
  });

  it("renders text cards as inert Markdown until an editable card is selected", async () => {
    render(createElement(JsonCanvasView, {
      fileOptions: [],
      onChange: vi.fn(),
      onOpenFile: vi.fn(),
      source: JSON.stringify({
        nodes: [{ id: "text", type: "text", x: 0, y: 0, width: 360, height: 220, text: "## 연구\n\n- 다음 실험" }],
        edges: []
      })
    }));

    const preview = screen.getByLabelText("Canvas 텍스트 Markdown 미리보기");
    expect(preview).toHaveAttribute("inert");
    expect(preview.querySelector("h2")).toHaveTextContent("연구");
    expect(screen.queryByRole("textbox", { name: "Canvas 텍스트" })).not.toBeInTheDocument();

    const card = screen.getByTestId("rf__node-text").querySelector("article");
    expect(card).not.toBeNull();
    fireEvent.doubleClick(card!);
    expect(await screen.findByLabelText("Canvas 텍스트")).toHaveValue("## 연구\n\n- 다음 실험");
  });

  it("creates an empty Markdown text card on an unmodified pane double-click", async () => {
    const onChange = vi.fn();
    render(createElement(JsonCanvasView, {
      fileOptions: [],
      onChange,
      onOpenFile: vi.fn(),
      source: emptyJsonCanvas
    }));
    const canvas = screen.getByLabelText("Canvas");
    await vi.waitFor(() => expect(canvas).toHaveAttribute("aria-busy", "false"));
    const pane = canvas.querySelector<HTMLElement>(".react-flow__pane");
    expect(pane).not.toBeNull();
    fireEvent.doubleClick(pane!, { button: 0, clientX: 83, clientY: 117 });

    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    const emitted = safeCanvasDocument(onChange.mock.lastCall?.[0] as string);
    expect(emitted.nodes).toHaveLength(1);
    expect(emitted.nodes[0]).toMatchObject({ text: "", type: "text" });
    expect(emitted.nodes[0].x % 20).toBe(0);
    expect(emitted.nodes[0].y % 20).toBe(0);
  });

  it("persists a safe PDF page subpath and keeps zoom in the sandboxed blob preview", async () => {
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:canvas-pdf");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const onChange = vi.fn();
    const rendered = render(createElement(JsonCanvasView, {
      fileOptions: [{
        asset: { bytes: new TextEncoder().encode("%PDF-1.7"), mimeType: "application/pdf" },
        kind: "asset",
        label: "paper.pdf",
        path: "paper.pdf"
      }],
      onChange,
      onOpenFile: vi.fn(),
      source: JSON.stringify({
        nodes: [{ id: "pdf", type: "file", x: 0, y: 0, width: 420, height: 320, file: "paper.pdf", subpath: "#page=2" }],
        edges: []
      })
    }));

    expect(canvasPdfPageFromSubpath("#page=2")).toBe(2);
    expect(canvasPdfPageFromSubpath("#page=0")).toBe(1);
    const nextPageButton = screen.getByLabelText("다음 PDF 페이지");
    const zoomInButton = screen.getByLabelText("PDF 확대");
    fireEvent.click(nextPageButton);
    expect(safeCanvasDocument(onChange.mock.lastCall?.[0] as string).nodes[0].subpath).toBe("#page=3");
    fireEvent.click(zoomInButton);
    const frame = await screen.findByTitle("paper.pdf PDF 미리보기");
    expect(frame).toHaveAttribute("src", "blob:canvas-pdf#page=3&zoom=125");
    rendered.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:canvas-pdf");
    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
  });

  it("locks a lossy canvas without emitting a replacement document", async () => {
    const onChange = vi.fn();
    render(createElement(JsonCanvasView, {
      fileOptions: [],
      onChange,
      onOpenFile: vi.fn(),
      source: JSON.stringify({
        nodes: [{ id: "invalid", type: "text", x: 0, y: 0, width: -1, height: 100, text: "original" }],
        edges: []
      })
    }));

    expect(screen.getByRole("alert")).toHaveTextContent("읽기 전용으로 열었습니다.");
    expect(screen.queryByRole("button", { name: "텍스트 카드 추가" })).not.toBeInTheDocument();
    await Promise.resolve();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not pass traversal file paths to the caller", async () => {
    const onOpenFile = vi.fn();
    render(createElement(JsonCanvasView, {
      fileOptions: [],
      onChange: vi.fn(),
      onOpenFile,
      readOnly: true,
      source: JSON.stringify({
        nodes: [{ id: "file", type: "file", x: 0, y: 0, width: 300, height: 150, file: "../outside.md" }],
        edges: []
      })
    }));

    const openButton = screen.getByText("원본 열기").closest("button");
    expect(openButton).not.toBeNull();
    expect(openButton).toBeDisabled();
    await userEvent.click(openButton!);
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("accepts an opaque Vault entry drop and adds a snapped file card at the flow position", async () => {
    const onChange = vi.fn();
    const resolveVaultEntryDrop = vi.fn((entryId: string) =>
      entryId === "entry-1" ? "Folder/Note.md" : null
    );
    render(createElement(JsonCanvasView, {
      fileOptions: [{ label: "노트", path: "Folder/Note.md" }],
      onChange,
      onOpenFile: vi.fn(),
      resolveVaultEntryDrop,
      source: emptyJsonCanvas
    }));

    expect(screen.getByText(/키보드나 터치 환경에서는/)).toHaveClass("sr-only");
    const canvas = screen.getByLabelText("Canvas");
    await vi.waitFor(() => expect(canvas).toHaveAttribute("aria-busy", "false"));
    const dataTransfer = {
      dropEffect: "none",
      getData: vi.fn((type: string) => type === JSON_CANVAS_VAULT_ENTRY_MIME
        ? '{"version":1,"entryId":"entry-1"}'
        : ""),
      types: [JSON_CANVAS_VAULT_ENTRY_MIME]
    } as unknown as DataTransfer;

    fireEvent.dragOver(canvas, { clientX: 41, clientY: 59, dataTransfer });
    expect(screen.getByText("여기에 놓아 Canvas 카드 추가")).toBeInTheDocument();
    expect(dataTransfer.dropEffect).toBe("copy");
    const dropEvent = createEvent.drop(canvas, { dataTransfer });
    Object.defineProperties(dropEvent, {
      clientX: { value: 41 },
      clientY: { value: 59 }
    });
    await act(async () => {
      fireEvent(canvas, dropEvent);
      await Promise.resolve();
    });

    expect(resolveVaultEntryDrop).toHaveBeenCalledWith("entry-1");
    expect(canvas.querySelector("p[aria-live='polite']")).toHaveTextContent("노트 카드를 놓은 위치에 추가했습니다.");
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    const emitted = safeCanvasDocument(onChange.mock.lastCall?.[0] as string);
    expect(emitted.nodes).toHaveLength(1);
    expect(emitted.nodes[0]).toMatchObject({
      file: "Folder/Note.md",
      type: "file"
    });
    expect(emitted.nodes[0].x % 20).toBe(0);
    expect(emitted.nodes[0].y % 20).toBe(0);
    expect(screen.getByText("노트 카드를 놓은 위치에 추가했습니다.")).toHaveClass("sr-only");
  });

  it("routes operating-system file drops only through the encrypted asset import callback", async () => {
    const onChange = vi.fn();
    const externalFile = new File([new Uint8Array([1, 2, 3])], "diagram.png", { type: "image/png" });
    const onImportExternalFiles = vi.fn(async (files: readonly File[]) => ({
      paths: files.map((file) => `Assets/${file.name}`),
      rejected: 0
    }));
    render(createElement(JsonCanvasView, {
      fileOptions: [],
      onChange,
      onImportExternalFiles,
      onOpenFile: vi.fn(),
      source: emptyJsonCanvas
    }));
    const canvas = screen.getByLabelText("Canvas");
    await vi.waitFor(() => expect(canvas).toHaveAttribute("aria-busy", "false"));
    const dataTransfer = {
      dropEffect: "none",
      files: [externalFile],
      getData: vi.fn(() => ""),
      types: ["Files"]
    } as unknown as DataTransfer;

    fireEvent.dragOver(canvas, { clientX: 61, clientY: 79, dataTransfer });
    expect(dataTransfer.dropEffect).toBe("copy");
    expect(screen.getByText("여기에 놓아 Canvas 카드 추가")).toBeInTheDocument();
    const dropEvent = createEvent.drop(canvas, { dataTransfer });
    Object.defineProperties(dropEvent, {
      clientX: { value: 61 },
      clientY: { value: 79 }
    });
    await act(async () => {
      fireEvent(canvas, dropEvent);
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(onImportExternalFiles).toHaveBeenCalledWith([externalFile]));
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    const emitted = safeCanvasDocument(onChange.mock.lastCall?.[0] as string);
    expect(emitted.nodes).toHaveLength(1);
    expect(emitted.nodes[0]).toMatchObject({ file: "Assets/diagram.png", type: "file" });
    await vi.waitFor(() => expect(screen.getByText("1개 외부 파일을 암호화해 Canvas에 추가했습니다.")).toHaveClass("sr-only"));
  });

  it("rejects smuggled drag metadata before resolving a Vault entry", () => {
    const onChange = vi.fn();
    const resolveVaultEntryDrop = vi.fn(() => "Folder/Note.md");
    render(createElement(JsonCanvasView, {
      fileOptions: [{ label: "노트", path: "Folder/Note.md" }],
      onChange,
      onOpenFile: vi.fn(),
      resolveVaultEntryDrop,
      source: emptyJsonCanvas
    }));

    fireEvent.drop(screen.getByLabelText("Canvas"), {
      clientX: 20,
      clientY: 20,
      dataTransfer: {
        dropEffect: "none",
        getData: () => '{"version":1,"entryId":"entry-1","content":"secret"}',
        types: [JSON_CANVAS_VAULT_ENTRY_MIME]
      }
    });

    expect(resolveVaultEntryDrop).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText("안전하지 않거나 만료된 노트 드래그를 거부했습니다.")).toHaveClass("sr-only");
  });

  it("keeps external drops inert in read-only mode", () => {
    const onChange = vi.fn();
    const resolveVaultEntryDrop = vi.fn(() => "Folder/Note.md");
    render(createElement(JsonCanvasView, {
      fileOptions: [{ label: "노트", path: "Folder/Note.md" }],
      onChange,
      onOpenFile: vi.fn(),
      readOnly: true,
      resolveVaultEntryDrop,
      source: emptyJsonCanvas
    }));
    const dataTransfer = {
      dropEffect: "copy",
      getData: vi.fn(() => '{"version":1,"entryId":"entry-1"}'),
      types: [JSON_CANVAS_VAULT_ENTRY_MIME]
    } as unknown as DataTransfer;

    fireEvent.dragOver(screen.getByLabelText("Canvas"), { dataTransfer });
    expect(dataTransfer.dropEffect).toBe("none");
    fireEvent.drop(screen.getByLabelText("Canvas"), { dataTransfer });

    expect(resolveVaultEntryDrop).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText("읽기 전용 Canvas에는 파일을 놓을 수 없습니다.")).toHaveClass("sr-only");
  });

  it("opens a focused safe file card with Enter", () => {
    const onOpenFile = vi.fn();
    render(createElement(JsonCanvasView, {
      fileOptions: [{ label: "노트", path: "Folder/Note.md" }],
      onChange: vi.fn(),
      onOpenFile,
      readOnly: true,
      source: JSON.stringify({
        nodes: [{ id: "file", type: "file", x: 0, y: 0, width: 300, height: 150, file: "Folder/Note.md" }],
        edges: []
      })
    }));

    fireEvent.keyDown(screen.getByTestId("rf__node-file"), { key: "Enter" });
    expect(onOpenFile).toHaveBeenCalledWith("Folder/Note.md");
  });

  it("selects a file card on single click and opens it only on double click or the explicit button", async () => {
    const onOpenFile = vi.fn();
    render(createElement(JsonCanvasView, {
      fileOptions: [{ label: "노트", path: "Folder/Note.md" }],
      onChange: vi.fn(),
      onOpenFile,
      readOnly: true,
      source: JSON.stringify({
        nodes: [{ id: "file", type: "file", x: 0, y: 0, width: 300, height: 150, file: "Folder/Note.md" }],
        edges: []
      })
    }));
    const fileCard = screen.getByTestId("rf__node-file");

    expect(CANVAS_NODE_INTERACTION_THRESHOLD_PX).toBe(6);
    fireEvent.click(fileCard, { button: 0 });
    expect(onOpenFile).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(fileCard).toHaveClass("selected"));

    fireEvent.doubleClick(fileCard, { button: 0 });
    expect(onOpenFile).toHaveBeenCalledOnce();
    expect(onOpenFile).toHaveBeenLastCalledWith("Folder/Note.md");

    onOpenFile.mockClear();
    fireEvent.click(fileCard, { ctrlKey: true });
    fireEvent.click(fileCard, { metaKey: true });
    fireEvent.click(fileCard, { shiftKey: true });
    fireEvent.click(fileCard, { altKey: true });
    expect(onOpenFile).not.toHaveBeenCalled();

    const openButton = screen.getByText("원본 열기").closest("button");
    expect(openButton).not.toBeNull();
    await userEvent.click(openButton!);
    expect(onOpenFile).toHaveBeenCalledOnce();
    expect(onOpenFile).toHaveBeenLastCalledWith("Folder/Note.md");
  });

  it("opens a keyboard-accessible context menu and duplicates a group with contained cards", async () => {
    const onChange = vi.fn();
    render(createElement(JsonCanvasView, {
      fileOptions: [],
      onChange,
      onOpenFile: vi.fn(),
      source: JSON.stringify({
        nodes: [
          { id: "group", type: "group", x: 0, y: 0, width: 400, height: 300, label: "group" },
          { id: "inside", type: "text", x: 20, y: 20, width: 100, height: 80, text: "inside" },
          { id: "outside", type: "text", x: 500, y: 20, width: 100, height: 80, text: "outside" }
        ],
        edges: []
      })
    }));

    const group = screen.getByTestId("rf__node-group");
    group.focus();
    fireEvent.keyDown(group, { key: "F10", shiftKey: true });
    const menu = await screen.findByRole("menu", { name: "Canvas 항목 메뉴" });
    expect(within(menu).getByRole("menuitem", { name: "그룹과 안의 카드 선택" })).toBeInTheDocument();
    await userEvent.click(within(menu).getByRole("menuitem", { name: "그룹과 안의 카드 복제" }));

    const emitted = safeCanvasDocument(onChange.mock.lastCall?.[0] as string);
    expect(emitted.nodes).toHaveLength(5);
    expect(emitted.nodes.filter((node) => node.x === 32 || node.x === 52)).toHaveLength(2);
    expect(screen.queryByRole("menu", { name: "Canvas 항목 메뉴" })).not.toBeInTheDocument();
  });

  it("opens a safe file from the right-click context menu", async () => {
    const onOpenFile = vi.fn();
    render(createElement(JsonCanvasView, {
      fileOptions: [{ label: "노트", path: "Folder/Note.md" }],
      onChange: vi.fn(),
      onOpenFile,
      readOnly: true,
      source: JSON.stringify({
        nodes: [{ id: "file", type: "file", x: 0, y: 0, width: 300, height: 150, file: "Folder/Note.md" }],
        edges: []
      })
    }));

    fireEvent.contextMenu(screen.getByTestId("rf__node-file"), { clientX: 120, clientY: 80 });
    const menu = await screen.findByRole("menu", { name: "Canvas 항목 메뉴" });
    await userEvent.click(within(menu).getByRole("menuitem", { name: "원본 열기" }));
    expect(onOpenFile).toHaveBeenCalledWith("Folder/Note.md");
  });

  it("opens the same accessible menu on a stationary touch long-press and cancels after movement", () => {
    vi.useFakeTimers();
    try {
      render(createElement(JsonCanvasView, {
        fileOptions: [],
        onChange: vi.fn(),
        onOpenFile: vi.fn(),
        source: JSON.stringify({
          nodes: [{ id: "card", type: "text", x: 0, y: 0, width: 220, height: 120, text: "touch" }],
          edges: []
        })
      }));
      const card = screen.getByTestId("rf__node-card");

      fireEvent.pointerDown(card, { clientX: 60, clientY: 70, pointerId: 7, pointerType: "touch" });
      fireEvent.pointerMove(card, { clientX: 80, clientY: 70, pointerId: 7, pointerType: "touch" });
      act(() => vi.advanceTimersByTime(600));
      expect(screen.queryByRole("menu", { name: "Canvas 항목 메뉴" })).not.toBeInTheDocument();

      fireEvent.pointerDown(card, { clientX: 60, clientY: 70, pointerId: 8, pointerType: "touch" });
      act(() => vi.advanceTimersByTime(600));
      expect(screen.getByRole("menu", { name: "Canvas 항목 메뉴" })).toBeInTheDocument();
      expect(screen.getByText("길게 눌러 Canvas 항목 메뉴를 열었습니다.")).toHaveClass("sr-only");
    } finally {
      vi.useRealTimers();
    }
  });

  it("moves a selected group and contained cards together with accessible arrow-key nudging", async () => {
    const onChange = vi.fn();
    render(createElement(JsonCanvasView, {
      fileOptions: [],
      onChange,
      onOpenFile: vi.fn(),
      source: JSON.stringify({
        nodes: [
          { id: "group", type: "group", x: 0, y: 0, width: 400, height: 300, label: "group" },
          { id: "inside", type: "text", x: 20, y: 20, width: 100, height: 80, text: "inside" },
          { id: "outside", type: "text", x: 500, y: 20, width: 100, height: 80, text: "outside" }
        ],
        edges: []
      })
    }));
    const group = screen.getByTestId("rf__node-group");
    fireEvent.click(group, { ctrlKey: true });
    await vi.waitFor(() => expect(screen.getByText("1개 선택")).toBeInTheDocument());
    fireEvent.keyDown(group, { key: "ArrowRight" });

    const emitted = safeCanvasDocument(onChange.mock.lastCall?.[0] as string);
    expect(emitted.nodes.map(({ id, x, y }) => ({ id, x, y }))).toEqual([
      { id: "group", x: 20, y: 0 },
      { id: "inside", x: 40, y: 20 },
      { id: "outside", x: 500, y: 20 }
    ]);
  });

  it("renders only a signature-validated image as a group background preview", async () => {
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:canvas-group-background");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const rendered = render(createElement(JsonCanvasView, {
      fileOptions: [{
        asset: { bytes: previewablePngBytes(), mimeType: "image/png" },
        kind: "asset",
        label: "background.png",
        path: "Assets/background.png"
      }],
      onChange: vi.fn(),
      onOpenFile: vi.fn(),
      readOnly: true,
      source: JSON.stringify({
        nodes: [{
          id: "group",
          type: "group",
          x: 0,
          y: 0,
          width: 400,
          height: 300,
          label: "group",
          background: "Assets/background.png",
          backgroundStyle: "cover"
        }],
        edges: []
      })
    }));

    await vi.waitFor(() => expect(document.querySelector('img[alt="background.png"]')).toHaveAttribute(
      "src",
      "blob:canvas-group-background"
    ));
    expect(document.querySelector(".vault-canvas-group-background-preview--cover")).not.toBeNull();
    rendered.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:canvas-group-background");
    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
  });

  it("exposes keyboard-safe distribution and z-order toolbar commands", () => {
    const onChange = vi.fn();
    render(createElement(JsonCanvasView, {
      fileOptions: [],
      onChange,
      onOpenFile: vi.fn(),
      source: emptyJsonCanvas
    }));

    const toolbar = screen.getByRole("toolbar", { name: "Canvas 편집 도구" });
    const commandLabels = [
      "선택 카드 가로 간격 같게 배치",
      "선택 카드 세로 간격 같게 배치",
      "선택 카드를 맨 앞으로",
      "선택 카드를 맨 뒤로"
    ];
    for (const label of commandLabels) {
      const button = within(toolbar).getByRole("button", { name: label });
      expect(button).toHaveAttribute("type", "button");
      expect(button).toBeDisabled();
      fireEvent.keyDown(button, { key: "Delete" });
    }
    expect(onChange).not.toHaveBeenCalled();
  });

  it("commits selected-card z-order changes through the accessible toolbar", async () => {
    const onChange = vi.fn();
    render(createElement(JsonCanvasView, {
      fileOptions: [],
      onChange,
      onOpenFile: vi.fn(),
      source: JSON.stringify({
        documentExtension: "keep",
        nodes: [
          { id: "a", type: "text", x: 0, y: 0, width: 100, height: 80, text: "a" },
          { id: "b", type: "text", x: 20, y: 20, width: 100, height: 80, text: "b", extension: 2 },
          { id: "c", type: "text", x: 40, y: 40, width: 100, height: 80, text: "c" }
        ],
        edges: []
      })
    }));

    fireEvent.click(screen.getByTestId("rf__node-b"));
    const bringToFront = screen.getByRole("button", { name: "선택 카드를 맨 앞으로" });
    await vi.waitFor(() => expect(bringToFront).toBeEnabled());
    await userEvent.click(bringToFront);

    const emitted = safeCanvasDocument(onChange.mock.lastCall?.[0] as string);
    expect(emitted.nodes.map((node) => node.id)).toEqual(["a", "c", "b"]);
    expect(emitted.nodes[2]).toMatchObject({ extension: 2, text: "b" });
    expect(emitted.documentExtension).toBe("keep");
  });
});
