export const maxLibraryPdfBytes = 25 * 1024 * 1024;
export const maxLibraryPdfPages = 200;
export const maxLibraryPdfCharacters = 500_000;
export const maxLibraryPdfItemsPerPage = 20_000;

export interface LibraryPdfTextPage {
  pageNumber: number;
  text: string;
  itemCount: number;
  truncated: boolean;
}

export interface LibraryPdfTextResult {
  text: string;
  pageCount: number;
  processedPageCount: number;
  characterCount: number;
  textItemCount: number;
  pages: LibraryPdfTextPage[];
  truncated: boolean;
  likelyScanned: boolean;
}

interface LibraryPdfTextItem {
  str: string;
  hasEOL?: boolean;
}

export interface LibraryPdfPageAdapter {
  cleanup: () => void;
  getTextContent: (options?: Record<string, unknown>) => Promise<{ items: unknown[] }>;
}

export interface LibraryPdfDocumentAdapter {
  numPages: number;
  destroy: () => void | Promise<void>;
  getPage: (pageNumber: number) => Promise<LibraryPdfPageAdapter>;
}

export interface LibraryPdfLoadingTaskAdapter {
  destroy: () => void | Promise<void>;
  promise: Promise<LibraryPdfDocumentAdapter>;
}

export interface LibraryPdfJsAdapter {
  getDocument: (options: Record<string, unknown>) => LibraryPdfLoadingTaskAdapter;
}

export interface ExtractLibraryPdfTextOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  loadPdfJs?: () => Promise<LibraryPdfJsAdapter>;
}

export class LibraryPdfTextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LibraryPdfTextError";
  }
}

// eslint-disable-next-line no-control-regex
const disallowedPdfTextCharactersPattern = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g;
const defaultLibraryPdfTimeoutMs = 60_000;
const minimumLibraryPdfTimeoutMs = 100;
const maximumLibraryPdfTimeoutMs = 2 * 60_000;

async function defaultLoadPdfJs(): Promise<LibraryPdfJsAdapter> {
  const [pdfjs, workerModule] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.mjs?url")
  ]);

  pdfjs.GlobalWorkerOptions.workerSrc = workerModule.default;
  return {
    getDocument: (options) => pdfjs.getDocument(options) as unknown as LibraryPdfLoadingTaskAdapter
  };
}

function abortError() {
  const error = new Error("PDF 텍스트 추출이 취소되었습니다.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw abortError();
  }
}

function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(abortError());
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);

    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      }
    );
  });
}

function isPdfTextItem(value: unknown): value is LibraryPdfTextItem {
  return typeof value === "object"
    && value !== null
    && "str" in value
    && typeof (value as { str?: unknown }).str === "string";
}

function normalizePdfTextItem(value: string, maximumSourceCharacters: number) {
  return truncateWithoutSplittingSurrogate(value, maximumSourceCharacters)
    .normalize("NFC")
    .replace(disallowedPdfTextCharactersPattern, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t ]+/g, " ")
    .trim();
}

