import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteAttachmentSnapshot } from "../../services/notes";

const cryptoMocks = vi.hoisted(() => ({
  decryptText: vi.fn(),
  encryptText: vi.fn()
}));
const serviceMocks = vi.hoisted(() => ({
  migrateNoteBlobAttachmentFileName: vi.fn(),
  noteGenericAttachmentBaseName: (extension: string) => (
    `note-${extension.trim().toLowerCase().replace(/[^a-z0-9]/gu, "").slice(0, 10) || "file"}-attachment`
  )
}));

vi.mock("../../lib/crypto", () => cryptoMocks);
vi.mock("../../services/blobAttachments", () => serviceMocks);

import {
  decryptPrivateNoteAttachmentName,
  migrateLegacyPrivateNoteAttachmentNames,
  noteGenericAttachmentBaseName,
  privateNoteAttachmentNameFields
} from "./noteAttachmentFileName";

function attachment(overrides: Partial<NoteAttachmentSnapshot> = {}) {
  return {
    algorithm: "AES-GCM-CHUNKED",
    chunkCount: 1,
    chunkIvs: [],
    chunkSize: 4 * 1024 * 1024,
    extension: "pdf",
    fileName: "legacy-name",
    id: "attachment-a",
    mimeType: "application/pdf",
    noteId: "note-a",
    originalSize: 4,
    uploadedBy: "user-a",
    version: 2,
    ...overrides
  } satisfies NoteAttachmentSnapshot;
}

describe("private note attachment filenames", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("encrypts a sanitized full filename and exposes only a generic server fallback", async () => {
    const encryptedFileName = {
      algorithm: "AES-GCM" as const,
      cipherText: "ciphertext",
      iv: "initialization-vector",
      version: 1 as const
    };
    cryptoMocks.encryptText.mockResolvedValueOnce(encryptedFileName);

    await expect(privateNoteAttachmentNameFields("급여: 8월.pdf", "pdf", {} as CryptoKey))
      .resolves.toEqual({
        encryptedFileName,
        fileName: "note-pdf-attachment",
        privacyVersion: 1
      });
    expect(cryptoMocks.encryptText).toHaveBeenCalledWith("급여_ 8월.pdf", expect.anything());
  });

  it("decrypts a protected full filename without duplicating its extension", async () => {
    cryptoMocks.decryptText.mockResolvedValueOnce("자료.pdf");
    const encrypted = attachment({
      fileName: "note-pdf-attachment",
      privacyVersion: 1,
      encryptedFileName: { cipherText: "cipher", iv: "iv" }
    } as never);

    await expect(decryptPrivateNoteAttachmentName(encrypted, {} as CryptoKey))
      .resolves.toMatchObject({ fileName: "자료", fileNameDecryptionFailed: false });
  });

  it("fails closed to a generic name when protected metadata is absent or cannot decrypt", async () => {
    const missing = attachment({ fileName: "must-not-leak", privacyVersion: 1 } as never);
    await expect(decryptPrivateNoteAttachmentName(missing, {} as CryptoKey))
      .resolves.toMatchObject({ fileName: "note-pdf-attachment", fileNameDecryptionFailed: true });

    cryptoMocks.decryptText.mockRejectedValueOnce(new Error("wrong key"));
    const corrupt = attachment({
      encryptedFileName: { cipherText: "cipher", iv: "iv" },
      fileName: "must-not-leak",
      privacyVersion: 1
    } as never);
    await expect(decryptPrivateNoteAttachmentName(corrupt, {} as CryptoKey))
      .resolves.toMatchObject({ fileName: "note-pdf-attachment", fileNameDecryptionFailed: true });
  });

  it("keeps legacy plaintext names readable", async () => {
    await expect(decryptPrivateNoteAttachmentName(attachment(), {} as CryptoKey))
      .resolves.toMatchObject({ fileName: "legacy-name" });
    expect(cryptoMocks.decryptText).not.toHaveBeenCalled();
  });

  it("normalizes unsafe extensions in the generic fallback", () => {
    expect(noteGenericAttachmentBaseName("P.D/F")).toBe("note-pdf-attachment");
  });

  it("migrates legacy names sequentially without sending plaintext to the API", async () => {
    cryptoMocks.encryptText
      .mockResolvedValueOnce({ cipherText: "cipher-a", iv: "iv-a" })
      .mockResolvedValueOnce({ cipherText: "cipher-b", iv: "iv-b" });
    serviceMocks.migrateNoteBlobAttachmentFileName.mockResolvedValue(undefined);
    const first = attachment({ id: "legacy-a" });
    const second = attachment({ id: "legacy-b", fileName: "other" });

    await migrateLegacyPrivateNoteAttachmentNames([first, second], {} as CryptoKey);

    expect(serviceMocks.migrateNoteBlobAttachmentFileName).toHaveBeenCalledTimes(2);
    expect(serviceMocks.migrateNoteBlobAttachmentFileName).toHaveBeenNthCalledWith(1, {
      attachmentId: "legacy-a",
      encryptedFileName: { cipherText: "cipher-a", iv: "iv-a" },
      fileName: "note-pdf-attachment",
      noteId: "note-a",
      privacyVersion: 1,
      signal: undefined
    });
    expect(JSON.stringify(serviceMocks.migrateNoteBlobAttachmentFileName.mock.calls))
      .not.toContain("legacy-name");

    await migrateLegacyPrivateNoteAttachmentNames([first, second], {} as CryptoKey);
    expect(serviceMocks.migrateNoteBlobAttachmentFileName).toHaveBeenCalledTimes(2);
  });

  it("continues best-effort migration after one item fails", async () => {
    cryptoMocks.encryptText
      .mockResolvedValueOnce({ cipherText: "failed", iv: "iv-a" })
      .mockResolvedValueOnce({ cipherText: "succeeded", iv: "iv-b" });
    serviceMocks.migrateNoteBlobAttachmentFileName
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce(undefined);

    await expect(migrateLegacyPrivateNoteAttachmentNames([
      attachment({ id: "retryable-failure" }),
      attachment({ id: "continues-after-failure" })
    ], {} as CryptoKey)).resolves.toBeUndefined();

    expect(serviceMocks.migrateNoteBlobAttachmentFileName).toHaveBeenCalledTimes(2);
  });
});
