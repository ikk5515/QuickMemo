import {
  encryptedAttachmentChunkSizeBytes,
  encryptedAttachmentOverheadBytes,
  maxAttachmentFileBytes,
  maxChunkedEncryptedAttachmentBytes,
  maxEncryptedAttachmentChunkCount,
  maxEncryptedAttachmentBytes
} from "./attachments";

export const chunkedAttachmentVersion = 2;
export const chunkedAttachmentAlgorithm = "AES-GCM-CHUNKED";

interface BytesLike {
  toUint8Array: () => Uint8Array;
}

export interface AttachmentEncryptionProgress {
  loaded: number;
  percentage: number;
  total: number;
}

export type AttachmentEncryptionProgressHandler = (progress: AttachmentEncryptionProgress) => void;

export interface SingleAttachmentEncryptionMetadata {
  version: 1;
  algorithm: "AES-GCM";
  encryptedSize: number;
  iv: Uint8Array;
}

export interface ChunkedAttachmentEncryptionMetadata {
  version: 2;
  algorithm: "AES-GCM-CHUNKED";
  chunkCount: number;
  chunkIvs: Uint8Array[];
  chunkSize: number;
  encryptedSize: number;
}

export type AttachmentEncryptionMetadata =
  | SingleAttachmentEncryptionMetadata
  | ChunkedAttachmentEncryptionMetadata;

export interface EncryptedAttachmentBlob {
  blob: Blob;
  metadata: AttachmentEncryptionMetadata;
}

export interface AttachmentCryptoDocument {
  algorithm: "AES-GCM" | "AES-GCM-CHUNKED";
  chunkCount?: number;
  chunkIvs?: Array<BytesLike | Uint8Array>;
  chunkSize?: number;
  encryptedSize?: number;
  iv?: BytesLike | Uint8Array;
  originalSize: number;
  version: 1 | 2;
}

export type EncryptedAttachmentSource =
  | { bytes: Uint8Array; response?: never }
  | { bytes?: never; response: Response };

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer;
  }

  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function randomBytes(length: number) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function bytesLikeToUint8Array(value: BytesLike | Uint8Array | undefined, fieldName: string) {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (value && typeof value.toUint8Array === "function") {
    return value.toUint8Array();
  }

  throw new Error(`${fieldName} 암호화 정보를 찾을 수 없습니다.`);
}

function chunkCountForSize(originalSize: number, chunkSize: number) {
  return Math.ceil(originalSize / chunkSize);
}

function chunkPlainSize(index: number, originalSize: number, chunkSize: number, chunkCount: number) {
  if (index < 0 || index >= chunkCount) {
    throw new Error("첨부파일 chunk 인덱스가 올바르지 않습니다.");
  }

  return index === chunkCount - 1 ? originalSize - chunkSize * (chunkCount - 1) : chunkSize;
}

async function blobArrayBuffer(blob: Blob) {
  if (typeof blob.arrayBuffer === "function") {
    return blob.arrayBuffer();
  }

  if (typeof FileReader !== "undefined") {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();

      reader.onerror = () => reject(reader.error ?? new Error("Blob을 읽지 못했습니다."));
      reader.onload = () => {
        if (reader.result instanceof ArrayBuffer) {
          resolve(reader.result);
          return;
        }

        reject(new Error("Blob 읽기 결과가 올바르지 않습니다."));
      };
      reader.readAsArrayBuffer(blob);
    });
  }

  return new Response(blob).arrayBuffer();
}

function chunkEncryptedSizes(metadata: AttachmentCryptoDocument) {
  const chunkMetadata = normalizedChunkedAttachmentMetadata(metadata);
  return Array.from({ length: chunkMetadata.chunkCount }, (_, index) =>
    chunkPlainSize(index, metadata.originalSize, chunkMetadata.chunkSize, chunkMetadata.chunkCount)
    + encryptedAttachmentOverheadBytes
  );
}

