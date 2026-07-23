import { describe, expect, it } from "vitest";
import {
  maxCompactPdfPreviewPages,
  maxCompactPdfPreviewTotalCanvasPixels,
  maxPdfPreviewCanvasPixels,
  maxPdfPreviewPageCssHeight,
  maxPdfPreviewPageCssWidth,
  maxPdfPreviewPages,
  maxPdfPreviewTotalCanvasPixels,
  pdfPreviewCanvasLayout,
  pdfPreviewRenderBudget
} from "./pdfPreviewCanvas";

describe("pdfPreviewCanvasLayout", () => {
  it("strictly caps oversized PDF pages before canvas dimensions are assigned", () => {
    const layout = pdfPreviewCanvasLayout({
      baseHeight: 200_000,
      baseWidth: 200_000,
      containerWidth: 1_024,
      devicePixelRatio: 3,
      remainingCanvasPixels: maxPdfPreviewTotalCanvasPixels
    });

    expect(layout).not.toBeNull();
    expect(layout?.canvasPixels).toBeLessThanOrEqual(maxPdfPreviewCanvasPixels);
    expect(layout?.cssWidth).toBeLessThanOrEqual(maxPdfPreviewPageCssWidth);
    expect(layout?.cssHeight).toBeLessThanOrEqual(maxPdfPreviewPageCssHeight);
  });

  it("uses the remaining aggregate canvas budget as a hard cap", () => {
    const layout = pdfPreviewCanvasLayout({
      baseHeight: 792,
      baseWidth: 612,
      containerWidth: 900,
      devicePixelRatio: 2,
      remainingCanvasPixels: 50_000
    });

    expect(layout).not.toBeNull();
    expect(layout?.canvasPixels).toBeLessThanOrEqual(50_000);
  });

  it("refuses to render when no aggregate canvas budget remains", () => {
    expect(
      pdfPreviewCanvasLayout({
        baseHeight: 792,
        baseWidth: 612,
        containerWidth: 900,
        devicePixelRatio: 1,
        remainingCanvasPixels: 0
      })
    ).toBeNull();
  });

  it("uses a smaller bounded render budget on compact mobile screens", () => {
    expect(pdfPreviewRenderBudget(true)).toEqual({
      maxPages: maxCompactPdfPreviewPages,
      totalCanvasPixels: maxCompactPdfPreviewTotalCanvasPixels
    });
    expect(pdfPreviewRenderBudget(false)).toEqual({
      maxPages: maxPdfPreviewPages,
      totalCanvasPixels: maxPdfPreviewTotalCanvasPixels
    });
    expect(maxCompactPdfPreviewPages).toBeLessThan(maxPdfPreviewPages);
    expect(maxCompactPdfPreviewTotalCanvasPixels).toBeLessThan(maxPdfPreviewTotalCanvasPixels);
  });

  it("never exceeds the compact aggregate canvas budget at mobile DPR 3", () => {
    const budget = pdfPreviewRenderBudget(true);
    let remainingCanvasPixels = budget.totalCanvasPixels;
    let renderedPages = 0;

    for (let pageNumber = 0; pageNumber < budget.maxPages; pageNumber += 1) {
      const layout = pdfPreviewCanvasLayout({
        baseHeight: 792,
        baseWidth: 612,
        containerWidth: 390,
        devicePixelRatio: 3,
        remainingCanvasPixels
      });

      if (!layout) {
        break;
      }

      remainingCanvasPixels -= layout.canvasPixels;
      renderedPages += 1;
    }

    expect(renderedPages).toBeGreaterThan(0);
    expect(budget.totalCanvasPixels - remainingCanvasPixels).toBeLessThanOrEqual(
      maxCompactPdfPreviewTotalCanvasPixels
    );
  });
});
