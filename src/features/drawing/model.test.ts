import { describe, expect, it } from "vitest";
import {
  MAX_DRAWING_ELEMENTS,
  createDrawingSource,
  parseDrawingSource,
  serializeDrawingDocument
} from "./model";

describe("Drawing Markdown model", () => {
  it("keeps Drawing JSON inside a Markdown source of truth", () => {
    const source = createDrawingSource("아이디어");
    const parsed = parseDrawingSource(source);
    const next = serializeDrawingDocument(source, {
      version: 1,
      elements: [{ color: "#8b5cf6", id: "line-1", strokeWidth: 2, type: "line", start: { x: 1, y: 2 }, end: { x: 3, y: 4 } }]
    });
    expect(parsed.readOnly).toBe(false);
    expect(parseDrawingSource(next).document?.elements).toHaveLength(1);
    expect(next).toContain("# 아이디어");
  });

  it("rejects raw or invalid element data", () => {
    const invalid = createDrawingSource().replace('{"version":1,"elements":[]}', '{"version":1,"elements":[{"type":"image","url":"javascript:alert(1)"}]}');
    expect(parseDrawingSource(invalid).readOnly).toBe(true);
  });

  it.each([
    '{"version":1,"elements":[],"pluginMeta":{"secret":true}}',
    '{"version":1,"elements":[{"type":"line","id":"a","color":"#000","strokeWidth":2,"start":{"x":0,"y":0},"end":{"x":1,"y":1},"opacity":0.5}]}',
    '{"version":1,"elements":[{"type":"line","id":"a","color":"#000","strokeWidth":2,"start":{"x":0,"y":0,"z":9},"end":{"x":1,"y":1}}]}'
  ])("fails closed for unknown JSON keys instead of dropping them: %s", (json) => {
    const source = createDrawingSource().replace('{"version":1,"elements":[]}', json);
    expect(parseDrawingSource(source).readOnly).toBe(true);
  });

  it("revalidates edited documents before replacing the Markdown fence", () => {
    const source = createDrawingSource();
    expect(() => serializeDrawingDocument(source, {
      version: 1,
      elements: [{ color: "#000", id: "bad", strokeWidth: 2, type: "line", start: { x: Number.POSITIVE_INFINITY, y: 0 }, end: { x: 1, y: 1 } }]
    })).toThrow("Drawing");
  });

  it("rejects duplicate element ids so selection remains unambiguous", () => {
    const element = '{"type":"pen","id":"same","color":"#000","strokeWidth":1,"points":[{"x":0,"y":0}]}';
    const source = createDrawingSource().replace(
      '{"version":1,"elements":[]}',
      `{"version":1,"elements":[${element},${element}]}`
    );
    expect(parseDrawingSource(source)).toMatchObject({ readOnly: true });
    expect(parseDrawingSource(source).errors[0]).toContain("id는 중복될 수 없습니다");
  });

  it("accepts a bounded 5,000-element document", () => {
    const elements = Array.from({ length: MAX_DRAWING_ELEMENTS }, (_, index) => ({
      color: "#000",
      id: index.toString(36),
      points: [{ x: 0, y: 0 }],
      strokeWidth: 1,
      type: "pen" as const
    }));
    const json = JSON.stringify({ version: 1, elements });
    const source = createDrawingSource().replace('{"version":1,"elements":[]}', json);
    const parsed = parseDrawingSource(source);
    expect(new TextEncoder().encode(source).byteLength).toBeLessThanOrEqual(500_000);
    expect(parsed).toMatchObject({ readOnly: false });
    expect(parsed.document?.elements).toHaveLength(MAX_DRAWING_ELEMENTS);
  });
});
