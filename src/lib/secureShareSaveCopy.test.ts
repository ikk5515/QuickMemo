import { describe, expect, it, vi } from "vitest";
import type { SecurePublicShareCopyPayload } from "../components/SecurePublicShareViewer";
import type { UserProfile } from "../types";
import {
  saveSecureShareCopy,
  SecureShareSaveCopyError,
  type SecureShareSaveCopyProgress
} from "./secureShareSaveCopy";

const profile: UserProfile = {
  uid: "owner_123456",
  displayName: "Owner",
  avatarText: "O",
  color: "#334155",
  order: 1,
  quickKey: 1,
  loginEmail: "owner@quickmemo.local",
  isActive: true,
  isAdmin: false,
  role: "user",
  publicKeyJwk: { kty: "RSA", n: "test", e: "AQAB" },
  featureAccess: {
    notes: true,
    library: false,
    schedule: false
  }
};
const privateKey = {} as CryptoKey;
const noteKey = {} as CryptoKey;
const wrappedKey = {
  version: 1 as const,
  algorithm: "RSA-OAEP" as const,
  wrappedKey: "wrapped-owner-key"
};

function attachment(id: string, fileName: string) {
  return {
    id,
    fileName,
    extension: "pdf",
    mimeType: "application/pdf",
    originalSize: 4,
    previewAllowed: true,
    encryption: {
      version: 1 as const,
      algorithm: "AES-GCM" as const,
      originalSize: 4,
      encryptedSize: 20,
      iv: new Uint8Array(12)
    }
  };
}

function payload(
  attachments = [attachment("attachment_123456", "report.pdf")]
): SecurePublicShareCopyPayload {
  return {
    title: "복사할 노트",
    body: "<!--qm-font-size:18--><p>안전한 본문</p>",
    bodyHtml: "<p>안전한 본문</p>",
    attachments,
    capabilities: {
      canComment: false,
      canSaveCopy: true,
      downloadAllowed: false,
      permissionLevel: "save_copy",
      quickCopyButtonVisible: false
    },
    copyAttachment: vi.fn(async () =>
      new Blob([new Uint8Array([1, 2, 3, 4])], { type: "application/pdf" })
    ),
    copyGrantExpiresAt: "2030-01-01T00:00:00.000Z"
  };
}

function dependencies() {
  return {
    abortSecureShareCopyingNote: vi.fn(async () => ({
      lastMutationId: "delete_123456",
      noteId: "new_note_123456",
      revision: 2
    })),
    activateSecureShareCopyingNote: vi.fn(async () => ({
      noteId: "new_note_123456",
      state: "active" as const
    })),
    createCopyJobId: vi.fn(() => "copy_job_1234567890"),
    createNoteAttachment: vi.fn(async (input: { onUploadProgress?: (progress: {
      loaded: number;
      percentage: number;
      total: number;
    }) => void }) => {
      input.onUploadProgress?.({ loaded: 20, percentage: 100, total: 20 });
      return { id: "new_attachment_123456" };
    }),
    createSecureShareCopyingNote: vi.fn(async () => ({
      lastMutationId: "mutation_123456",
      noteId: "new_note_123456",
      noteRef: {},
      revision: 1
    })),
    deleteNoteAttachment: vi.fn(async () => undefined),
    encryptAttachmentBlob: vi.fn(async (
      blob: Blob,
      _key: CryptoKey,
      onProgress?: (progress: { loaded: number; percentage: number; total: number }) => void
    ) => {
      onProgress?.({ loaded: blob.size, percentage: 100, total: blob.size });
      return {
        blob: new Blob([new Uint8Array(20)]),
        metadata: {
          version: 1 as const,
          algorithm: "AES-GCM" as const,
          encryptedSize: 20,
          iv: new Uint8Array(12)
        }
      };
    }),
    encryptText: vi.fn(async () => ({
      version: 1 as const,
      algorithm: "AES-GCM" as const,
      cipherText: "cipher",
      iv: "iv"
    })),
    generateNoteKey: vi.fn(async () => noteKey),
    now: vi.fn(() => Date.parse("2026-07-28T00:00:00.000Z")),
    unwrapNoteKey: vi.fn(async () => noteKey),
    wrapNoteKey: vi.fn(async () => wrappedKey)
  } as unknown as NonNullable<Parameters<typeof saveSecureShareCopy>[1]>;
}

