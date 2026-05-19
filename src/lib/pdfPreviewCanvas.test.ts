import { describe, expect, it } from "vitest";
import {
  maxPdfPreviewCanvasPixels,
  maxPdfPreviewPageCssHeight,
  maxPdfPreviewPageCssWidth,
  maxPdfPreviewTotalCanvasPixels,
  pdfPreviewCanvasLayout
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
});
