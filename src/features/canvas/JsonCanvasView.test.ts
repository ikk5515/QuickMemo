import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  JsonCanvasView,
  alignJsonCanvasNodes,
  duplicateJsonCanvasSelection,
  effectiveJsonCanvasEdgeEnds,
  emptyJsonCanvas,
  parseCanvasDocument,
  safeCanvasColor,
  safeCanvasDocument,
  safeHttpUrl,
  safeVaultPath,
  serializeCanvas
} from "./JsonCanvasView";
import type { CanvasFlowEdge, CanvasFlowNode, JsonCanvasDocument } from "./canvasModel";

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
});

describe("JSON Canvas editing operations", () => {
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
          bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
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
});
