import type { NoteAttachmentDocument } from "../types";

export const maxAttachmentFileBytes = 1_000_000;
export const encryptedAttachmentOverheadBytes = 16;
export const maxEncryptedAttachmentBytes = maxAttachmentFileBytes + encryptedAttachmentOverheadBytes;

export const allowedAttachmentExtensions = [
  "pdf",
  "txt",
  "md",
  "csv",
  "json",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "hwp",
  "hwpx",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif"
] as const;

const allowedAttachmentExtensionSet = new Set<string>(allowedAttachmentExtensions);
const dangerousFileNameCharactersPattern = /[<>:"/\\|?*]/g;
const publicShareAttachmentMimeTypes: Record<string, string> = {
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  gif: "image/gif",
  hwp: "application/x-hwp",
  hwpx: "application/vnd.hancom.hwpx",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  md: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  webp: "image/webp",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
};
const publicShareRasterImageExtensions = new Set(["gif", "jpeg", "jpg", "png", "webp"]);

export function attachmentExtension(fileName: string) {
  const normalizedName = fileName.trim().toLowerCase();
  const dotIndex = normalizedName.lastIndexOf(".");

  if (dotIndex <= 0 || dotIndex === normalizedName.length - 1) {
    return "";
  }

  return normalizedName.slice(dotIndex + 1);
}

export function isAllowedAttachmentExtension(extension: string) {
  return allowedAttachmentExtensionSet.has(extension.toLowerCase());
}

export function safePublicShareAttachmentMimeType(extension: string) {
  return publicShareAttachmentMimeTypes[extension.toLowerCase()] ?? "application/octet-stream";
}

export function isPublicShareRasterImageExtension(extension: string) {
  return publicShareRasterImageExtensions.has(extension.toLowerCase());
}

export function publicShareAttachmentMimeMatchesExtension(extension: string, mimeType: string) {
  return mimeType.trim().toLowerCase() === safePublicShareAttachmentMimeType(extension);
}

export function attachmentValidationError(file: File) {
  const extension = attachmentExtension(file.name);

  if (!extension || !isAllowedAttachmentExtension(extension)) {
    return `허용되지 않는 파일 형식입니다. 허용 확장자: ${allowedAttachmentExtensions.join(", ")}`;
  }

  if (file.size <= 0) {
    return "빈 파일은 첨부할 수 없습니다.";
  }

  if (file.size > maxAttachmentFileBytes) {
    return `파일 크기는 ${formatFileSize(maxAttachmentFileBytes)} 이하만 첨부할 수 있습니다.`;
  }

  return null;
}

export function safeAttachmentBaseName(fileName: string) {
  const extension = attachmentExtension(fileName);
  const baseName = extension ? fileName.slice(0, -(extension.length + 1)) : fileName;
  const safeName = baseName
    .normalize("NFKC")
    .replace(dangerousFileNameCharactersPattern, "_")
    .split("")
    .map((character) => (character.charCodeAt(0) < 32 ? "_" : character))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);

  return safeName || "attachment";
}

export function attachmentDownloadName(attachment: Pick<NoteAttachmentDocument, "fileName" | "extension">) {
  const extension = isAllowedAttachmentExtension(attachment.extension) ? attachment.extension : "bin";
  return `${safeAttachmentBaseName(`${attachment.fileName}.${extension}`)}.${extension}`;
}

export function formatFileSize(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(bytes >= 100 * 1024 ? 0 : 1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
