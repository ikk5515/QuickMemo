import { describe, expect, it } from "vitest";
import {
  encryptedAttachmentChunkSizeBytes,
  encryptedAttachmentOverheadBytes
} from "./attachments";
import {
  chunkedAttachmentAlgorithm,
  chunkedAttachmentVersion,
  decryptAttachmentToBlob,
  decryptAttachmentToBytes,
  encryptAttachmentBlob,
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

describe("attachment chunked encryption", () => {
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

  it("encrypts new attachments as chunked AES-GCM and decrypts them from a response stream", async () => {
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
  }, 30_000);

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
    const plainBytes = testBytes(encryptedAttachmentChunkSizeBytes * 2 + 17);
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
