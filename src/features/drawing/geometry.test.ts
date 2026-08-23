import { describe, expect, it } from "vitest";
import type { DrawingElement } from "./model";
import {
  DRAWING_COORDINATE_LIMIT,
  drawingElementBounds,
  drawingElementHit,
  drawingElementsEqual,
  resizeDrawingElement,
  translateDrawingElement
} from "./geometry";

const rectangle: DrawingElement = {
  color: "#8b5cf6",
  end: { x: 30, y: 40 },
  id: "rectangle-a",
  start: { x: 10, y: 20 },
  strokeWidth: 2,
  type: "rectangle"
};

describe("Drawing geometry", () => {
  it("hit-tests segments and bounded shapes without executing DOM content", () => {
    expect(drawingElementHit(rectangle, { x: 20, y: 30 })).toBe(true);
    expect(drawingElementHit({ ...rectangle, type: "line" }, { x: 20, y: 30 }, 2)).toBe(true);
    expect(drawingElementHit({ ...rectangle, type: "line" }, { x: 20, y: 4 }, 2)).toBe(false);
  });

  it("moves every geometry type while clamping finite coordinates", () => {
    const moved = translateDrawingElement(rectangle, { x: DRAWING_COORDINATE_LIMIT * 2, y: -5 });
    expect(moved).toMatchObject({
      end: { x: DRAWING_COORDINATE_LIMIT, y: 35 },
      start: { x: DRAWING_COORDINATE_LIMIT, y: 15 }
    });
    expect(drawingElementsEqual(moved, rectangle)).toBe(false);
  });

  it("resizes from a corner around the opposite anchor and preserves a valid minimum", () => {
    const resized = resizeDrawingElement(rectangle, "se", { x: 50, y: 60 });
    expect(drawingElementBounds(resized)).toEqual({ height: 40, width: 40, x: 10, y: 20 });
    const collapsed = resizeDrawingElement(rectangle, "se", { x: 10, y: 20 });
    expect(drawingElementBounds(collapsed).width).toBeGreaterThanOrEqual(1);
    expect(drawingElementBounds(collapsed).height).toBeGreaterThanOrEqual(1);
  });

  it("bounds text resize through the existing stroke-width schema", () => {
    const text: DrawingElement = {
      color: "#fff",
      id: "text-a",
      point: { x: 10, y: 20 },
      strokeWidth: 2,
      text: "safe text",
      type: "text"
    };
    const resized = resizeDrawingElement(text, "se", { x: 100_000, y: 100_000 });
    expect(resized.type === "text" ? resized.strokeWidth : 0).toBe(32);
  });
});
