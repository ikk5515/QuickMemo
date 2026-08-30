import {
  encryptedAttachmentChunkSizeBytes,
  encryptedAttachmentOverheadBytes,
  maxAttachmentFileBytes,
  maxAttachmentPreviewBytes,
  maxChunkedEncryptedAttachmentBytes,
  maxEncryptedAttachmentChunkCount,
  maxEncryptedAttachmentBytes
} from "./attachments";

export const chunkedAttachmentVersion = 2;
export const chunkedAttachmentAlgorithm = "AES-GCM-CHUNKED";
/**
 * Response.blob() lets browsers spool chunks outside JS arrays but does not
 * guarantee constant native memory. Constrained devices therefore retain a
 * lower hard limit even when streaming assembly is available.
 */
export const maxConstrainedAttachmentFileBytes = 64 * 1024 * 1024;

export interface AttachmentCryptoRuntimeCapabilities {
  deviceMemory?: number;
  mobile?: boolean;
  streamingBlobAssembly: boolean;
}

interface AttachmentCryptoNavigatorSignals {
  maxTouchPoints?: number;
  platform?: string;
  userAgent?: string;
  userAgentData?: { mobile?: boolean };
}

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

export function attachmentCryptoMobileRuntime(
  runtimeNavigator: AttachmentCryptoNavigatorSignals | undefined,
  coarsePointer = false
) {
  if (runtimeNavigator?.userAgentData?.mobile === true || coarsePointer) return true;
  const userAgent = runtimeNavigator?.userAgent ?? "";
  if (/Android|iPhone|iPad|iPod|Mobile/iu.test(userAgent)) return true;
  return runtimeNavigator?.platform === "MacIntel" && (runtimeNavigator.maxTouchPoints ?? 0) > 1;
}

function detectedAttachmentCryptoRuntime(): AttachmentCryptoRuntimeCapabilities {
  const runtimeNavigator = typeof navigator === "undefined"
    ? undefined
    : navigator as Navigator & {
        deviceMemory?: number;
        userAgentData?: { mobile?: boolean };
      };
  const coarsePointer = typeof matchMedia === "function"
    && matchMedia("(pointer: coarse)").matches;

  return {
    deviceMemory: runtimeNavigator?.deviceMemory,
    mobile: attachmentCryptoMobileRuntime(runtimeNavigator, coarsePointer),
    streamingBlobAssembly: typeof ReadableStream !== "undefined" && typeof Response !== "undefined"
  };
}

async function yieldAttachmentCryptoTurn(index: number, signal?: AbortSignal) {
  if ((index + 1) % 2 !== 0) return;
  signal?.throwIfAborted();
  const runtimeScheduler = (globalThis as typeof globalThis & {
    scheduler?: { yield?: () => Promise<void> };
  }).scheduler;
  if (typeof runtimeScheduler?.yield === "function") {
    await runtimeScheduler.yield();
  } else {
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
  }
  signal?.throwIfAborted();
}

export function attachmentCryptoRuntimeFileSizeLimit(
  capabilities: AttachmentCryptoRuntimeCapabilities = detectedAttachmentCryptoRuntime()
) {
  const lowMemory = typeof capabilities.deviceMemory === "number" && capabilities.deviceMemory <= 4;
  return !capabilities.streamingBlobAssembly || capabilities.mobile === true || lowMemory
    ? maxConstrainedAttachmentFileBytes
    : maxAttachmentFileBytes;
}

function assertAttachmentCryptoRuntimeSize(size: number) {
  const limit = attachmentCryptoRuntimeFileSizeLimit();
  if (size > limit) {
    throw new Error(
      `이 기기에서는 메모리 보호를 위해 첨부파일을 ${Math.round(limit / (1024 * 1024))}MB 이하로 처리할 수 있습니다.`
    );
  }
}

