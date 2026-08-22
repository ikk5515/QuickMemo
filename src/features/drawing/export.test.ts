import { describe, expect, it } from "vitest";
import { drawingDocumentToSvg, safeDrawingExportFilename } from "./export";
import type { DrawingDocument } from "./model";

describe("Drawing safe SVG export", () => {
  it("exports only inert SVG primitives and escapes text", () => {
    const document: DrawingDocument = {
      elements: [
        {
          color: "#123456",
          id: "text-1",
          point: { x: 10, y: 20 },
          strokeWidth: 2,
          text: "<script>alert('x')</script> & note",
          type: "text"
        },
        {
          color: "#abcdef",
          end: { x: 100, y: 120 },
          id: "arrow-1",
          start: { x: 20, y: 30 },
          strokeWidth: 3,
          type: "arrow"
        }
      ],
      version: 1
    };
    const svg = drawingDocumentToSvg(document, { background: "#ffffff" });

    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("&amp; note");
    expect(svg).toContain("<polyline");
    expect(svg).not.toMatch(/<script|foreignObject|<image|href=/iu);
  });

  it("fails closed for invalid elements and unsafe background values", () => {
    const invalid = {
      elements: [{ color: "url(javascript:1)", id: "x", points: [{ x: 0, y: 0 }], strokeWidth: 1, type: "pen" }],
      version: 1
    } as unknown as DrawingDocument;
    expect(() => drawingDocumentToSvg(invalid)).toThrow("Drawing");
    expect(() => drawingDocumentToSvg({ elements: [], version: 1 }, { background: "url(https://example.com)" }))
      .toThrow("배경색");
  });

  it("normalizes a local-only download filename", () => {
    expect(safeDrawingExportFilename("회의/초안?.md")).toBe("회의-초안-.md.svg");
    expect(safeDrawingExportFilename("\u0000")).toBe("Drawing.svg");
  });
});
