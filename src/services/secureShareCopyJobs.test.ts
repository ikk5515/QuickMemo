import { describe, expect, it, vi } from "vitest";
import type { NoteSnapshot } from "./notes";
import { reapStaleSecureShareCopyJobs } from "./secureShareCopyJobs";

function copyingNote(overrides: Partial<NoteSnapshot> = {}): NoteSnapshot {
  return {
    id: "note-copy-123",
    type: "personal",
    ownerUid: "user-a",
    participantUids: ["user-a"],
    encryptedTitle: {
      version: 1,
      algorithm: "AES-GCM",
      cipherText: "cipher",
      iv: "iv"
    },
    encryptedBody: {
      version: 1,
      algorithm: "AES-GCM",
      cipherText: "cipher",
      iv: "iv"
    },
    wrappedKeys: {},
    updatedBy: "user-a",
    revision: 1,
    secureShareCopyState: "copying",
    secureShareCopyJobId: "copy_job_1234567890",
    secureShareCopyExpectedAttachmentCount: 2,
    secureShareCopyReservedAttachmentCount: 2,
    secureShareCopyReadyAttachmentCount: 2,
    ...overrides
  };
}

function dependencies(notes: NoteSnapshot[]) {
  return {
    abortSecureShareCopyingNote: vi.fn(async () => ({
      lastMutationId: "abort-mutation",
      noteId: "note-copy-123",
      revision: 2
    })),
    activateSecureShareCopyingNote: vi.fn(async () => ({
      noteId: "note-copy-123",
      state: "active" as const
    })),
    deleteNoteAttachment: vi.fn(async () => undefined),
    getAllNoteAttachments: vi.fn(async () => []),
    listStaleSecureShareCopyingNotes: vi.fn(async () => notes),
    now: vi.fn(() => Date.parse("2026-07-28T12:00:00.000Z"))
  } as unknown as NonNullable<Parameters<typeof reapStaleSecureShareCopyJobs>[1]>;
}

describe("secure share copy job recovery", () => {
  it("retries the atomic activation when every reserved attachment is ready", async () => {
    const deps = dependencies([copyingNote()]);

    await expect(reapStaleSecureShareCopyJobs("user-a", deps)).resolves.toEqual({
      aborted: 0,
      activated: 1,
      retained: 0,
      scanned: 1
    });

    expect(deps.activateSecureShareCopyingNote).toHaveBeenCalledWith({
      copyJobId: "copy_job_1234567890",
      expectedRevision: 1,
      noteId: "note-copy-123",
      uid: "user-a"
    });
    expect(deps.getAllNoteAttachments).not.toHaveBeenCalled();
  });

  it("deletes incomplete job attachments before audited abort", async () => {
    const deps = dependencies([copyingNote({
      secureShareCopyReservedAttachmentCount: 2,
      secureShareCopyReadyAttachmentCount: 1
    })]);
    vi.mocked(deps.getAllNoteAttachments).mockResolvedValue([
      {
        id: "attachment-a",
        noteId: "note-copy-123",
        version: 1,
        algorithm: "AES-GCM",
        fileName: "a.pdf",
        extension: "pdf",
        mimeType: "application/pdf",
        originalSize: 4,
        uploadedBy: "user-a",
        secureShareCopyJobId: "copy_job_1234567890"
      },
      {
        id: "attachment-b",
        noteId: "note-copy-123",
        version: 1,
        algorithm: "AES-GCM",
        fileName: "b.pdf",
        extension: "pdf",
        mimeType: "application/pdf",
        originalSize: 4,
        uploadedBy: "user-a",
        secureShareCopyJobId: "copy_job_1234567890"
      }
    ]);

    await expect(reapStaleSecureShareCopyJobs("user-a", deps)).resolves.toEqual({
      aborted: 1,
      activated: 0,
      retained: 0,
      scanned: 1
    });

    expect(deps.deleteNoteAttachment).toHaveBeenNthCalledWith(
      1,
      "note-copy-123",
      "attachment-a"
    );
    expect(deps.deleteNoteAttachment).toHaveBeenNthCalledWith(
      2,
      "note-copy-123",
      "attachment-b"
    );
    expect(vi.mocked(deps.abortSecureShareCopyingNote).mock.invocationCallOrder[0])
      .toBeGreaterThan(vi.mocked(deps.deleteNoteAttachment).mock.invocationCallOrder[1]);
  });

  it("retains an inconsistent or partially cleaned job for a later safe retry", async () => {
    const deps = dependencies([copyingNote({
      secureShareCopyReservedAttachmentCount: 1,
      secureShareCopyReadyAttachmentCount: 0
    })]);
    vi.mocked(deps.getAllNoteAttachments).mockResolvedValue([{
      id: "foreign-attachment",
      noteId: "note-copy-123",
      version: 1,
      algorithm: "AES-GCM",
      fileName: "foreign.pdf",
      extension: "pdf",
      mimeType: "application/pdf",
      originalSize: 4,
      uploadedBy: "user-a",
      secureShareCopyJobId: "different_copy_job"
    }]);

    await expect(reapStaleSecureShareCopyJobs("user-a", deps)).resolves.toEqual({
      aborted: 0,
      activated: 0,
      retained: 1,
      scanned: 1
    });

    expect(deps.deleteNoteAttachment).not.toHaveBeenCalled();
    expect(deps.abortSecureShareCopyingNote).not.toHaveBeenCalled();
  });

  it("leaves a server-claimed job exclusively to the cleanup Cron", async () => {
    const deps = dependencies([copyingNote({
      secureShareCopyCleanupClaimId:
        "copy_cleanup_claim_1234567890abcdef1234567890abcdef"
    })]);

    await expect(reapStaleSecureShareCopyJobs("user-a", deps)).resolves.toEqual({
      aborted: 0,
      activated: 0,
      retained: 1,
      scanned: 1
    });

    expect(deps.activateSecureShareCopyingNote).not.toHaveBeenCalled();
    expect(deps.getAllNoteAttachments).not.toHaveBeenCalled();
    expect(deps.deleteNoteAttachment).not.toHaveBeenCalled();
    expect(deps.abortSecureShareCopyingNote).not.toHaveBeenCalled();
  });
});
