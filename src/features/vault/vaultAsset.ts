import { base64ToBytes, bytesToBase64 } from "../../lib/crypto";

export const VAULT_ASSET_FORMAT_VERSION = 1 as const;

// Assets are stored inside the same encrypted Firestore note envelope as the
// rest of the Vault. The raw limit leaves room for base64 expansion, JSON,
// AES-GCM expansion and the encrypted revision snapshot under Firestore's
// document limit. Larger files must not silently spill into plaintext storage.
export const MAX_INLINE_VAULT_ASSET_BYTES = 350 * 1024;

export interface VaultAssetPayloadV1 {
  version: typeof VAULT_ASSET_FORMAT_VERSION;
  byteLength: number;
  data: string;
  mimeType: string;
}

export interface DecodedVaultAsset {
  bytes: Uint8Array;
  mimeType: string;
}

export type SafeVaultAssetPreviewKind = "image" | "pdf";

const MIME_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export function normalizeVaultAssetMimeType(value: string | undefined) {
  const normalized = value?.trim().toLocaleLowerCase("en-US") ?? "";
  return MIME_TYPE_PATTERN.test(normalized) ? normalized : "application/octet-stream";
}

export function encodeVaultAsset(bytes: Uint8Array, mimeType?: string) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_INLINE_VAULT_ASSET_BYTES) {
    throw new Error(`첨부 파일은 ${Math.floor(MAX_INLINE_VAULT_ASSET_BYTES / 1024)}KB 이하만 Vault에 암호화해 저장할 수 있습니다.`);
  }
  return JSON.stringify({
    version: VAULT_ASSET_FORMAT_VERSION,
    byteLength: bytes.byteLength,
    data: bytesToBase64(bytes),
    mimeType: normalizeVaultAssetMimeType(mimeType)
  } satisfies VaultAssetPayloadV1);
}

export function decodeVaultAsset(source: string): DecodedVaultAsset {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("암호화 첨부 데이터 형식을 확인할 수 없습니다.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("암호화 첨부 데이터 형식을 확인할 수 없습니다.");
  }
  const candidate = parsed as Partial<VaultAssetPayloadV1>;
  if (
    candidate.version !== VAULT_ASSET_FORMAT_VERSION
    || !Number.isSafeInteger(candidate.byteLength)
    || (candidate.byteLength ?? -1) < 0
    || (candidate.byteLength ?? 0) > MAX_INLINE_VAULT_ASSET_BYTES
    || typeof candidate.data !== "string"
    || candidate.data.length > Math.ceil(MAX_INLINE_VAULT_ASSET_BYTES / 3) * 4
    || !BASE64_PATTERN.test(candidate.data)
    || typeof candidate.mimeType !== "string"
    || candidate.mimeType !== normalizeVaultAssetMimeType(candidate.mimeType)
  ) {
    throw new Error("암호화 첨부 데이터 형식을 확인할 수 없습니다.");
  }

  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(candidate.data);
  } catch {
    throw new Error("암호화 첨부 데이터 형식을 확인할 수 없습니다.");
  }
  if (bytes.byteLength !== candidate.byteLength || bytesToBase64(bytes) !== candidate.data) {
    throw new Error("암호화 첨부 데이터가 손상되었습니다.");
  }
  return { bytes, mimeType: candidate.mimeType };
}

function startsWith(bytes: Uint8Array, signature: readonly number[]) {
  return bytes.byteLength >= signature.length
    && signature.every((value, index) => bytes[index] === value);
}

/**
 * Allows only static raster images with matching signatures and PDFs. SVG,
 * HTML and mismatched MIME claims remain download-only and are never embedded.
 */
export function safeVaultAssetPreviewKind(asset: DecodedVaultAsset): SafeVaultAssetPreviewKind | null {
  if (
    asset.mimeType === "image/png"
    && startsWith(asset.bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  ) {
    return "image";
  }
  if (
    asset.mimeType === "image/jpeg"
    && startsWith(asset.bytes, [0xff, 0xd8, 0xff])
  ) {
    return "image";
  }
  if (
    asset.mimeType === "image/webp"
    && startsWith(asset.bytes, [0x52, 0x49, 0x46, 0x46])
    && asset.bytes.byteLength >= 12
    && startsWith(asset.bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])
  ) {
    return "image";
  }
  if (
    asset.mimeType === "application/pdf"
    && startsWith(asset.bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])
  ) {
    return "pdf";
  }
  return null;
}
