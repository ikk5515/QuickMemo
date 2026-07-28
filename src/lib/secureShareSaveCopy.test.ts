import { describe, expect, it, vi } from "vitest";
import type { SecurePublicShareCopyPayload } from "../components/SecurePublicShareViewer";
import { maxAttachmentFileBytes } from "./attachments";
import { BlobAttachmentReservationCleanupError } from "../services/blobAttachments";
import type { UserProfile } from "../types";
import {
  estimateSecureShareCopyAttachmentLiveBytes,
  saveSecureShareCopy,
  secureShareCopyLiveByteBudget,
  selectSecureShareCopyAttachmentStarts,
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

function deferred<T>() {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
}

function metadataOnlyBlob(size: number) {
  return {
    size,
    type: "application/pdf"
  } as Blob;
}

function attachment(id: string, fileName: string, originalSize = 4) {
  return {
    id,
    fileName,
    extension: "pdf",
    mimeType: "application/pdf",
    originalSize,
    previewAllowed: true,
    encryption: {
      version: 1 as const,
      algorithm: "AES-GCM" as const,
      originalSize,
      encryptedSize: originalSize + 16,
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
    createNoteAttachment: vi.fn(async (input: {
      onUploadProgress?: (progress: {
        loaded: number;
        percentage: number;
        total: number;
      }) => void;
      signal?: AbortSignal;
    }) => {
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
  it("selects work by estimated live bytes and isolates a maximum-size attachment", () => {
    const mebibyte = 1024 * 1024;

    expect(estimateSecureShareCopyAttachmentLiveBytes(maxAttachmentFileBytes))
      .toBeGreaterThan(secureShareCopyLiveByteBudget);
    expect(selectSecureShareCopyAttachmentStarts({
      activeOriginalSizes: [],
      pendingOriginalSizes: [maxAttachmentFileBytes, mebibyte]
    })).toBe(1);
    expect(selectSecureShareCopyAttachmentStarts({
      activeOriginalSizes: [maxAttachmentFileBytes],
      pendingOriginalSizes: [mebibyte]
    })).toBe(0);
    expect(selectSecureShareCopyAttachmentStarts({
      activeOriginalSizes: [],
      pendingOriginalSizes: [10 * mebibyte, 10 * mebibyte, 10 * mebibyte, 10 * mebibyte]
    })).toBe(3);
    expect(selectSecureShareCopyAttachmentStarts({
      activeOriginalSizes: [],
      pendingOriginalSizes: [30 * mebibyte, 30 * mebibyte]
    })).toBe(1);
  });

  it("creates an independent personal note and re-encrypts attachments", async () => {
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

  it("bounds attachment work to three tasks and propagates one cancellable signal", async () => {
    const deps = dependencies();
    const attachments = Array.from({ length: 5 }, (_, index) =>
      attachment(`attachment_${index}123456`, `report-${index}.pdf`)
    );
    const source = payload(attachments);
    const gates = new Map(
      attachments.map(({ id }) => [id, deferred<Blob>()])
    );
    let activeDownloads = 0;
    let maximumActiveDownloads = 0;

    vi.mocked(source.copyAttachment).mockImplementation(async (metadata, taskSignal) => {
      expect(taskSignal?.aborted).toBe(false);
      activeDownloads += 1;
      maximumActiveDownloads = Math.max(maximumActiveDownloads, activeDownloads);

      try {
        return await gates.get(metadata.id)!.promise;
      } finally {
        activeDownloads -= 1;
      }
    });

    const saving = saveSecureShareCopy({
      payload: source,
      privateKey,
      profile,
      signal: new AbortController().signal
    }, deps);

    await vi.waitFor(() => expect(source.copyAttachment).toHaveBeenCalledTimes(3));
    expect(maximumActiveDownloads).toBe(3);

    gates.get(attachments[0].id)!.resolve(
      new Blob([new Uint8Array([1, 2, 3, 4])], { type: "application/pdf" })
    );
    await vi.waitFor(() => expect(source.copyAttachment).toHaveBeenCalledTimes(4));
    gates.get(attachments[1].id)!.resolve(
      new Blob([new Uint8Array([1, 2, 3, 4])], { type: "application/pdf" })
    );
    await vi.waitFor(() => expect(source.copyAttachment).toHaveBeenCalledTimes(5));

    for (const gate of gates.values()) {
      gate.resolve(new Blob([new Uint8Array([1, 2, 3, 4])], {
        type: "application/pdf"
      }));
    }

    await expect(saving).resolves.toEqual({ noteId: "new_note_123456" });
    expect(maximumActiveDownloads).toBe(3);
    expect(deps.createNoteAttachment).toHaveBeenCalledTimes(5);
    const uploadSignals = vi.mocked(deps.createNoteAttachment).mock.calls.map(
      ([input]) => input.signal
    );
    expect(uploadSignals.every((taskSignal) =>
      taskSignal instanceof AbortSignal && !taskSignal.aborted
    )).toBe(true);
  });

  it("runs a maximum-size attachment alone between smaller queued files", async () => {
    const deps = dependencies();
    const attachments = [
      attachment("attachment_123456", "small-first.pdf"),
      attachment("attachment_234567", "large.pdf", maxAttachmentFileBytes),
      attachment("attachment_345678", "small-last.pdf")
    ];
    const source = payload(attachments);
    const gates = new Map(
      attachments.map(({ id }) => [id, deferred<Blob>()])
    );

    vi.mocked(source.copyAttachment).mockImplementation((metadata) =>
      gates.get(metadata.id)!.promise
    );

    const saving = saveSecureShareCopy({
      payload: source,
      privateKey,
      profile,
      signal: new AbortController().signal
    }, deps);

    await vi.waitFor(() => expect(source.copyAttachment).toHaveBeenCalledTimes(1));
    expect(vi.mocked(source.copyAttachment).mock.calls[0]?.[0].id)
      .toBe(attachments[0].id);

    gates.get(attachments[0].id)!.resolve(metadataOnlyBlob(attachments[0].originalSize));
    await vi.waitFor(() => expect(source.copyAttachment).toHaveBeenCalledTimes(2));
    expect(vi.mocked(source.copyAttachment).mock.calls[1]?.[0].id)
      .toBe(attachments[1].id);
    expect(source.copyAttachment).toHaveBeenCalledTimes(2);

    gates.get(attachments[1].id)!.resolve(metadataOnlyBlob(attachments[1].originalSize));
    await vi.waitFor(() => expect(source.copyAttachment).toHaveBeenCalledTimes(3));
    expect(vi.mocked(source.copyAttachment).mock.calls[2]?.[0].id)
      .toBe(attachments[2].id);
    gates.get(attachments[2].id)!.resolve(metadataOnlyBlob(attachments[2].originalSize));

    await expect(saving).resolves.toEqual({ noteId: "new_note_123456" });
  });

  it("compensates uploaded objects and soft-deletes revision 1 without mutating the source share", async () => {
    const deps = dependencies();
    const source = payload([
      attachment("attachment_123456", "report.pdf"),
      attachment("attachment_234567", "second.pdf")
    ]);
    const failSecondCopy = deferred<Blob>();
    vi.mocked(source.copyAttachment).mockImplementation((metadata) =>
      metadata.id === "attachment_123456"
        ? Promise.resolve(new Blob([new Uint8Array([1, 2, 3, 4])], {
            type: "application/pdf"
          }))
        : failSecondCopy.promise
    );
    vi.mocked(deps.createNoteAttachment).mockImplementation(async () => {
      failSecondCopy.reject(new Error("copy failed"));
      return { id: "new_attachment_123456" } as never;
    });

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

  it("waits for concurrent uploads to settle and cleans successful objects in reverse input order", async () => {
    const deps = dependencies();
    const source = payload([
      attachment("attachment_123456", "first.pdf"),
      attachment("attachment_234567", "second.pdf"),
      attachment("attachment_345678", "third.pdf"),
      attachment("attachment_456789", "fourth.pdf")
    ]);
    const uploadGates = [
      deferred<{ id: string }>(),
      deferred<{ id: string }>(),
      deferred<{ id: string }>()
    ];

    vi.mocked(deps.createNoteAttachment).mockImplementation((input) => {
      const index = ["first", "second", "third"].indexOf(input.fileName);

      if (index < 0) {
        throw new Error("a fourth task must not start after failure");
      }
      return uploadGates[index].promise as never;
    });

    const saving = saveSecureShareCopy({
      payload: source,
      privateKey,
      profile,
      signal: new AbortController().signal
    }, deps);
    const savingResult = saving.catch((error: unknown) => error);

    await vi.waitFor(() => expect(deps.createNoteAttachment).toHaveBeenCalledTimes(3));
    uploadGates[1].reject(new Error("upload failed"));
    await vi.waitFor(() => {
      const signals = vi.mocked(deps.createNoteAttachment).mock.calls.map(
        ([input]) => input.signal
      );
      expect(signals.every((taskSignal) => taskSignal?.aborted)).toBe(true);
    });
    expect(deps.deleteNoteAttachment).not.toHaveBeenCalled();

    uploadGates[0].resolve({ id: "new_attachment_first" });
    uploadGates[2].resolve({ id: "new_attachment_third" });

    await expect(savingResult).resolves.toMatchObject({ code: "save_failed" });
    expect(deps.createNoteAttachment).toHaveBeenCalledTimes(3);
    expect(vi.mocked(deps.deleteNoteAttachment).mock.calls).toEqual([
      ["new_note_123456", "new_attachment_third"],
      ["new_note_123456", "new_attachment_first"]
    ]);
    expect(deps.abortSecureShareCopyingNote).toHaveBeenCalledTimes(1);
  });

  it("re-cleans a leaked reservation target after sibling uploads settle", async () => {
    const deps = dependencies();
    const source = payload([
      attachment("attachment_123456", "first.pdf"),
      attachment("attachment_234567", "second.pdf")
    ]);
    const firstFailureGate = deferred<void>();
    const secondUploadGate = deferred<{ id: string }>();

    vi.mocked(deps.createNoteAttachment).mockImplementation(async (input) => {
      if (input.fileName === "first") {
        await firstFailureGate.promise;
        throw new BlobAttachmentReservationCleanupError(
          {
            attachmentId: "reserved_attachment_first",
            noteId: "new_note_123456",
            scope: "note"
          },
          new DOMException("upload cancelled", "AbortError"),
          new Error("reservation delete failed")
        );
      }

      return secondUploadGate.promise as never;
    });

    const saving = saveSecureShareCopy({
      payload: source,
      privateKey,
      profile,
      signal: new AbortController().signal
    }, deps);
    const savingResult = saving.catch((error: unknown) => error);

    await vi.waitFor(() => expect(deps.createNoteAttachment).toHaveBeenCalledTimes(2));
    firstFailureGate.resolve(undefined);
    await vi.waitFor(() => {
      const signals = vi.mocked(deps.createNoteAttachment).mock.calls.map(
        ([input]) => input.signal
      );
      expect(signals.every((taskSignal) => taskSignal?.aborted)).toBe(true);
    });
    expect(deps.deleteNoteAttachment).not.toHaveBeenCalled();

    secondUploadGate.resolve({ id: "new_attachment_second" });

    await expect(savingResult).resolves.toMatchObject({ code: "save_failed" });
    expect(vi.mocked(deps.deleteNoteAttachment).mock.calls).toEqual([
      ["new_note_123456", "new_attachment_second"],
      ["new_note_123456", "reserved_attachment_first"]
    ]);
    expect(deps.abortSecureShareCopyingNote).toHaveBeenCalledTimes(1);
  });

  it("reports incomplete cleanup when a leaked reservation cannot be re-cleaned", async () => {
    const deps = dependencies();
    vi.mocked(deps.createNoteAttachment).mockRejectedValue(
      new BlobAttachmentReservationCleanupError(
        {
          attachmentId: "reserved_attachment_123456",
          noteId: "new_note_123456",
          scope: "note"
        },
        new DOMException("upload cancelled", "AbortError"),
        new Error("reservation delete failed")
      )
    );
    vi.mocked(deps.deleteNoteAttachment).mockRejectedValue(
      new Error("reservation still cannot be deleted")
    );

    await expect(saveSecureShareCopy({
      payload: payload(),
      privateKey,
      profile,
      signal: new AbortController().signal
    }, deps)).rejects.toMatchObject({ code: "cleanup_incomplete" });

    expect(deps.deleteNoteAttachment).toHaveBeenCalledTimes(2);
    expect(deps.deleteNoteAttachment).toHaveBeenNthCalledWith(
      1,
      "new_note_123456",
      "reserved_attachment_123456"
    );
    expect(deps.abortSecureShareCopyingNote).toHaveBeenCalledTimes(1);
  });

  it("uses the same compensation path when cancellation arrives during upload", async () => {
    const deps = dependencies();
    const controller = new AbortController();
    const source = payload();
    vi.mocked(deps.createNoteAttachment).mockImplementation(async (input) => {
      controller.abort();
      expect(input.signal?.aborted).toBe(true);
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
