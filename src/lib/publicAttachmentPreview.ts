export interface PublicAttachmentPreviewState {
  bytes?: Uint8Array;
  fileName: string;
  fallbackHtml?: string;
  html?: string;
  kind: "docx" | "html" | "hwp" | "image" | "pdf" | "text" | "unsupported";
  label: string;
  srcDoc?: string;
  text?: string;
  url?: string;
}

export const previewableAttachmentExtensions = new Set(["pdf", "txt", "md", "csv", "json", "doc", "docx", "hwp", "hwpx", "xlsx"]);
export const textPreviewAttachmentExtensions = new Set(["txt", "md", "csv", "json"]);
export const legacyBinaryPreviewAttachmentExtensions = new Set(["doc"]);

const maxTextPreviewCharacters = 120_000;
export const maxTextAttachmentPreviewBytes = 512 * 1024;

export function decodeTextAttachmentPreview(bytes: Uint8Array, extension: string) {
  const previewBytes = bytes.subarray(0, Math.min(bytes.byteLength, maxTextAttachmentPreviewBytes));
  const decodedText = decodeReadableBytes(previewBytes);

  if (extension === "json" && bytes.byteLength <= maxTextAttachmentPreviewBytes) {
    try {
      return JSON.stringify(JSON.parse(decodedText), null, 2).slice(0, maxTextPreviewCharacters);
    } catch {
      return decodedText.slice(0, maxTextPreviewCharacters);
    }
  }

  return decodedText.slice(0, maxTextPreviewCharacters);
}

export function legacyBinaryPreviewMessage(extension: string) {
  const upperExtension = extension.toUpperCase();

  return [
    `${upperExtension} 파일은 구형 복합 바이너리 문서라 브라우저 내부에서 양식까지 안전하게 렌더링할 수 없습니다.`,
    "깨진 바이너리 문자를 미리보기로 노출하지 않도록 앱 안에서는 원본 다운로드 확인만 제공합니다.",
    extension === "hwp"
      ? "양식 미리보기가 필요하면 HWPX 또는 PDF로 변환해 업로드해주세요."
      : "양식 미리보기가 필요하면 DOCX 또는 PDF로 변환해 업로드해주세요."
  ].join("\n");
}

function decodeReadableBytes(bytes: Uint8Array) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return normalizeDecodedPreviewText(new TextDecoder("utf-16le", { fatal: false }).decode(bytes.subarray(2)));
  }

  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return normalizeDecodedPreviewText(new TextDecoder("utf-16be", { fatal: false }).decode(bytes.subarray(2)));
  }

  let evenNullBytes = 0;
  let oddNullBytes = 0;

  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0) {
      if (index % 2 === 0) {
        evenNullBytes += 1;
      } else {
        oddNullBytes += 1;
      }
    }
  }

  const likelyUtf16Threshold = Math.max(2, Math.floor(bytes.length / 10));

  if (oddNullBytes >= likelyUtf16Threshold && oddNullBytes > evenNullBytes * 3) {
    return normalizeDecodedPreviewText(new TextDecoder("utf-16le", { fatal: false }).decode(bytes));
  }

  if (evenNullBytes >= likelyUtf16Threshold && evenNullBytes > oddNullBytes * 3) {
    return normalizeDecodedPreviewText(new TextDecoder("utf-16be", { fatal: false }).decode(bytes));
  }

  try {
    return normalizeDecodedPreviewText(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    const utf8Text = normalizeDecodedPreviewText(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
    const utf16Text = normalizeDecodedPreviewText(new TextDecoder("utf-16le", { fatal: false }).decode(bytes));
    const utf8ReplacementCount = countReplacementCharacters(utf8Text);
    const utf16ReplacementCount = countReplacementCharacters(utf16Text);

    return utf16ReplacementCount < utf8ReplacementCount ? utf16Text : utf8Text;
  }
}

function countReplacementCharacters(value: string) {
  return Array.from(value).filter((character) => character === "\ufffd").length;
}

function normalizeDecodedPreviewText(value: string) {
  let normalized = "";
  let segmentStart = 0;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const removableControl =
      (code < 32 && code !== 9 && code !== 10 && code !== 13)
      || code === 127;

    if (removableControl) {
      normalized += value.slice(segmentStart, index);
      segmentStart = index + 1;
    }
  }

  return `${normalized}${value.slice(segmentStart)}`.trim();
}
