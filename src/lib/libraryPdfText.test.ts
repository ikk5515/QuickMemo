import { describe, expect, it, vi } from "vitest";
import {
  LibraryPdfTextError,
  extractLibraryPdfText,
  maxLibraryPdfBytes,
  maxLibraryPdfCharacters,
  maxLibraryPdfItemsPerPage,
  maxLibraryPdfPages,
  type LibraryPdfDocumentAdapter,
  type LibraryPdfJsAdapter,
  type LibraryPdfLoadingTaskAdapter,
  type LibraryPdfPageAdapter
} from "./libraryPdfText";

function createPdfFixture(
  pageItems: unknown[][],
  options: { numPages?: number; getPage?: LibraryPdfDocumentAdapter["getPage"] } = {}
) {
  const pages = pageItems.map((items) => ({
    cleanup: vi.fn(),
    getTextContent: vi.fn(async () => ({ items }))
  } satisfies LibraryPdfPageAdapter));
  const destroyDocument = vi.fn(async () => undefined);
  const getPage = options.getPage ?? vi.fn(async (pageNumber: number) => {
    const page = pages[pageNumber - 1];
    if (!page) {
      throw new Error(`Missing page ${pageNumber}`);
    }
    return page;
  });
  const documentAdapter: LibraryPdfDocumentAdapter = {
    numPages: options.numPages ?? pages.length,
    destroy: destroyDocument,
    getPage
  };
  const destroyLoadingTask = vi.fn(async () => undefined);
  const loadingTask: LibraryPdfLoadingTaskAdapter = {
    destroy: destroyLoadingTask,
    promise: Promise.resolve(documentAdapter)
  };
  const getDocument = vi.fn((options: Record<string, unknown>) => {
    void options;
    return loadingTask;
  });
  const loadPdfJs = vi.fn(async (): Promise<LibraryPdfJsAdapter> => ({ getDocument }));

  return {
    pages,
    getPage,
    destroyDocument,
    destroyLoadingTask,
    getDocument,
    loadPdfJs,
    loadingTask,
    documentAdapter
  };
}

