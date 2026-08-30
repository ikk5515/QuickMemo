import { afterEach, describe, expect, it, vi } from "vitest";
import {
  encryptedAttachmentChunkSizeBytes,
  encryptedAttachmentOverheadBytes,
  maxAttachmentPreviewBytes
} from "./attachments";
import {
  chunkedAttachmentAlgorithm,
  chunkedAttachmentVersion,
  attachmentCryptoMobileRuntime,
  attachmentCryptoRuntimeFileSizeLimit,
  decryptAttachmentToBlob,
  decryptAttachmentToBytes,
  encryptAttachmentBlob,
  maxConstrainedAttachmentFileBytes,
  reencryptAttachmentBlob
} from "./attachmentCrypto";
import { encryptBytes, generateNoteKey } from "./crypto";

function testBytes(length: number) {
  const bytes = new Uint8Array(length);

  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = index % 251;
  }

  return bytes;
}

async function blobBytes(blob: Blob) {
  return new Uint8Array(
    await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();

      reader.onerror = () => reject(reader.error ?? new Error("Blob read failed."));
      reader.onload = () => {
        if (reader.result instanceof ArrayBuffer) {
          resolve(reader.result);
          return;
        }

        reject(new Error("Unexpected Blob read result."));
      };
      reader.readAsArrayBuffer(blob);
    })
  );
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "scheduler");
});

function streamedResponse(
  bytes: Uint8Array,
  options: { closeWhenConsumed?: boolean; onCancel?: () => void; sizes?: number[] } = {}
) {
  const sizes = options.sizes?.length ? options.sizes : [bytes.byteLength];
  let offset = 0;
  let sizeIndex = 0;

  return new Response(
    new ReadableStream<Uint8Array>({
      cancel() {
        options.onCancel?.();
      },
      pull(controller) {
        if (offset >= bytes.byteLength) {
          if (options.closeWhenConsumed !== false) {
            controller.close();
          }
          return;
        }

        const requestedSize = sizes[sizeIndex % sizes.length] ?? bytes.byteLength;
        const nextOffset = Math.min(bytes.byteLength, offset + Math.max(1, requestedSize));

        controller.enqueue(bytes.slice(offset, nextOffset));
        offset = nextOffset;
        sizeIndex += 1;
      }
    })
  );
}