async function blobFromChunkStream(
  chunks: AsyncIterable<Uint8Array>,
  signal?: AbortSignal
) {
  if (typeof ReadableStream === "undefined" || typeof Response === "undefined") {
    const parts: BlobPart[] = [];
    for await (const chunk of chunks) {
      signal?.throwIfAborted();
      // The fallback is limited to constrained runtimes; normalize away a
      // possible SharedArrayBuffer so Safari's BlobPart contract is satisfied.
      parts.push(toArrayBuffer(chunk));
    }
    return new Blob(parts, { type: "application/octet-stream" });
  }

  const iterator = chunks[Symbol.asyncIterator]();
  const stream = new ReadableStream<Uint8Array>({
    async cancel() {
      await iterator.return?.();
    },
    async pull(controller) {
      try {
        const next = await iterator.next();
        signal?.throwIfAborted();
        if (next.done) {
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (caught) {
        await iterator.return?.().catch(() => undefined);
        controller.error(caught);
      }
    }
  });

  try {
    return await new Response(stream, {
      headers: { "Content-Type": "application/octet-stream" }
    }).blob();
  } catch (caught) {
    await iterator.return?.().catch(() => undefined);
    throw caught;
  }
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
  onProgress?: AttachmentEncryptionProgressHandler,
  signal?: AbortSignal
): Promise<EncryptedAttachmentBlob> {
  signal?.throwIfAborted();
  const originalSize = file.size;

  if (originalSize <= 0 || originalSize > maxAttachmentFileBytes) {
    throw new Error("첨부파일 크기가 올바르지 않습니다.");
  }
  assertAttachmentCryptoRuntimeSize(originalSize);

  const chunkSize = encryptedAttachmentChunkSizeBytes;
  const chunkCount = chunkCountForSize(originalSize, chunkSize);
  const chunkIvs: Uint8Array[] = [];
  let encryptedSize = 0;
  const encryptedChunks = (async function* () {
    for (let index = 0; index < chunkCount; index += 1) {
      signal?.throwIfAborted();
      const offset = index * chunkSize;
      const plainBytes = new Uint8Array(await blobArrayBuffer(file.slice(offset, Math.min(offset + chunkSize, originalSize))));
      signal?.throwIfAborted();
      const iv = randomBytes(12);
      const cipherBuffer = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: toArrayBuffer(iv) },
        key,
        toArrayBuffer(plainBytes)
      );

      plainBytes.fill(0);
      signal?.throwIfAborted();
      const cipherBytes = new Uint8Array(cipherBuffer);
      chunkIvs.push(iv);
      encryptedSize += cipherBytes.byteLength;
      onProgress?.({
        loaded: Math.min(originalSize, offset + chunkPlainSize(index, originalSize, chunkSize, chunkCount)),
        percentage: Math.min(100, ((index + 1) / chunkCount) * 100),
        total: originalSize
      });
      await yieldAttachmentCryptoTurn(index, signal);
      yield cipherBytes;
    }
  })();
  const blob = await blobFromChunkStream(encryptedChunks, signal);

  signal?.throwIfAborted();
  validateChunkedSize(originalSize, encryptedSize, chunkSize, chunkCount);

  return {
    blob,
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

async function sourceToBytes(
  source: EncryptedAttachmentSource,
  limitBytes: number,
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  const bytes = source.bytes ?? new Uint8Array(await source.response.arrayBuffer());
  signal?.throwIfAborted();

  if (bytes.byteLength > limitBytes) {
    throw new Error("첨부파일 암호문이 허용 크기를 초과했습니다.");
  }

  return bytes;
}

async function decryptSingleAttachmentToBlob(
  metadata: AttachmentCryptoDocument,
  key: CryptoKey,
  source: EncryptedAttachmentSource,
  signal?: AbortSignal
) {
  assertAttachmentCryptoRuntimeSize(metadata.originalSize);
  const iv = bytesLikeToUint8Array(metadata.iv, "첨부파일 IV");

  if (iv.byteLength !== 12) {
    throw new Error("첨부파일 IV가 올바르지 않습니다.");
  }

  const cipherBytes = await sourceToBytes(source, maxEncryptedAttachmentBytes, signal);
  signal?.throwIfAborted();
  const plainBytes = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(cipherBytes)
  );
  signal?.throwIfAborted();

  return new Blob([plainBytes], { type: "application/octet-stream" });
}

async function* encryptedChunksFromBytes(
  bytes: Uint8Array,
  encryptedSizes: number[],
  signal?: AbortSignal
) {
  let offset = 0;

  for (const encryptedSize of encryptedSizes) {
    signal?.throwIfAborted();
    const nextOffset = offset + encryptedSize;

    if (nextOffset > bytes.byteLength) {
      throw new Error("첨부파일 chunk 암호문이 부족합니다.");
    }

    yield bytes.subarray(offset, nextOffset);
    signal?.throwIfAborted();
    offset = nextOffset;
  }

  if (offset !== bytes.byteLength) {
    throw new Error("첨부파일 chunk 암호문 크기가 일치하지 않습니다.");
  }
}

async function* encryptedChunksFromResponse(
  response: Response,
  encryptedSizes: number[],
  signal?: AbortSignal
) {
  if (!response.body) {
    yield* encryptedChunksFromBytes(
      new Uint8Array(await response.arrayBuffer()),
      encryptedSizes,
      signal
    );
    return;
  }

  const reader = response.body.getReader();
  let completed = false;
  let pending: Uint8Array<ArrayBufferLike> | null = null;
  let pendingOffset = 0;
  let abortCancellation: Promise<void> | null = null;
  const cancelReaderFromAbort = () => {
    abortCancellation ??= reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener("abort", cancelReaderFromAbort, { once: true });
  if (signal?.aborted) cancelReaderFromAbort();

  try {
    for (const encryptedSize of encryptedSizes) {
      signal?.throwIfAborted();
      const encryptedChunk = new Uint8Array(encryptedSize);
      let written = 0;

      while (written < encryptedSize) {
        if (!pending || pendingOffset >= pending.byteLength) {
          signal?.throwIfAborted();
          const { done, value } = await reader.read();
          signal?.throwIfAborted();

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
      signal?.throwIfAborted();
    }

    const trailingBytes = pending as Uint8Array<ArrayBufferLike> | null;

    if (trailingBytes && pendingOffset < trailingBytes.byteLength) {
      throw new Error("첨부파일 chunk 암호문 크기가 일치하지 않습니다.");
    }

    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();

      if (done) {
        completed = true;
        break;
      }

      if (value?.byteLength) {
        throw new Error("첨부파일 chunk 암호문 크기가 일치하지 않습니다.");
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancelReaderFromAbort);
    if (abortCancellation) {
      await abortCancellation;
    } else if (!completed) {
      await reader.cancel().catch(() => undefined);
    }

    reader.releaseLock();
  }
}

async function decryptChunkedAttachmentToBlob(
  metadata: AttachmentCryptoDocument,
  key: CryptoKey,
  source: EncryptedAttachmentSource,
  signal?: AbortSignal
) {
  assertAttachmentCryptoRuntimeSize(metadata.originalSize);
  const chunkMetadata = normalizedChunkedAttachmentMetadata(metadata);
  const encryptedSizes = chunkEncryptedSizes(metadata);
  const encryptedChunks =
    source.bytes
      ? encryptedChunksFromBytes(
          await sourceToBytes(source, maxChunkedEncryptedAttachmentBytes, signal),
          encryptedSizes,
          signal
        )
      : encryptedChunksFromResponse(source.response, encryptedSizes, signal);
  let plainSize = 0;
  let index = 0;
  const plainChunks = (async function* () {
    for await (const encryptedChunk of encryptedChunks) {
      signal?.throwIfAborted();
      const expectedPlainSize = chunkPlainSize(index, metadata.originalSize, chunkMetadata.chunkSize, chunkMetadata.chunkCount);
      const plainBuffer = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: toArrayBuffer(chunkMetadata.chunkIvs[index] ?? new Uint8Array(0)) },
        key,
        toArrayBuffer(encryptedChunk)
      );
      signal?.throwIfAborted();
      const plainBytes = new Uint8Array(plainBuffer);

      if (plainBytes.byteLength !== expectedPlainSize) {
        throw new Error("첨부파일 chunk 복호화 크기가 일치하지 않습니다.");
      }

      plainSize += plainBytes.byteLength;
      index += 1;
      await yieldAttachmentCryptoTurn(index - 1, signal);
      yield plainBytes;
    }
  })();
  const blob = await blobFromChunkStream(plainChunks, signal);

  signal?.throwIfAborted();
  if (index !== chunkMetadata.chunkCount || plainSize !== metadata.originalSize) {
    throw new Error("첨부파일 chunk 복호화 결과가 올바르지 않습니다.");
  }

  return blob;
}

export async function decryptAttachmentToBlob(
  metadata: AttachmentCryptoDocument,
  key: CryptoKey,
  source: EncryptedAttachmentSource,
  signal?: AbortSignal
) {
  return isChunkedAttachment(metadata)
    ? decryptChunkedAttachmentToBlob(metadata, key, source, signal)
    : decryptSingleAttachmentToBlob(metadata, key, source, signal);
}

export async function decryptAttachmentToBytes(
  metadata: AttachmentCryptoDocument,
  key: CryptoKey,
  source: EncryptedAttachmentSource,
  signal?: AbortSignal
) {
  if (metadata.originalSize > maxAttachmentPreviewBytes) {
    throw new Error("메모리 미리보기는 25MB 이하 첨부파일만 지원합니다.");
  }
  const blob = await decryptAttachmentToBlob(metadata, key, source, signal);
  signal?.throwIfAborted();
  return new Uint8Array(await blobArrayBuffer(blob));
}

export async function reencryptAttachmentBlob(
  metadata: AttachmentCryptoDocument,
  sourceKey: CryptoKey,
  targetKey: CryptoKey,
  source: EncryptedAttachmentSource,
  signal?: AbortSignal
): Promise<EncryptedAttachmentBlob> {
  if (!isChunkedAttachment(metadata)) {
    return encryptAttachmentBlob(
      await decryptSingleAttachmentToBlob(metadata, sourceKey, source, signal),
      targetKey,
      undefined,
      signal
    );
  }

  assertAttachmentCryptoRuntimeSize(metadata.originalSize);

  const chunkMetadata = normalizedChunkedAttachmentMetadata(metadata);
  const encryptedSizes = chunkEncryptedSizes(metadata);
  const encryptedChunks =
    source.bytes
      ? encryptedChunksFromBytes(await sourceToBytes(source, maxChunkedEncryptedAttachmentBytes, signal), encryptedSizes, signal)
      : encryptedChunksFromResponse(source.response, encryptedSizes, signal);
  const chunkIvs: Uint8Array[] = [];
  let encryptedSize = 0;
  let index = 0;
  const nextEncryptedChunks = (async function* () {
    for await (const encryptedChunk of encryptedChunks) {
      signal?.throwIfAborted();
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
      const nextCipherBuffer = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: toArrayBuffer(nextIv) },
        targetKey,
        plainBuffer
      );

      plainBytes.fill(0);
      signal?.throwIfAborted();
      const nextCipherBytes = new Uint8Array(nextCipherBuffer);
      chunkIvs.push(nextIv);
      encryptedSize += nextCipherBytes.byteLength;
      index += 1;
      await yieldAttachmentCryptoTurn(index - 1, signal);
      yield nextCipherBytes;
    }
  })();
  const blob = await blobFromChunkStream(nextEncryptedChunks, signal);

  signal?.throwIfAborted();
  if (index !== chunkMetadata.chunkCount) {
    throw new Error("첨부파일 chunk 재암호화 결과가 올바르지 않습니다.");
  }

  validateChunkedSize(metadata.originalSize, encryptedSize, chunkMetadata.chunkSize, chunkMetadata.chunkCount);

  return {
    blob,
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