function validateChunkedSize(originalSize: number, encryptedSize: number, chunkSize: number, chunkCount: number) {
  const expectedChunkCount = chunkCountForSize(originalSize, chunkSize);
  const expectedEncryptedSize = originalSize + expectedChunkCount * encryptedAttachmentOverheadBytes;

  if (
    originalSize <= 0
    || originalSize > maxAttachmentFileBytes
    || chunkSize !== encryptedAttachmentChunkSizeBytes
    || chunkCount !== expectedChunkCount
    || chunkCount <= 0
    || chunkCount > maxEncryptedAttachmentChunkCount
    || encryptedSize !== expectedEncryptedSize
    || encryptedSize > maxChunkedEncryptedAttachmentBytes
  ) {
    throw new Error("첨부파일 chunk 암호화 크기가 올바르지 않습니다.");
  }
}

export function isChunkedAttachment(metadata: Pick<AttachmentCryptoDocument, "algorithm" | "version">) {
  return metadata.version === chunkedAttachmentVersion || metadata.algorithm === chunkedAttachmentAlgorithm;
}

export function encryptedAttachmentSizeLimit(metadata: Pick<AttachmentCryptoDocument, "algorithm" | "version">) {
  return isChunkedAttachment(metadata) ? maxChunkedEncryptedAttachmentBytes : maxEncryptedAttachmentBytes;
}

export function normalizedChunkedAttachmentMetadata(metadata: AttachmentCryptoDocument) {
  if (!isChunkedAttachment(metadata)) {
    throw new Error("chunked 첨부파일이 아닙니다.");
  }

  const chunkSize = metadata.chunkSize ?? 0;
  const chunkCount = metadata.chunkCount ?? 0;
  const encryptedSize = metadata.encryptedSize ?? 0;
  const chunkIvs = metadata.chunkIvs ?? [];

  validateChunkedSize(metadata.originalSize, encryptedSize, chunkSize, chunkCount);

  if (chunkIvs.length !== chunkCount) {
    throw new Error("첨부파일 chunk IV 개수가 올바르지 않습니다.");
  }

  return {
    chunkCount,
    chunkIvs: chunkIvs.map((iv) => {
      const bytes = bytesLikeToUint8Array(iv, "chunk IV");

      if (bytes.byteLength !== 12) {
        throw new Error("첨부파일 chunk IV가 올바르지 않습니다.");
      }

      return bytes;
    }),
    chunkSize,
    encryptedSize
  };
}

export async function encryptAttachmentBlob(
  file: Blob,
  key: CryptoKey,
  onProgress?: AttachmentEncryptionProgressHandler
): Promise<EncryptedAttachmentBlob> {
  const originalSize = file.size;

  if (originalSize <= 0 || originalSize > maxAttachmentFileBytes) {
    throw new Error("첨부파일 크기가 올바르지 않습니다.");
  }

  const chunkSize = encryptedAttachmentChunkSizeBytes;
  const chunkCount = chunkCountForSize(originalSize, chunkSize);
  const parts: BlobPart[] = [];
  const chunkIvs: Uint8Array[] = [];
  let encryptedSize = 0;

  for (let index = 0; index < chunkCount; index += 1) {
    const offset = index * chunkSize;
    const plainBytes = new Uint8Array(await blobArrayBuffer(file.slice(offset, Math.min(offset + chunkSize, originalSize))));
    const iv = randomBytes(12);
    const cipherBytes = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      key,
      toArrayBuffer(plainBytes)
    );

    plainBytes.fill(0);
    parts.push(cipherBytes);
    chunkIvs.push(iv);
    encryptedSize += cipherBytes.byteLength;
    onProgress?.({
      loaded: Math.min(originalSize, offset + chunkPlainSize(index, originalSize, chunkSize, chunkCount)),
      percentage: Math.min(100, ((index + 1) / chunkCount) * 100),
      total: originalSize
    });
  }

  validateChunkedSize(originalSize, encryptedSize, chunkSize, chunkCount);

  return {
    blob: new Blob(parts, { type: "application/octet-stream" }),
    metadata: {
      version: chunkedAttachmentVersion,
      algorithm: chunkedAttachmentAlgorithm,
      chunkCount,
      chunkIvs,
      chunkSize,
      encryptedSize
    }
  };
}