describe("attachment chunked encryption", () => {
  it("uses a conservative cap on mobile, low-memory, and non-streaming runtimes", () => {
    expect(attachmentCryptoRuntimeFileSizeLimit({ streamingBlobAssembly: true })).toBeGreaterThan(
      maxConstrainedAttachmentFileBytes
    );
    expect(attachmentCryptoRuntimeFileSizeLimit({ mobile: true, streamingBlobAssembly: true }))
      .toBe(maxConstrainedAttachmentFileBytes);
    expect(attachmentCryptoRuntimeFileSizeLimit({ deviceMemory: 4, streamingBlobAssembly: true }))
      .toBe(maxConstrainedAttachmentFileBytes);
    expect(attachmentCryptoRuntimeFileSizeLimit({ deviceMemory: 8, streamingBlobAssembly: false }))
      .toBe(maxConstrainedAttachmentFileBytes);
  });

  it("recognizes Safari iPhone and touch-enabled iPad runtimes without userAgentData", () => {
    expect(attachmentCryptoMobileRuntime({
      platform: "iPhone",
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148"
    })).toBe(true);
    expect(attachmentCryptoMobileRuntime({
      maxTouchPoints: 5,
      platform: "MacIntel",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15"
    })).toBe(true);
    expect(attachmentCryptoMobileRuntime({
      maxTouchPoints: 0,
      platform: "MacIntel",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15"
    })).toBe(false);
  });

  it("keeps legacy v1 single AES-GCM attachment payloads decryptable", async () => {
    const noteKey = await generateNoteKey();
    const plainBytes = testBytes(4097);
    const encrypted = await encryptBytes(plainBytes, noteKey);

    await expect(
      decryptAttachmentToBytes(
        {
          version: 1,
          algorithm: "AES-GCM",
          encryptedSize: encrypted.cipherBytes.byteLength,
          iv: encrypted.iv,
          originalSize: plainBytes.byteLength
        },
        noteKey,
        { bytes: encrypted.cipherBytes }
      )
    ).resolves.toEqual(plainBytes);
  });

  it("refuses contiguous byte materialization above the preview memory cap", async () => {
    const noteKey = await generateNoteKey();
    await expect(decryptAttachmentToBytes(
      {
        algorithm: "AES-GCM",
        originalSize: maxAttachmentPreviewBytes + 1,
        version: 1
      },
      noteKey,
      { bytes: new Uint8Array() }
    )).rejects.toThrow("25MB 이하");
  });

  it("encrypts new attachments as chunked AES-GCM and decrypts them from a response stream", async () => {
    const schedulerYield = vi.fn(async () => undefined);
    Object.defineProperty(globalThis, "scheduler", {
      configurable: true,
      value: { yield: schedulerYield }
    });
    const noteKey = await generateNoteKey();
    const plainBytes = testBytes(encryptedAttachmentChunkSizeBytes + 23);
    const encrypted = await encryptAttachmentBlob(new Blob([plainBytes]), noteKey);
    const encryptedBytes = await blobBytes(encrypted.blob);
    const metadata = encrypted.metadata;

    if (metadata.version !== chunkedAttachmentVersion) {
      throw new Error("Expected chunked attachment metadata.");
    }

    expect(metadata.version).toBe(chunkedAttachmentVersion);
    expect(metadata.algorithm).toBe(chunkedAttachmentAlgorithm);
    expect(metadata.chunkSize).toBe(encryptedAttachmentChunkSizeBytes);
    expect(metadata.chunkCount).toBe(2);
    expect(metadata.chunkIvs).toHaveLength(2);
    expect(metadata.chunkIvs[0]).not.toEqual(metadata.chunkIvs[1]);
    expect(metadata.encryptedSize).toBe(plainBytes.byteLength + 2 * encryptedAttachmentOverheadBytes);
    expect(encryptedBytes.byteLength).toBe(metadata.encryptedSize);

    const decryptedBlob = await decryptAttachmentToBlob(
      { ...metadata, originalSize: plainBytes.byteLength },
      noteKey,
      { response: new Response(encryptedBytes) }
    );

    await expect(blobBytes(decryptedBlob)).resolves.toEqual(plainBytes);
    expect(schedulerYield).toHaveBeenCalled();
  }, 30_000);

  it("stops chunked attachment encryption when its abort signal is cancelled", async () => {
    const noteKey = await generateNoteKey();
    const plainBytes = testBytes(encryptedAttachmentChunkSizeBytes + 23);
    const controller = new AbortController();
    const onProgress = vi.fn(() => controller.abort());

    await expect(
      encryptAttachmentBlob(new Blob([plainBytes]), noteKey, onProgress, controller.signal)
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(onProgress).toHaveBeenCalledOnce();
  }, 30_000);

  it("cancels the response reader when chunked attachment decryption is aborted", async () => {
    const noteKey = await generateNoteKey();
    const plainBytes = testBytes(128 * 1024 + 37);
    const encrypted = await encryptAttachmentBlob(new Blob([plainBytes]), noteKey);
    const encryptedBytes = await blobBytes(encrypted.blob);
    const controller = new AbortController();
    let cancelCount = 0;
    let pulled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      cancel() {
        cancelCount += 1;
      },
      pull(streamController) {
        if (pulled) return;
        pulled = true;
        streamController.enqueue(encryptedBytes.slice(0, 4096));
        controller.abort();
      }
    }));

    await expect(
      decryptAttachmentToBytes(
        { ...encrypted.metadata, originalSize: plainBytes.byteLength },
        noteKey,
        { response },
        controller.signal
      )
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelCount).toBe(1);
  });

  it("assembles irregular response chunks without requiring cumulative buffer concatenation", async () => {
    const noteKey = await generateNoteKey();
    const plainBytes = testBytes(128 * 1024 + 37);
    const encrypted = await encryptAttachmentBlob(new Blob([plainBytes]), noteKey);
    const encryptedBytes = await blobBytes(encrypted.blob);

    await expect(
      decryptAttachmentToBytes(
        { ...encrypted.metadata, originalSize: plainBytes.byteLength },
        noteKey,
        { response: streamedResponse(encryptedBytes, { sizes: [1, 7, 31, 257, 4093] }) }
      )
    ).resolves.toEqual(plainBytes);
  });

  it("cancels an unfinished encrypted response stream when authentication fails", async () => {
    const noteKey = await generateNoteKey();
    const plainBytes = testBytes(8193);
    const encrypted = await encryptAttachmentBlob(new Blob([plainBytes]), noteKey);
    const tamperedBytes = await blobBytes(encrypted.blob);
    let cancelCount = 0;

    tamperedBytes[0] ^= 0xff;

    await expect(
      decryptAttachmentToBytes(
        { ...encrypted.metadata, originalSize: plainBytes.byteLength },
        noteKey,
        {
          response: streamedResponse(tamperedBytes, {
            closeWhenConsumed: false,
            onCancel: () => {
              cancelCount += 1;
            },
            sizes: [tamperedBytes.byteLength]
          })
        }
      )
    ).rejects.toThrow();
    expect(cancelCount).toBe(1);
  });

  it("rejects tampered or truncated chunked ciphertext", async () => {
    const noteKey = await generateNoteKey();
    const plainBytes = testBytes(encryptedAttachmentChunkSizeBytes + 9);
    const encrypted = await encryptAttachmentBlob(new Blob([plainBytes]), noteKey);
    const metadata = { ...encrypted.metadata, originalSize: plainBytes.byteLength };
    const encryptedBytes = await blobBytes(encrypted.blob);
    const tamperedBytes = encryptedBytes.slice();
    const truncatedBytes = encryptedBytes.slice(0, encryptedBytes.byteLength - 1);

    tamperedBytes[encryptedAttachmentChunkSizeBytes + encryptedAttachmentOverheadBytes + 1] ^= 0xff;

    await expect(decryptAttachmentToBytes(metadata, noteKey, { bytes: tamperedBytes })).rejects.toThrow();
    await expect(decryptAttachmentToBytes(metadata, noteKey, { bytes: truncatedBytes })).rejects.toThrow();
  });

  it("re-encrypts chunked attachments with a different key without changing the plaintext", async () => {
    const sourceKey = await generateNoteKey();
    const targetKey = await generateNoteKey();
    const plainBytes = testBytes(4097);
    const sourceEncrypted = await encryptAttachmentBlob(new Blob([plainBytes]), sourceKey);
    const sourceBytes = await blobBytes(sourceEncrypted.blob);
    const reencrypted = await reencryptAttachmentBlob(
      { ...sourceEncrypted.metadata, originalSize: plainBytes.byteLength },
      sourceKey,
      targetKey,
      { bytes: sourceBytes }
    );

    await expect(
      decryptAttachmentToBytes(
        { ...reencrypted.metadata, originalSize: plainBytes.byteLength },
        targetKey,
        { response: new Response(await blobBytes(reencrypted.blob)) }
      )
    ).resolves.toEqual(plainBytes);
  }, 30_000);
});
