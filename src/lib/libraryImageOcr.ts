import { maxAttachmentPreviewBytes, maxAttachmentPreviewLabel } from "./attachments";
import { libraryOcrTextMaxLength } from "./libraryContent";
import { safeRasterImageBytes, safeRasterMimeType } from "./safeRasterImage";

export type LibraryOcrLanguage = "kor" | "eng";

export interface LibraryOcrProgress {
  progress: number;
  status: "engine" | "language" | "recognizing";
}

export interface LibraryImageOcrOptions {
  languages?: LibraryOcrLanguage[];
  onProgress?: (progress: LibraryOcrProgress) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface LibraryImageOcrResult {
  confidence: number | null;
  languages: LibraryOcrLanguage[];
  text: string;
}

const defaultOcrTimeoutMs = 120_000;
const minimumOcrTimeoutMs = 10_000;
const maximumOcrTimeoutMs = 5 * 60_000;
const nullCharacter = String.fromCharCode(0);

export function normalizeLibraryOcrLanguages(value: unknown): LibraryOcrLanguage[] {
  if (!Array.isArray(value)) {
    return ["kor", "eng"];
  }

  const languages = Array.from(
    new Set(value.filter((language): language is LibraryOcrLanguage => language === "kor" || language === "eng"))
  );

  return languages.length ? languages : ["kor", "eng"];
}

export function validateLibraryOcrImage(bytes: Uint8Array, mimeType: string) {
  if (!bytes.byteLength) {
    return "빈 이미지는 OCR을 실행할 수 없습니다.";
  }

  if (bytes.byteLength > maxAttachmentPreviewBytes) {
    return `${maxAttachmentPreviewLabel} 이하 이미지만 OCR을 실행할 수 있습니다.`;
  }

  const safeMimeType = safeRasterMimeType(mimeType);

  if (!safeMimeType || !safeRasterImageBytes(bytes, safeMimeType)) {
    return "PNG, JPEG, WebP 형식의 안전한 정적 이미지만 OCR을 실행할 수 있습니다.";
  }

  return null;
}

function normalizedProgress(status: string, progress: number): LibraryOcrProgress {
  const normalizedStatus = status.toLowerCase();
  const phase = normalizedStatus.includes("recogniz")
    ? "recognizing"
    : normalizedStatus.includes("language") || normalizedStatus.includes("initializ")
      ? "language"
      : "engine";

  return {
    progress: Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0,
    status: phase
  };
}

function abortError(message = "OCR 작업을 취소했습니다.") {
  return new DOMException(message, "AbortError");
}

export async function runLibraryImageOcr(
  image: Blob,
  options: LibraryImageOcrOptions = {}
): Promise<LibraryImageOcrResult> {
  const bytes = new Uint8Array(await image.arrayBuffer());
  const validationError = validateLibraryOcrImage(bytes, image.type);

  if (validationError) {
    throw new Error(validationError);
  }

  const languages = normalizeLibraryOcrLanguages(options.languages);
  const timeoutMs = Math.min(
    maximumOcrTimeoutMs,
    Math.max(minimumOcrTimeoutMs, options.timeoutMs ?? defaultOcrTimeoutMs)
  );
  let worker: Awaited<ReturnType<typeof import("tesseract.js")["createWorker"]>> | null = null;
  let cancelled = options.signal?.aborted ?? false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let rejectCancellation: ((reason: Error) => void) | null = null;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const stop = (reason: Error) => {
    if (cancelled) {
      return;
    }

    cancelled = true;
    rejectCancellation?.(reason);
    void worker?.terminate().catch(() => undefined);
  };
  const abortHandler = () => stop(abortError());

  options.signal?.addEventListener("abort", abortHandler, { once: true });
  timeoutId = setTimeout(() => stop(new Error("OCR 처리 시간이 초과되었습니다. 다시 시도해주세요.")), timeoutMs);

  if (cancelled) {
    options.signal?.removeEventListener("abort", abortHandler);
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    throw abortError();
  }

  try {
    const tesseract = await Promise.race([import("tesseract.js"), cancellation]);
    const workerPromise = tesseract.createWorker(languages, tesseract.OEM.LSTM_ONLY, {
      corePath: "/library-ocr/v7/core",
      langPath: "/library-ocr/v7/lang",
      workerPath: "/api/library-ocr-worker?v=7.0.0",
      workerBlobURL: false,
      gzip: true,
      legacyCore: false,
      legacyLang: false,
      logger: ({ progress, status }) => options.onProgress?.(normalizedProgress(status, progress)),
      errorHandler: () => undefined
    });

    void workerPromise.then((createdWorker) => {
      if (cancelled) {
        void createdWorker.terminate().catch(() => undefined);
      }
    }).catch(() => undefined);
    worker = await Promise.race([workerPromise, cancellation]);

    const result = await Promise.race([worker.recognize(image), cancellation]);
    const text = result.data.text
      .normalize("NFKC")
      .replaceAll(nullCharacter, "")
      .replace(/\r\n?/gu, "\n")
      .trim()
      .slice(0, libraryOcrTextMaxLength);
    const confidence = Number.isFinite(result.data.confidence)
      ? Math.min(100, Math.max(0, result.data.confidence))
      : null;

    return { confidence, languages, text };
  } finally {
    cancelled = true;
    options.signal?.removeEventListener("abort", abortHandler);
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    await worker?.terminate().catch(() => undefined);
  }
}