async function sourceToBytes(source: EncryptedAttachmentSource, limitBytes: number) {
  const bytes = source.bytes ?? new Uint8Array(await source.response.arrayBuffer());

  if (bytes.byteLength > limitBytes) {
    throw new Error("첨부파일 암호문이 허용 크기를 초과했습니다.");
  }

  return bytes;
}

async function decryptSingleAttachmentToBlob(
  metadata: AttachmentCryptoDocument,
  key: CryptoKey,
  source: EncryptedAttachmentSource
) {
  const iv = bytesLikeToUint8Array(metadata.iv, "첨부파일 IV");

  if (iv.byteLength !== 12) {
    throw new Error("첨부파일 IV가 올바르지 않습니다.");
  }

  const cipherBytes = await sourceToBytes(source, maxEncryptedAttachmentBytes);
  const plainBytes = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(cipherBytes)
  );

  return new Blob([plainBytes], { type: "application/octet-stream" });
}

async function* encryptedChunksFromBytes(bytes: Uint8Array, encryptedSizes: number[]) {
  let offset = 0;

  for (const encryptedSize of encryptedSizes) {
    const nextOffset = offset + encryptedSize;

    if (nextOffset > bytes.byteLength) {
      throw new Error("첨부파일 chunk 암호문이 부족합니다.");
    }

    yield bytes.subarray(offset, nextOffset);
    offset = nextOffset;
  }

  if (offset !== bytes.byteLength) {
    throw new Error("첨부파일 chunk 암호문 크기가 일치하지 않습니다.");
  }
}

async function* encryptedChunksFromResponse(response: Response, encryptedSizes: number[]) {
  if (!response.body) {
    yield* encryptedChunksFromBytes(new Uint8Array(await response.arrayBuffer()), encryptedSizes);
    return;
  }

  const reader = response.body.getReader();
  let completed = false;
  let pending: Uint8Array<ArrayBufferLike> | null = null;
  let pendingOffset = 0;

  try {
    for (const encryptedSize of encryptedSizes) {
      const encryptedChunk = new Uint8Array(encryptedSize);
      let written = 0;

      while (written < encryptedSize) {
        if (!pending || pendingOffset >= pending.byteLength) {
          const { done, value } = await reader.read();

          if (done) {
            throw new Error("첨부파일 chunk 암호문이 부족합니다.");
          }

          if (!value?.byteLength) {
            continue;
          }

          pending = value;
          pendingOffset = 0;
        }

        const available = pending.byteLength - pendingOffset;
        const copyLength = Math.min(available, encryptedSize - written);

        encryptedChunk.set(pending.subarray(pendingOffset, pendingOffset + copyLength), written);
        pendingOffset += copyLength;
        written += copyLength;
      }

      if (pending && pendingOffset >= pending.byteLength) {
        pending = null;
        pendingOffset = 0;
      }

      yield encryptedChunk;
    }

    const trailingBytes = pending as Uint8Array<ArrayBufferLike> | null;

    if (trailingBytes && pendingOffset < trailingBytes.byteLength) {
      throw new Error("첨부파일 chunk 암호문 크기가 일치하지 않습니다.");
    }

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        completed = true;
        break;
      }

      if (value?.byteLength) {
        throw new Error("첨부파일 chunk 암호문 크기가 일치하지 않습니다.");
      }
    }
  } finally {
    if (!completed) {
      await reader.cancel().catch(() => undefined);
    }

    reader.releaseLock();
  }
}

