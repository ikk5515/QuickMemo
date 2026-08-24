import { safeRasterMimeType, type SafeRasterMimeType } from "../../lib/safeRasterImage";
import {
  MAX_INLINE_VAULT_ASSET_BYTES,
  safeVaultAssetPreviewKind
} from "./vaultAsset";

export const MAX_VAULT_CLIPBOARD_IMAGES = 8;

export interface PreparedVaultClipboardImage {
  bytes: Uint8Array;
  extension: "jpg" | "png" | "webp";
  mimeType: SafeRasterMimeType;
}

interface ClipboardImageTransfer {
  files?: ArrayLike<File> | null;
  items?: ArrayLike<{
    getAsFile(): File | null;
    kind: string;
    type: string;
  }> | null;
}

function imageFilesFromItems(items: ClipboardImageTransfer["items"]) {
  return Array.from(items ?? []).flatMap((item) => {
    if (item.kind !== "file" || !item.type.toLocaleLowerCase("en-US").startsWith("image/")) {
      return [];
    }
    const file = item.getAsFile();
    return file ? [file] : [];
  });
}

/**
 * Clipboard implementations expose image files through either `items` or
 * `files`. Prefer `items` so the same image is not uploaded twice when a
 * browser populates both collections.
 */
export function vaultClipboardImageFiles(transfer: ClipboardImageTransfer | null) {
  if (!transfer) return [];
  const itemFiles = imageFilesFromItems(transfer.items);
  const candidates = itemFiles.length ? itemFiles : Array.from(transfer.files ?? []);
  return candidates.filter((file) => file.type.toLocaleLowerCase("en-US").startsWith("image/"));
}

function extensionForMimeType(mimeType: SafeRasterMimeType): PreparedVaultClipboardImage["extension"] {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

export async function prepareVaultClipboardImages(
  files: readonly File[]
): Promise<PreparedVaultClipboardImage[]> {
  if (!files.length) return [];
  if (files.length > MAX_VAULT_CLIPBOARD_IMAGES) {
    throw new Error(`이미지는 한 번에 ${MAX_VAULT_CLIPBOARD_IMAGES}개까지 붙여넣을 수 있습니다.`);
  }

  const prepared: PreparedVaultClipboardImage[] = [];
  try {
    for (const file of files) {
      const mimeType = safeRasterMimeType(file.type);
      if (!mimeType) {
        throw new Error("붙여넣기는 정적 PNG, JPG, WEBP 이미지만 지원합니다.");
      }
      if (!Number.isSafeInteger(file.size) || file.size <= 0) {
        throw new Error("빈 이미지나 크기를 확인할 수 없는 이미지는 붙여넣을 수 없습니다.");
      }
      if (file.size > MAX_INLINE_VAULT_ASSET_BYTES) {
        throw new Error(`붙여넣은 이미지는 ${Math.floor(MAX_INLINE_VAULT_ASSET_BYTES / 1024)}KB 이하만 Vault에 암호화해 저장할 수 있습니다.`);
      }

      const bytes = new Uint8Array(await file.arrayBuffer());
      if (
        bytes.byteLength !== file.size
        || safeVaultAssetPreviewKind({ bytes, mimeType }) !== "image"
      ) {
        bytes.fill(0);
        throw new Error("이미지 형식이나 크기가 안전한 미리보기 제한을 벗어났습니다.");
      }
      prepared.push({
        bytes,
        extension: extensionForMimeType(mimeType),
        mimeType
      });
    }
    return prepared;
  } catch (error) {
    clearPreparedVaultClipboardImages(prepared);
    throw error;
  }
}

export function clearPreparedVaultClipboardImages(images: readonly PreparedVaultClipboardImage[]) {
  for (const image of images) {
    image.bytes.fill(0);
  }
}

function twoDigits(value: number) {
  return String(value).padStart(2, "0");
}

export function vaultClipboardImageBaseTitle(
  image: Pick<PreparedVaultClipboardImage, "extension">,
  now: Date,
  index: number,
  total: number
) {
  const date = [now.getFullYear(), twoDigits(now.getMonth() + 1), twoDigits(now.getDate())].join("-");
  const time = [twoDigits(now.getHours()), twoDigits(now.getMinutes()), twoDigits(now.getSeconds())].join("-");
  const ordinal = total > 1 ? ` ${index + 1}` : "";
  return `붙여넣은 이미지 ${date} ${time}${ordinal}.${image.extension}`;
}

function collisionKey(value: string) {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

export function reserveVaultClipboardImageTitles(
  existingTitles: Iterable<string>,
  images: readonly Pick<PreparedVaultClipboardImage, "extension">[],
  now = new Date()
) {
  const reserved = new Set(Array.from(existingTitles, collisionKey));
  return images.map((image, index) => {
    const base = vaultClipboardImageBaseTitle(image, now, index, images.length);
    const extension = `.${image.extension}`;
    const stem = base.slice(0, -extension.length);
    let title = base;
    let suffix = 2;
    while (reserved.has(collisionKey(title))) {
      title = `${stem} ${suffix}${extension}`;
      suffix += 1;
    }
    reserved.add(collisionKey(title));
    return title;
  });
}

export function vaultClipboardImageEmbedSource(titles: readonly string[]) {
  for (const title of titles) {
    if (!title || /[\r\n|#]/u.test(title) || title.includes("[[") || title.includes("]]")) {
      throw new Error("붙여넣은 이미지의 안전한 내부 링크를 만들 수 없습니다.");
    }
  }
  return titles.map((title) => `![[${title}]]`).join("\n");
}