describe("extractLibraryPdfText", () => {
  it("extracts ordered page text with hardened PDF.js options and releases every resource", async () => {
    const fixture = createPdfFixture([
      [{ str: "첫 페이지", hasEOL: true }, { str: "둘째 줄" }],
      [{ str: "두 번째 페이지" }]
    ]);
    const source = new Uint8Array([1, 2, 3, 4]);

    const result = await extractLibraryPdfText(source, { loadPdfJs: fixture.loadPdfJs });

    expect(result).toMatchObject({
      text: "첫 페이지\n둘째 줄\n\n두 번째 페이지",
      pageCount: 2,
      processedPageCount: 2,
      textItemCount: 3,
      truncated: false,
      likelyScanned: false
    });
    expect(fixture.getDocument).toHaveBeenCalledTimes(1);
    expect(fixture.getDocument).toHaveBeenCalledWith(expect.objectContaining({
      disableAutoFetch: true,
      disableFontFace: true,
      disableRange: true,
      disableStream: true,
      enableScripting: false,
      enableXfa: false,
      isEvalSupported: false,
      isImageDecoderSupported: false,
      stopAtErrors: true,
      useSystemFonts: false,
      useWorkerFetch: false
    }));
    const passedBytes = fixture.getDocument.mock.calls[0]?.[0].data;
    expect(passedBytes).toBeInstanceOf(Uint8Array);
    expect(passedBytes).not.toBe(source);
    expect(fixture.pages[0]?.cleanup).toHaveBeenCalledTimes(1);
    expect(fixture.pages[1]?.cleanup).toHaveBeenCalledTimes(1);
    expect(fixture.destroyDocument).toHaveBeenCalledTimes(1);
    expect(fixture.destroyLoadingTask).not.toHaveBeenCalled();
  });

  it("marks pages without meaningful embedded text as likely scanned", async () => {
    const fixture = createPdfFixture([[], [{ type: "beginMarkedContent" }]]);

    const result = await extractLibraryPdfText(new Uint8Array([1]), { loadPdfJs: fixture.loadPdfJs });

    expect(result.text).toBe("");
    expect(result.textItemCount).toBe(0);
    expect(result.likelyScanned).toBe(true);
  });

  it("processes at most 200 pages and reports truncation", async () => {
    const cleanup = vi.fn();
    const getPage = vi.fn(async (pageNumber: number): Promise<LibraryPdfPageAdapter> => ({
      cleanup,
      getTextContent: async () => ({ items: [{ str: `페이지 ${pageNumber}` }] })
    }));
    const fixture = createPdfFixture([], { numPages: maxLibraryPdfPages + 20, getPage });

    const result = await extractLibraryPdfText(new Uint8Array([1]), { loadPdfJs: fixture.loadPdfJs });

    expect(result.pageCount).toBe(220);
    expect(result.processedPageCount).toBe(maxLibraryPdfPages);
    expect(result.truncated).toBe(true);
    expect(getPage).toHaveBeenCalledTimes(maxLibraryPdfPages);
    expect(cleanup).toHaveBeenCalledTimes(maxLibraryPdfPages);
  });

  it("caps text items processed from one page", async () => {
    const items = Array.from({ length: maxLibraryPdfItemsPerPage + 1 }, () => ({ str: "가" }));
    const fixture = createPdfFixture([items]);

    const result = await extractLibraryPdfText(new Uint8Array([1]), { loadPdfJs: fixture.loadPdfJs });

    expect(result.pages[0]).toMatchObject({
      itemCount: maxLibraryPdfItemsPerPage,
      truncated: true
    });
    expect(result.truncated).toBe(true);
  });

  it("caps total extracted characters without splitting a surrogate pair", async () => {
    const fixture = createPdfFixture([[{ str: `${"a".repeat(maxLibraryPdfCharacters - 1)}😀` }]]);

    const result = await extractLibraryPdfText(new Uint8Array([1]), { loadPdfJs: fixture.loadPdfJs });

    expect(result.characterCount).toBeLessThanOrEqual(maxLibraryPdfCharacters);
    expect(result.text.endsWith("\ud83d")).toBe(false);
    expect(result.truncated).toBe(true);
  });

  it("rejects PDFs above 25MB before loading PDF.js", async () => {
    const fixture = createPdfFixture([]);
    const oversized = new Uint8Array(maxLibraryPdfBytes + 1);

    await expect(extractLibraryPdfText(oversized, { loadPdfJs: fixture.loadPdfJs })).rejects.toThrow(
      LibraryPdfTextError
    );
    expect(fixture.loadPdfJs).not.toHaveBeenCalled();
  });

  it("aborts an in-flight page extraction and still cleans up the page and document", async () => {
    let extractionStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      extractionStarted = resolve;
    });
    const neverResolves = new Promise<{ items: unknown[] }>(() => undefined);
    const page: LibraryPdfPageAdapter = {
      cleanup: vi.fn(),
      getTextContent: vi.fn(() => {
        extractionStarted?.();
        return neverResolves;
      })
    };
    const fixture = createPdfFixture([], {
      numPages: 1,
      getPage: vi.fn(async () => page)
    });
    const controller = new AbortController();
    const extraction = extractLibraryPdfText(new Uint8Array([1]), {
      loadPdfJs: fixture.loadPdfJs,
      signal: controller.signal
    });

    await started;
    controller.abort();

    await expect(extraction).rejects.toMatchObject({ name: "AbortError" });
    expect(page.cleanup).toHaveBeenCalledTimes(1);
    expect(fixture.destroyDocument).toHaveBeenCalledTimes(1);
  });

  it("times out a stalled text layer and destroys the PDF resources", async () => {
    const page: LibraryPdfPageAdapter = {
      cleanup: vi.fn(),
      getTextContent: vi.fn(() => new Promise<{ items: unknown[] }>(() => undefined))
    };
    const fixture = createPdfFixture([], {
      numPages: 1,
      getPage: vi.fn(async () => page)
    });

    await expect(extractLibraryPdfText(new Uint8Array([1]), {
      loadPdfJs: fixture.loadPdfJs,
      timeoutMs: 100
    })).rejects.toThrow("시간이 초과");
    expect(page.cleanup).toHaveBeenCalledTimes(1);
    expect(fixture.destroyDocument).toHaveBeenCalledTimes(1);
  });

  it("cleans up after a PDF text parsing failure", async () => {
    const page: LibraryPdfPageAdapter = {
      cleanup: vi.fn(),
      getTextContent: vi.fn(async () => {
        throw new Error("broken text stream");
      })
    };
    const fixture = createPdfFixture([], {
      numPages: 1,
      getPage: vi.fn(async () => page)
    });

    await expect(
      extractLibraryPdfText(new Uint8Array([1]), { loadPdfJs: fixture.loadPdfJs })
    ).rejects.toThrow("broken text stream");
    expect(page.cleanup).toHaveBeenCalledTimes(1);
    expect(fixture.destroyDocument).toHaveBeenCalledTimes(1);
  });

  it("destroys the loading task when document loading fails", async () => {
    const fixture = createPdfFixture([]);
    fixture.loadingTask.promise = Promise.reject(new Error("invalid pdf"));

    await expect(
      extractLibraryPdfText(new Uint8Array([1]), { loadPdfJs: fixture.loadPdfJs })
    ).rejects.toThrow("invalid pdf");
    expect(fixture.destroyLoadingTask).toHaveBeenCalledTimes(1);
    expect(fixture.destroyDocument).not.toHaveBeenCalled();
  });
});
