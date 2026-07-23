import { useEffect, useRef, useState } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import {
  maxPdfPreviewCanvasPixels,
  maxPdfPreviewImagePixels,
  maxPdfPreviewPageCssWidth,
  pdfPreviewCanvasLayout,
  pdfPreviewRenderBudget
} from "../lib/pdfPreviewCanvas";

export default function PublicPdfCanvasPreview({ bytes, fileName }: { bytes: Uint8Array; fileName: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<{
    error: string | null;
    pageCount: number;
    pageLimit: number;
    renderedCount: number;
    status: "loading" | "ready" | "error";
  }>({
    error: null,
    pageCount: 0,
    pageLimit: 0,
    renderedCount: 0,
    status: "loading"
  });

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return undefined;
    }

    const previewContainer: HTMLDivElement = container;
    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    let pdfDocument: PDFDocumentProxy | null = null;
    const renderTasks = new Set<RenderTask>();
    const retainedPages = new Set<PDFPageProxy>();
    let retainedCanvasPixels = 0;

    function releaseCanvases() {
      previewContainer.querySelectorAll("canvas").forEach((canvas) => {
        canvas.width = 0;
        canvas.height = 0;
      });
      previewContainer.replaceChildren();
    }

    previewContainer.replaceChildren();
    setState({ error: null, pageCount: 0, pageLimit: 0, renderedCount: 0, status: "loading" });

    async function renderPdf() {
      try {
        const pdfjs = await import("pdfjs-dist");

        if (cancelled) {
          return;
        }

        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
        loadingTask = pdfjs.getDocument({
          canvasMaxAreaInBytes: maxPdfPreviewCanvasPixels,
          data: bytes.slice(),
          disableAutoFetch: true,
          disableFontFace: true,
          disableRange: true,
          disableStream: true,
          enableXfa: false,
          isImageDecoderSupported: false,
          maxImageSize: maxPdfPreviewImagePixels,
          stopAtErrors: true,
          useSystemFonts: false,
          useWorkerFetch: false
        });

        const pdf = await loadingTask.promise;
        pdfDocument = pdf;

        if (cancelled) {
          return;
        }

        const pageCount = pdf.numPages;
        const compactPreview = typeof window.matchMedia === "function"
          ? window.matchMedia("(max-width: 900px)").matches
          : window.innerWidth <= 900;
        const renderBudget = pdfPreviewRenderBudget(compactPreview);
        const pagesToRender = Math.min(pageCount, renderBudget.maxPages);
        let renderedPages = 0;

        setState({
          error: null,
          pageCount,
          pageLimit: renderBudget.maxPages,
          renderedCount: 0,
          status: "loading"
        });

        for (let pageNumber = 1; pageNumber <= pagesToRender; pageNumber += 1) {
          if (cancelled) {
            return;
          }

          const page = await pdf.getPage(pageNumber);
          retainedPages.add(page);

          if (cancelled) {
            page.cleanup();
            retainedPages.delete(page);
            return;
          }

          const baseViewport = page.getViewport({ scale: 1 });
          const containerWidth = previewContainer.clientWidth || maxPdfPreviewPageCssWidth;
          const remainingCanvasPixels = renderBudget.totalCanvasPixels - retainedCanvasPixels;
          const layout = pdfPreviewCanvasLayout({
            baseHeight: baseViewport.height,
            baseWidth: baseViewport.width,
            containerWidth,
            devicePixelRatio: window.devicePixelRatio || 1,
            remainingCanvasPixels
          });

          if (!layout) {
            page.cleanup();
            retainedPages.delete(page);
            break;
          }

          if (layout.canvasPixels > maxPdfPreviewCanvasPixels || layout.canvasPixels > remainingCanvasPixels) {
            throw new Error("PDF preview canvas budget exceeded.");
          }

          const renderViewport = page.getViewport({ scale: layout.cssScale * layout.outputScale });
          const canvas = document.createElement("canvas");

          canvas.className = "pdf-preview-canvas-page";
          canvas.width = layout.canvasWidth;
          canvas.height = layout.canvasHeight;
          canvas.style.width = `${layout.cssWidth}px`;
          canvas.style.height = `${layout.cssHeight}px`;
          canvas.setAttribute("aria-label", `${fileName} ${pageNumber}쪽`);
          previewContainer.append(canvas);
          retainedCanvasPixels += layout.canvasPixels;

          const renderTask = page.render({
            annotationMode: pdfjs.AnnotationMode.DISABLE,
            background: "#ffffff",
            canvas,
            viewport: renderViewport
          });

          renderTasks.add(renderTask);
          await renderTask.promise;
          renderTasks.delete(renderTask);
          page.cleanup();
          retainedPages.delete(page);
          renderedPages += 1;

          if (!cancelled) {
            setState({
              error: null,
              pageCount,
              pageLimit: renderBudget.maxPages,
              renderedCount: renderedPages,
              status: "loading"
            });
          }
        }

        if (pagesToRender > 0 && renderedPages === 0) {
          throw new Error("PDF preview has no safe renderable pages.");
        }

        if (!cancelled) {
          setState({
            error: null,
            pageCount,
            pageLimit: renderBudget.maxPages,
            renderedCount: renderedPages,
            status: "ready"
          });
        }
      } catch {
        if (!cancelled) {
          releaseCanvases();
          setState({
            error: "PDF 미리보기를 안전하게 렌더링하지 못했습니다. 원본 파일은 다운로드해서 확인해주세요.",
            pageCount: 0,
            pageLimit: 0,
            renderedCount: 0,
            status: "error"
          });
        }
      }
    }

    void renderPdf();

    return () => {
      cancelled = true;
      renderTasks.forEach((task) => task.cancel());
      retainedPages.forEach((page) => page.cleanup());
      renderTasks.clear();
      retainedPages.clear();
      releaseCanvases();

      if (pdfDocument) {
        void pdfDocument.destroy().catch(() => undefined);
      } else {
        void loadingTask?.destroy().catch(() => undefined);
      }
    };
  }, [bytes, fileName]);

  const expectedRenderedPages = Math.min(state.pageCount, state.pageLimit);
  const truncated = state.status === "ready" && (
    state.pageCount > state.pageLimit
    || state.renderedCount < expectedRenderedPages
  );

  return (
    <div className="pdf-preview-canvas-frame" aria-label={`${fileName} PDF 미리보기`}>
      <div ref={containerRef} className="pdf-preview-canvas-pages" />
      {state.status === "loading" && (
        <p className="pdf-preview-status" role="status" aria-live="polite">
          {state.pageCount ? `${state.renderedCount}/${expectedRenderedPages}쪽 렌더링 중...` : "PDF 미리보기를 준비하는 중..."}
        </p>
      )}
      {state.error && <p className="file-preview-error">{state.error}</p>}
      {truncated && (
        <p className="pdf-preview-status">
          안전한 미리보기를 위해 {state.renderedCount}/{expectedRenderedPages}쪽만 표시했습니다. 전체 파일은 다운로드해서 확인해주세요.
        </p>
      )}
    </div>
  );
}
