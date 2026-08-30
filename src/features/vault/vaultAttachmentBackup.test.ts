import { describe, expect, it, vi } from "vitest";
import { encryptText, generateNoteKey } from "../../lib/crypto";
import type { NoteAttachmentSnapshot } from "../../services/notes";
import {
  collectVaultAttachmentBackup,
  MAX_CONSTRAINED_VAULT_ATTACHMENT_BACKUP_BYTES,
  MAX_VAULT_ATTACHMENT_BACKUP_ENTRY_BYTES,
  vaultAttachmentBackupByteBudget
} from "./vaultAttachmentBackup";

function attachment(
  id: string,
  fileName: string,
  originalSize: number
): NoteAttachmentSnapshot {
  return {
    algorithm: "AES-GCM",
    extension: "txt",
    fileName,
    id,
    isReady: true,
    mimeType: "text/plain",
    noteId: "note-a",
    originalSize,
    uploadedBy: "user-a",
    version: 1
  };
}

const wrappedKey = {
  algorithm: "RSA-OAEP" as const,
  version: 1 as const,
  wrappedKey: "wrapped"
};

describe("vault attachment backup", () => {
  it("exports explicitly decrypted files with collision-safe paths and SHA-256 integrity metadata", async () => {
    const bytes = new TextEncoder().encode("hello");
    const first = attachment("attachment-a", "report", bytes.byteLength);
    const second = attachment("attachment-b", "report", bytes.byteLength);
    const decryptAttachmentToBlob = vi.fn(async () => new Blob([bytes]));
    const result = await collectVaultAttachmentBackup(
      [{ id: "note-a", path: "Folder/Note.md", wrappedKey }],
      {} as CryptoKey,
      {
        byteBudget: 1024,
        dependencies: {
          decryptAttachmentToBlob,
          getEncryptedNoteAttachmentSource: vi.fn(async () => ({ bytes: new Uint8Array([1]) })),
          getNoteAttachments: vi.fn(async () => [second, first]),
          unwrapNoteKey: vi.fn(async () => ({} as CryptoKey))
        },
        occupiedPaths: ["Folder/Note.md"]
      }
    );

    expect(result.sources.map((source) => source.path)).toEqual([
      "Folder/Note attachments/report.txt",
      "Folder/Note attachments/report 2.txt"
    ]);
    expect(result.included).toEqual([
      expect.objectContaining({
        byteLength: 5,
        sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
      }),
      expect.objectContaining({
        byteLength: 5,
        sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
      })
    ]);
    const manifest = JSON.parse(result.manifestSource.content as string);
    expect(manifest.contentProtection).toBe("decrypted-by-explicit-export");
    expect(manifest.summary).toEqual({ includedBytes: 10, includedCount: 2, missingCount: 0 });
  });

  it("skips files before download when entry or total caps would be exceeded", async () => {
    const download = vi.fn();
    const result = await collectVaultAttachmentBackup(
      [{ id: "note-a", path: "Note.md", wrappedKey }],
      {} as CryptoKey,
      {
        byteBudget: 4,
        dependencies: {
          decryptAttachmentToBlob: vi.fn(),
          getEncryptedNoteAttachmentSource: download,
          getNoteAttachments: vi.fn(async () => [
            attachment("too-large", "large", MAX_VAULT_ATTACHMENT_BACKUP_ENTRY_BYTES + 1),
            attachment("over-budget", "budget", 5)
          ]),
          unwrapNoteKey: vi.fn(async () => ({} as CryptoKey))
        }
      }
    );

    expect(download).not.toHaveBeenCalled();
    expect(result.missing.map((item) => item.reason).sort()).toEqual([
      "entry-size-limit",
      "total-size-limit"
    ]);
    expect(JSON.parse(result.manifestSource.content as string).summary.missingCount).toBe(2);
  });

  it("contains traversal-like names and uses a manifest-labelled fallback after filename decryption failure", async () => {
    const bytes = new TextEncoder().encode("safe");
    const traversal = attachment("attachment-a", "../../secret", bytes.byteLength);
    const unavailable = {
      ...attachment("attachment-b", "", bytes.byteLength),
      encryptedFileName: {
        algorithm: "AES-GCM" as const,
        cipherText: "corrupt",
        iv: "corrupt",
        version: 1 as const
      },
      privacyVersion: 1 as const
    };
    const result = await collectVaultAttachmentBackup(
      [{ id: "note-a", path: "Folder/Note.md", wrappedKey }],
      {} as CryptoKey,
      {
        byteBudget: 1024,
        dependencies: {
          decryptAttachmentToBlob: vi.fn(async () => new Blob([bytes])),
          getEncryptedNoteAttachmentSource: vi.fn(async () => ({ bytes: new Uint8Array([1]) })),
          getNoteAttachments: vi.fn(async () => [traversal, unavailable]),
          unwrapNoteKey: vi.fn(async () => ({} as CryptoKey))
        }
      }
    );

    expect(result.sources).toHaveLength(2);
    expect(result.sources.every((source) => source.path.startsWith("Folder/Note attachments/"))).toBe(true);
    expect(result.sources.every((source) => !source.path.includes("/../"))).toBe(true);
    expect(result.included).toContainEqual(expect.objectContaining({
      fileName: "attachment-2.txt",
      fileNameStatus: "fallback"
    }));
  });

  it("restores an encrypted private filename before assigning the ZIP path", async () => {
    const noteKey = await generateNoteKey();
    const bytes = new TextEncoder().encode("private");
    const encryptedFileName = await encryptText("원본 보고서.txt", noteKey);
    const protectedAttachment = {
      ...attachment("attachment-a", "note-txt-attachment", bytes.byteLength),
      encryptedFileName,
      privacyVersion: 1 as const
    };
    const result = await collectVaultAttachmentBackup(
      [{ id: "note-a", path: "Note.md", wrappedKey }],
      {} as CryptoKey,
      {
        byteBudget: 1024,
        dependencies: {
          decryptAttachmentToBlob: vi.fn(async () => new Blob([bytes])),
          getEncryptedNoteAttachmentSource: vi.fn(async () => ({ bytes: new Uint8Array([1]) })),
          getNoteAttachments: vi.fn(async () => [protectedAttachment]),
          unwrapNoteKey: vi.fn(async () => noteKey)
        }
      }
    );

    expect(result.sources[0]?.path).toBe("Note attachments/원본 보고서.txt");
    expect(result.included[0]).toMatchObject({
      fileName: "원본 보고서.txt",
      fileNameStatus: "available"
    });
  });

  it("reserves archive headroom after existing vault content", () => {
    const emptyBudget = vaultAttachmentBackupByteBudget([]);
    const occupiedBudget = vaultAttachmentBackupByteBudget([{
      content: new Uint8Array(32 * 1024 * 1024),
      kind: "asset",
      path: "existing.bin"
    }]);

    expect(emptyBudget).toBeGreaterThan(0);
    expect(occupiedBudget).toBeLessThan(emptyBudget);
    expect(vaultAttachmentBackupByteBudget([], 64 * 1024 * 1024))
      .toBe(MAX_CONSTRAINED_VAULT_ATTACHMENT_BACKUP_BYTES);
  });
});