function normalizePdfPageText(value: string) {
  return value
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncateWithoutSplittingSurrogate(value: string, maxCharacters: number) {
  if (value.length <= maxCharacters) {
    return value;
  }

  let end = Math.max(0, maxCharacters);
  const previousCodeUnit = value.charCodeAt(end - 1);
  const nextCodeUnit = value.charCodeAt(end);
  if (previousCodeUnit >= 0xd800 && previousCodeUnit <= 0xdbff && nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
    end -= 1;
  }
  return value.slice(0, end);
}

async function ignoreCleanupFailure(cleanup: () => void | Promise<void>) {
  try {
    await cleanup();
  } catch {
    // Cleanup is best-effort and must not hide the extraction or abort result.
  }
}

function copyAndValidatePdfBytes(input: ArrayBuffer | Uint8Array) {
  if (input.byteLength === 0) {
    throw new LibraryPdfTextError("비어 있는 PDF는 처리할 수 없습니다.");
  }
  if (input.byteLength > maxLibraryPdfBytes) {
    throw new LibraryPdfTextError("PDF 파일은 25MB 이하만 텍스트를 추출할 수 있습니다.");
  }
  return input instanceof Uint8Array ? input.slice() : new Uint8Array(input.slice(0));
}

function extractPageText(items: unknown[], remainingCharacters: number) {
  const chunks: string[] = [];
  const itemLimit = Math.min(items.length, maxLibraryPdfItemsPerPage);
  let pageCharacters = 0;
  let itemCount = 0;
  let previousEndedLine = true;
  let truncated = items.length > maxLibraryPdfItemsPerPage;

  const append = (value: string) => {
    const available = remainingCharacters - pageCharacters;
    if (available <= 0) {
      truncated = true;
      return false;
    }
    const bounded = truncateWithoutSplittingSurrogate(value, available);
    if (bounded.length < value.length) {
      truncated = true;
    }
    if (bounded) {
      chunks.push(bounded);
      pageCharacters += bounded.length;
    }
    return bounded.length === value.length;
  };

  for (let index = 0; index < itemLimit; index += 1) {
    const item = items[index];
    if (!isPdfTextItem(item)) {
      continue;
    }

    const remaining = Math.max(0, remainingCharacters - pageCharacters);
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const maximumSourceCharacters = Math.min(maxLibraryPdfCharacters, remaining + 1024);
    const text = normalizePdfTextItem(item.str, maximumSourceCharacters);
    truncated ||= item.str.length > maximumSourceCharacters;
    if (!text) {
      continue;
    }
    itemCount += 1;

    if (pageCharacters > 0 && !previousEndedLine && !append(" ")) {
      break;
    }
    if (!append(text)) {
      break;
    }

    previousEndedLine = item.hasEOL === true;
    if (previousEndedLine && !append("\n")) {
      break;
    }
  }

  const text = normalizePdfPageText(chunks.join(""));
  return { text, itemCount, truncated };
}

export async function extractLibraryPdfText(
  input: ArrayBuffer | Uint8Array,
  options: ExtractLibraryPdfTextOptions = {}
): Promise<LibraryPdfTextResult> {
  const bytes = copyAndValidatePdfBytes(input);
  const loadPdfJs = options.loadPdfJs ?? defaultLoadPdfJs;
  const timeoutMs = Math.min(
    maximumLibraryPdfTimeoutMs,
    Math.max(minimumLibraryPdfTimeoutMs, options.timeoutMs ?? defaultLibraryPdfTimeoutMs)
  );
  const controller = new AbortController();
  let timedOut = false;
  const externalAbortHandler = () => controller.abort();
  if (options.signal?.aborted) {
    controller.abort();
  } else {
    options.signal?.addEventListener("abort", externalAbortHandler, { once: true });
  }
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const signal = controller.signal;
  let loadingTask: LibraryPdfLoadingTaskAdapter | null = null;
  let pdfDocument: LibraryPdfDocumentAdapter | null = null;

  try {
    throwIfAborted(signal);
    const pdfjs = await awaitWithAbort(loadPdfJs(), signal);
    throwIfAborted(signal);

    loadingTask = pdfjs.getDocument({
      data: bytes,
      disableAutoFetch: true,
      disableFontFace: true,
      disableRange: true,
      disableStream: true,
      enableXfa: false,
      enableScripting: false,
      isEvalSupported: false,
      isImageDecoderSupported: false,
      stopAtErrors: true,
      useSystemFonts: false,
      useWorkerFetch: false
    });
    pdfDocument = await awaitWithAbort(loadingTask.promise, signal);
    throwIfAborted(signal);

    if (!Number.isSafeInteger(pdfDocument.numPages) || pdfDocument.numPages < 0) {
      throw new LibraryPdfTextError("PDF 페이지 정보를 읽을 수 없습니다.");
    }

    const pageCount = pdfDocument.numPages;
    const pagesToProcess = Math.min(pageCount, maxLibraryPdfPages);
    const pages: LibraryPdfTextPage[] = [];
    const documentChunks: string[] = [];
    let documentCharacters = 0;
    let textItemCount = 0;
    let truncated = pageCount > maxLibraryPdfPages;

    for (let pageNumber = 1; pageNumber <= pagesToProcess; pageNumber += 1) {
      throwIfAborted(signal);
      const page = await awaitWithAbort(pdfDocument.getPage(pageNumber), signal);

      try {
        throwIfAborted(signal);
        const content = await awaitWithAbort(
          page.getTextContent({ disableNormalization: false, includeMarkedContent: false }),
          signal
        );
        throwIfAborted(signal);

        const separatorLength = documentChunks.length > 0 ? 2 : 0;
        const remainingCharacters = Math.max(0, maxLibraryPdfCharacters - documentCharacters - separatorLength);
        const extracted = extractPageText(Array.isArray(content.items) ? content.items : [], remainingCharacters);
        const pageEntry: LibraryPdfTextPage = {
          pageNumber,
          text: extracted.text,
          itemCount: extracted.itemCount,
          truncated: extracted.truncated
        };
        pages.push(pageEntry);
        textItemCount += extracted.itemCount;
        truncated ||= extracted.truncated;

        if (extracted.text) {
          if (documentChunks.length > 0) {
            documentChunks.push("\n\n");
            documentCharacters += 2;
          }
          documentChunks.push(extracted.text);
          documentCharacters += extracted.text.length;
        }

        if (documentCharacters >= maxLibraryPdfCharacters) {
          truncated ||= pageNumber < pageCount;
          break;
        }
      } finally {
        await ignoreCleanupFailure(() => page.cleanup());
      }
    }

    const text = documentChunks.join("");
    const nonWhitespaceCharacters = text.replace(/\s/g, "").length;
    return {
      text,
      pageCount,
      processedPageCount: pages.length,
      characterCount: text.length,
      textItemCount,
      pages,
      truncated,
      likelyScanned: pageCount > 0 && nonWhitespaceCharacters < 12
    };
  } catch (error) {
    if (timedOut && error instanceof Error && error.name === "AbortError") {
      throw new LibraryPdfTextError("PDF 텍스트 추출 시간이 초과되었습니다. 파일 크기나 구조를 확인해주세요.");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    options.signal?.removeEventListener("abort", externalAbortHandler);
    if (pdfDocument) {
      const documentToDestroy = pdfDocument;
      await ignoreCleanupFailure(() => documentToDestroy.destroy());
    } else if (loadingTask) {
      const taskToDestroy = loadingTask;
      await ignoreCleanupFailure(() => taskToDestroy.destroy());
    }
  }
}