describe("secure share save-copy saga", () => {
  it("creates an independent personal note and re-encrypts attachments sequentially", async () => {
    const deps = dependencies();
    const source = payload([
      attachment("attachment_123456", "report.pdf"),
      attachment("attachment_234567", "second.pdf")
    ]);
    const progress: SecureShareSaveCopyProgress[] = [];

    await expect(saveSecureShareCopy({
      payload: source,
      privateKey,
      profile,
      signal: new AbortController().signal,
      onProgress: (value) => progress.push(value)
    }, deps)).resolves.toEqual({ noteId: "new_note_123456" });

    expect(deps.createSecureShareCopyingNote).toHaveBeenCalledWith(expect.objectContaining({
      copyJobId: "copy_job_1234567890",
      expectedAttachmentCount: 2,
      historySnapshot: expect.any(Object),
      type: "personal",
      ownerUid: profile.uid,
      participantUids: [profile.uid],
      wrappedKeys: { [profile.uid]: wrappedKey }
    }));
    expect(deps.encryptText).toHaveBeenCalledWith(JSON.stringify({
      title: "복사할 노트",
      body: "<p>안전한 본문</p>",
      fontSize: 18
    }), noteKey);
    expect(source.copyAttachment).toHaveBeenCalledTimes(2);
    expect(deps.createNoteAttachment).toHaveBeenCalledTimes(2);
    expect(deps.createNoteAttachment).toHaveBeenCalledWith(expect.objectContaining({
      secureShareCopyJobId: "copy_job_1234567890"
    }));
    expect(deps.activateSecureShareCopyingNote).toHaveBeenCalledWith({
      copyJobId: "copy_job_1234567890",
      expectedRevision: 1,
      noteId: "new_note_123456",
      uid: profile.uid
    });
    expect(deps.deleteNoteAttachment).not.toHaveBeenCalled();
    expect(deps.abortSecureShareCopyingNote).not.toHaveBeenCalled();
    expect(progress.map((entry) => entry.phase)).toEqual(expect.arrayContaining([
      "preparing",
      "creating_note",
      "downloading",
      "encrypting",
      "uploading",
      "activating",
      "complete"
    ]));
  });

  it("compensates uploaded objects and soft-deletes revision 1 without mutating the source share", async () => {
    const deps = dependencies();
    const source = payload([
      attachment("attachment_123456", "report.pdf"),
      attachment("attachment_234567", "second.pdf")
    ]);
    vi.mocked(source.copyAttachment)
      .mockResolvedValueOnce(new Blob([new Uint8Array([1, 2, 3, 4])], { type: "application/pdf" }))
      .mockRejectedValueOnce(new Error("copy failed"));

    await expect(saveSecureShareCopy({
      payload: source,
      privateKey,
      profile,
      signal: new AbortController().signal
    }, deps)).rejects.toMatchObject({ code: "save_failed" });

    expect(deps.deleteNoteAttachment).toHaveBeenCalledWith(
      "new_note_123456",
      "new_attachment_123456"
    );
    expect(deps.abortSecureShareCopyingNote).toHaveBeenCalledWith({
      copyJobId: "copy_job_1234567890",
      expectedRevision: 1,
      noteId: "new_note_123456",
      uid: profile.uid
    });
  });

  it("uses the same compensation path when cancellation arrives during upload", async () => {
    const deps = dependencies();
    const controller = new AbortController();
    const source = payload();
    vi.mocked(deps.createNoteAttachment).mockImplementation(async () => {
      controller.abort();
      return { id: "new_attachment_123456" } as never;
    });

    await expect(saveSecureShareCopy({
      payload: source,
      privateKey,
      profile,
      signal: controller.signal
    }, deps)).rejects.toMatchObject({ code: "cancelled" });

    expect(deps.deleteNoteAttachment).toHaveBeenCalledWith(
      "new_note_123456",
      "new_attachment_123456"
    );
    expect(deps.abortSecureShareCopyingNote).toHaveBeenCalledWith(expect.objectContaining({
      expectedRevision: 1,
      noteId: "new_note_123456"
    }));
  });

  it("rejects unsafe attachment metadata and expired grants before creating a note", async () => {
    const unsafeDeps = dependencies();
    const unsafe = payload([{
      ...attachment("attachment_123456", "../report.pdf"),
      fileName: "../report.pdf"
    }]);

    await expect(saveSecureShareCopy({
      payload: unsafe,
      privateKey,
      profile,
      signal: new AbortController().signal
    }, unsafeDeps)).rejects.toMatchObject({ code: "invalid_attachment" });
    expect(unsafeDeps.createSecureShareCopyingNote).not.toHaveBeenCalled();

    const expiredDeps = dependencies();
    expiredDeps.now = vi.fn(() => Date.parse("2031-01-01T00:00:00.000Z"));
    await expect(saveSecureShareCopy({
      payload: payload(),
      privateKey,
      profile,
      signal: new AbortController().signal
    }, expiredDeps)).rejects.toMatchObject({ code: "grant_expired" });
    expect(expiredDeps.createSecureShareCopyingNote).not.toHaveBeenCalled();
  });

  it("re-checks an ambiguous activation without destructively compensating a possibly active note", async () => {
    const deps = dependencies();
    vi.mocked(deps.activateSecureShareCopyingNote)
      .mockRejectedValueOnce(new Error("network response lost"))
      .mockResolvedValueOnce({ noteId: "new_note_123456", state: "active" });

    await expect(saveSecureShareCopy({
      payload: payload(),
      privateKey,
      profile,
      signal: new AbortController().signal
    }, deps)).resolves.toEqual({ noteId: "new_note_123456" });

    expect(deps.activateSecureShareCopyingNote).toHaveBeenCalledTimes(2);
    expect(deps.deleteNoteAttachment).not.toHaveBeenCalled();
    expect(deps.abortSecureShareCopyingNote).not.toHaveBeenCalled();
  });

  it("surfaces incomplete compensation as a distinct security error", async () => {
    const deps = dependencies();
    vi.mocked(deps.abortSecureShareCopyingNote).mockRejectedValue(new Error("delete failed"));
    const source = payload();
    vi.mocked(source.copyAttachment).mockRejectedValue(new Error("copy failed"));

    await expect(saveSecureShareCopy({
      payload: source,
      privateKey,
      profile,
      signal: new AbortController().signal
    }, deps)).rejects.toEqual(expect.objectContaining<Partial<SecureShareSaveCopyError>>({
      code: "cleanup_incomplete"
    }));
  });
});
