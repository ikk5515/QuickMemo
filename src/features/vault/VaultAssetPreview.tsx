import { useEffect, useState } from "react";
import { safeVaultAssetPreviewKind, type DecodedVaultAsset } from "./vaultAsset";
import "./asset.css";

interface SharedAssetObjectUrl {
  references: number;
  url: string;
}

const sharedAssetObjectUrls = new WeakMap<DecodedVaultAsset, SharedAssetObjectUrl>();

function assetBlobPart(asset: DecodedVaultAsset): ArrayBuffer {
  return asset.bytes.buffer instanceof ArrayBuffer
    ? asset.bytes.buffer.slice(asset.bytes.byteOffset, asset.bytes.byteOffset + asset.bytes.byteLength)
    : Uint8Array.from(asset.bytes).buffer;
}

function acquireAssetObjectUrl(asset: DecodedVaultAsset) {
  let shared = sharedAssetObjectUrls.get(asset);
  if (!shared) {
    shared = {
      references: 0,
      url: URL.createObjectURL(new Blob([assetBlobPart(asset)], { type: asset.mimeType }))
    };
    sharedAssetObjectUrls.set(asset, shared);
  }
  shared.references += 1;
  let released = false;
  return {
    url: shared.url,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      shared.references -= 1;
      if (shared.references === 0) {
        URL.revokeObjectURL(shared.url);
        sharedAssetObjectUrls.delete(asset);
      }
    }
  };
}

export interface VaultAssetPreviewProps {
  asset: DecodedVaultAsset;
  className?: string;
  compact?: boolean;
  fileName: string;
  imageMode?: "contain" | "cover" | "repeat";
  pdfFragment?: string;
}

export function safeVaultPdfFragment(value: string | undefined): string {
  if (!value) {
    return "";
  }
  const match = /^#page=([1-9]\d{0,4})(?:&zoom=(\d{2,3}))?$/u.exec(value);
  if (!match) {
    return "";
  }
  const zoom = match[2] ? Number(match[2]) : null;
  if (zoom !== null && (zoom < 50 || zoom > 400)) {
    return "";
  }
  return zoom === null ? `#page=${Number(match[1])}` : `#page=${Number(match[1])}&zoom=${zoom}`;
}

/**
 * Renders decrypted bytes only through a short-lived blob URL. Executable and
 * mismatched formats are download-only; every replacement and unmount revokes
 * the previous URL so decrypted objects do not accumulate in browser memory.
 */
export function VaultAssetPreview({
  asset,
  className = "",
  compact = false,
  fileName,
  imageMode = "contain",
  pdfFragment
}: VaultAssetPreviewProps) {
  const [objectUrlState, setObjectUrlState] = useState<{
    asset: DecodedVaultAsset;
    url: string;
  } | null>(null);
  const previewKind = safeVaultAssetPreviewKind(asset);
  const objectUrl = objectUrlState?.asset === asset ? objectUrlState.url : null;

  useEffect(() => {
    const acquired = acquireAssetObjectUrl(asset);
    setObjectUrlState({ asset, url: acquired.url });
    return acquired.release;
  }, [asset]);

  return (
    <section className={`vault-asset-preview ${compact ? "vault-asset-preview--compact" : ""} ${className}`.trim()}>
      {objectUrl && previewKind === "image" && imageMode === "repeat" ? (
        <div
          aria-label={fileName}
          className="vault-asset-preview-repeat-image"
          role="img"
          style={{ backgroundImage: `url(${JSON.stringify(objectUrl)})` }}
        />
      ) : null}
      {objectUrl && previewKind === "image" && imageMode !== "repeat" ? (
        <img alt={fileName} draggable={false} loading="lazy" src={objectUrl} style={{ objectFit: imageMode }} />
      ) : null}
      {objectUrl && previewKind === "pdf" ? (
        <iframe
          referrerPolicy="no-referrer"
          sandbox=""
          src={`${objectUrl}${safeVaultPdfFragment(pdfFragment)}`}
          title={`${fileName} PDF 미리보기`}
        />
      ) : null}
      {!previewKind ? (
        <span className="vault-asset-preview-unsupported" role="status">
          이 형식은 보안을 위해 미리보지 않습니다.
        </span>
      ) : null}
      {objectUrl ? (
        <a download={fileName} href={objectUrl}>다운로드</a>
      ) : (
        <span aria-live="polite">첨부 준비 중…</span>
      )}
    </section>
  );
}