async function decryptChunkedAttachmentToBlob(
  metadata: AttachmentCryptoDocument,
  key: CryptoKey,
  source: EncryptedAttachmentSource
) {
  const chunkMetadata = normalizedChunkedAttachmentMetadata(metadata);
  const encryptedSizes = chunkEncryptedSizes(metadata);
  const parts: BlobPart[] = [];
  const encryptedChunks =
    source.bytes
      ? encryptedChunksFromBytes(await sourceToBytes(source, maxChunkedEncryptedAttachmentBytes), encryptedSizes)
      : encryptedChunksFromResponse(source.response, encryptedSizes);
  let plainSize = 0;
  let index = 0;

  for await (const encryptedChunk of encryptedChunks) {
    const expectedPlainSize = chunkPlainSize(index, metadata.originalSize, chunkMetadata.chunkSize, chunkMetadata.chunkCount);
    const plainBuffer = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(chunkMetadata.chunkIvs[index] ?? new Uint8Array(0)) },
      key,
      toArrayBuffer(encryptedChunk)
    );
    const plainBytes = new Uint8Array(plainBuffer);

    if (plainBytes.byteLength !== expectedPlainSize) {
      throw new Error("첨부파일 chunk 복호화 크기가 일치하지 않습니다.");
    }

    parts.push(plainBuffer);
    plainSize += plainBytes.byteLength;
    index += 1;
  }

  if (index !== chunkMetadata.chunkCount || plainSize !== metadata.originalSize) {
    throw new Error("첨부파일 chunk 복호화 결과가 올바르지 않습니다.");
  }

  return new Blob(parts, { type: "application/octet-stream" });
}

export async function decryptAttachmentToBlob(
  metadata: AttachmentCryptoDocument,
  key: CryptoKey,
  source: EncryptedAttachmentSource
) {
  return isChunkedAttachment(metadata)
    ? decryptChunkedAttachmentToBlob(metadata, key, source)
    : decryptSingleAttachmentToBlob(metadata, key, source);
}

export async function decryptAttachmentToBytes(
  metadata: AttachmentCryptoDocument,
  key: CryptoKey,
  source: EncryptedAttachmentSource
) {
  const blob = await decryptAttachmentToBlob(metadata, key, source);
  return new Uint8Array(await blobArrayBuffer(blob));
}

export async function reencryptAttachmentBlob(
  metadata: AttachmentCryptoDocument,
  sourceKey: CryptoKey,
  targetKey: CryptoKey,
  source: EncryptedAttachmentSource
): Promise<EncryptedAttachmentBlob> {
  if (!isChunkedAttachment(metadata)) {
    return encryptAttachmentBlob(await decryptSingleAttachmentToBlob(metadata, sourceKey, source), targetKey);
  }

  const chunkMetadata = normalizedChunkedAttachmentMetadata(metadata);
  const encryptedSizes = chunkEncryptedSizes(metadata);
  const encryptedChunks =
    source.bytes
      ? encryptedChunksFromBytes(await sourceToBytes(source, maxChunkedEncryptedAttachmentBytes), encryptedSizes)
      : encryptedChunksFromResponse(source.response, encryptedSizes);
  const parts: BlobPart[] = [];
  const chunkIvs: Uint8Array[] = [];
  let encryptedSize = 0;
  let index = 0;

  for await (const encryptedChunk of encryptedChunks) {
    const expectedPlainSize = chunkPlainSize(index, metadata.originalSize, chunkMetadata.chunkSize, chunkMetadata.chunkCount);
    const plainBuffer = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(chunkMetadata.chunkIvs[index] ?? new Uint8Array(0)) },
      sourceKey,
      toArrayBuffer(encryptedChunk)
    );
    const plainBytes = new Uint8Array(plainBuffer);

    if (plainBytes.byteLength !== expectedPlainSize) {
      throw new Error("첨부파일 chunk 복호화 크기가 일치하지 않습니다.");
    }

    const nextIv = randomBytes(12);
    const nextCipherBytes = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(nextIv) },
      targetKey,
      plainBuffer
    );

    plainBytes.fill(0);
    parts.push(nextCipherBytes);
    chunkIvs.push(nextIv);
    encryptedSize += nextCipherBytes.byteLength;
    index += 1;
  }

  if (index !== chunkMetadata.chunkCount) {
    throw new Error("첨부파일 chunk 재암호화 결과가 올바르지 않습니다.");
  }

  validateChunkedSize(metadata.originalSize, encryptedSize, chunkMetadata.chunkSize, chunkMetadata.chunkCount);

  return {
    blob: new Blob(parts, { type: "application/octet-stream" }),
    metadata: {
      version: chunkedAttachmentVersion,
      algorithm: chunkedAttachmentAlgorithm,
      chunkCount: chunkMetadata.chunkCount,
      chunkIvs,
      chunkSize: chunkMetadata.chunkSize,
      encryptedSize
    }
  };
}
