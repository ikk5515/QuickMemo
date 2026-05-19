export const maxPdfPreviewPages = 30;
export const maxPdfPreviewCanvasPixels = 4_000_000;
export const maxPdfPreviewTotalCanvasPixels = 32_000_000;
export const maxPdfPreviewImagePixels = 6_000_000;
export const maxPdfPreviewPageCssWidth = 860;
export const maxPdfPreviewPageCssHeight = 1400;

interface PdfPreviewCanvasLayoutInput {
  baseHeight: number;
  baseWidth: number;
  containerWidth: number;
  devicePixelRatio: number;
  remainingCanvasPixels: number;
}

export interface PdfPreviewCanvasLayout {
  canvasHeight: number;
  canvasPixels: number;
  canvasWidth: number;
  cssHeight: number;
  cssScale: number;
  cssWidth: number;
  outputScale: number;
}

export function pdfPreviewCanvasLayout({
  baseHeight,
  baseWidth,
  containerWidth,
  devicePixelRatio,
  remainingCanvasPixels
}: PdfPreviewCanvasLayoutInput): PdfPreviewCanvasLayout | null {
  const safeBaseWidth = positiveFinite(Math.abs(baseWidth));
  const safeBaseHeight = positiveFinite(Math.abs(baseHeight));
  const remainingPixels = Math.floor(remainingCanvasPixels);

  if (!safeBaseWidth || !safeBaseHeight || remainingPixels <= 0) {
    return null;
  }

  const viewportWidth = positiveFinite(containerWidth) ?? maxPdfPreviewPageCssWidth;
  const targetWidth = Math.min(maxPdfPreviewPageCssWidth, Math.max(220, viewportWidth - 32));
  const cssScale = Math.min(
    1.5,
    targetWidth / safeBaseWidth,
    maxPdfPreviewPageCssHeight / safeBaseHeight
  );

  if (!positiveFinite(cssScale)) {
    return null;
  }

  const cssWidthFloat = safeBaseWidth * cssScale;
  const cssHeightFloat = safeBaseHeight * cssScale;
  const cssPixelArea = cssWidthFloat * cssHeightFloat;
  const pagePixelBudget = Math.min(maxPdfPreviewCanvasPixels, remainingPixels);

  if (!positiveFinite(cssWidthFloat) || !positiveFinite(cssHeightFloat) || !positiveFinite(cssPixelArea) || pagePixelBudget <= 0) {
    return null;
  }

  const requestedOutputScale = positiveFinite(devicePixelRatio) ?? 1;
  const maxOutputScale = Math.sqrt(pagePixelBudget / cssPixelArea);
  const outputScale = Math.min(requestedOutputScale, maxOutputScale);

  if (!positiveFinite(outputScale)) {
    return null;
  }

  return clampCanvasLayout({
    canvasHeight: Math.max(1, Math.floor(cssHeightFloat * outputScale)),
    canvasWidth: Math.max(1, Math.floor(cssWidthFloat * outputScale)),
    cssHeight: Math.max(1, Math.floor(cssHeightFloat)),
    cssScale,
    cssWidth: Math.max(1, Math.floor(cssWidthFloat)),
    outputScale,
    pagePixelBudget
  });
}

function clampCanvasLayout(input: Omit<PdfPreviewCanvasLayout, "canvasPixels"> & { pagePixelBudget: number }): PdfPreviewCanvasLayout | null {
  let canvasWidth = input.canvasWidth;
  let canvasHeight = input.canvasHeight;
  let canvasPixels = canvasWidth * canvasHeight;

  if (canvasPixels > input.pagePixelBudget) {
    const shrinkScale = Math.sqrt(input.pagePixelBudget / canvasPixels);
    canvasWidth = Math.max(1, Math.floor(canvasWidth * shrinkScale));
    canvasHeight = Math.max(1, Math.floor(canvasHeight * shrinkScale));
    canvasPixels = canvasWidth * canvasHeight;
  }

  if (canvasPixels > input.pagePixelBudget) {
    return null;
  }

  return {
    canvasHeight,
    canvasPixels,
    canvasWidth,
    cssHeight: input.cssHeight,
    cssScale: input.cssScale,
    cssWidth: input.cssWidth,
    outputScale: input.outputScale
  };
}

function positiveFinite(value: number) {
  return Number.isFinite(value) && value > 0 ? value : null;
}
