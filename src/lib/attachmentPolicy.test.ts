import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import {
  attachmentReadyAction,
  canDeleteNoteAttachmentPolicy,
  canReadNoteAttachmentPolicy,
  canUploadNoteAttachmentPolicy,
  isValidEncryptedFileNamePayload,
  publicAttachmentSourceAvailablePolicy,
  publicShareGenericAttachmentBaseName,
  quotaReleaseAfterAttachmentClaim,
  shouldBumpAttachmentRevisionOnDelete,
  shouldRetainPendingDeletionReservation
} from "../../api/_attachment-policy.js";

const baseActor = {
  callerIsActive: true,
  callerIsAdmin: false,
  uid: "participant",
  ownerUid: "owner",
  participantUids: ["owner", "participant"],
  noteIsDeleted: false,
  noteIsPurged: false,
  ownerIsActive: true,
  ownerIsAdmin: false,
  ownerAllowedShareTargetUids: ["participant"]
};

describe("attachment backend policies", () => {
  it("accepts only strict encrypted public filenames and derives non-sensitive generic names", () => {
    const payload = {
      version: 1 as const,
      algorithm: "AES-GCM" as const,
      cipherText: Buffer.alloc(17).toString("base64"),
      iv: Buffer.alloc(12).toString("base64")
    };

    expect(publicShareGenericAttachmentBaseName("pdf")).toBe("shared-pdf-attachment");
    expect(isValidEncryptedFileNamePayload(payload)).toBe(true);
    expect(isValidEncryptedFileNamePayload({ ...payload, extra: "plaintext.pdf" })).toBe(false);
    expect(isValidEncryptedFileNamePayload({ ...payload, cipherText: Buffer.alloc(16).toString("base64") })).toBe(false);
    expect(isValidEncryptedFileNamePayload({ ...payload, iv: Buffer.alloc(11).toString("base64") })).toBe(false);
    expect(isValidEncryptedFileNamePayload({ ...payload, cipherText: "not-base64" })).toBe(false);
  });

  it("enforces active identity, owner allowlists, and uploader-only participant deletion", () => {
    expect(canReadNoteAttachmentPolicy(baseActor)).toBe(true);
    expect(canUploadNoteAttachmentPolicy(baseActor)).toBe(true);
    expect(canDeleteNoteAttachmentPolicy({ ...baseActor, uploadedBy: "participant" })).toBe(true);
    expect(canDeleteNoteAttachmentPolicy({ ...baseActor, uploadedBy: "owner" })).toBe(false);
    expect(canUploadNoteAttachmentPolicy({ ...baseActor, callerIsActive: false })).toBe(false);
    expect(canReadNoteAttachmentPolicy({ ...baseActor, ownerIsActive: false })).toBe(false);
    expect(canReadNoteAttachmentPolicy({ ...baseActor, ownerAllowedShareTargetUids: [] })).toBe(false);
  });

  it("keeps active admins and owners authorized without granting purged-note reads", () => {
    expect(canReadNoteAttachmentPolicy({
      ...baseActor,
      callerIsAdmin: true,
      ownerIsActive: false,
      ownerAllowedShareTargetUids: []
    })).toBe(true);
    expect(canDeleteNoteAttachmentPolicy({
      ...baseActor,
      callerIsAdmin: true,
      ownerIsActive: false,
      ownerAllowedShareTargetUids: [],
      uploadedBy: "owner"
    })).toBe(true);
    expect(canReadNoteAttachmentPolicy({ ...baseActor, uid: "owner", noteIsDeleted: true })).toBe(true);
    expect(canReadNoteAttachmentPolicy({ ...baseActor, uid: "owner", noteIsPurged: true })).toBe(false);
    expect(canUploadNoteAttachmentPolicy({ ...baseActor, noteIsDeleted: true })).toBe(false);
    expect(canDeleteNoteAttachmentPolicy({ ...baseActor, noteIsDeleted: true, uploadedBy: "participant" })).toBe(false);
  });

  it("allows public staging across a revision mismatch but requires both revisions for reads", () => {
    const source = {
      ownerIsActive: true,
      shareOwnerUid: "owner",
      noteOwnerUid: "owner",
      noteIsDeleted: false,
      noteIsPurged: false,
      shareSourceRevision: 8,
      noteRevision: 9,
      shareSourceAttachmentRevision: 3,
      noteAttachmentRevision: 4
    };

    expect(publicAttachmentSourceAvailablePolicy({ ...source, requireMatchingRevision: false })).toBe(true);
    expect(publicAttachmentSourceAvailablePolicy({ ...source, requireMatchingRevision: true })).toBe(false);
    expect(publicAttachmentSourceAvailablePolicy({
      ...source,
      requireMatchingRevision: true,
      shareSourceRevision: 9,
      shareSourceAttachmentRevision: 4
    })).toBe(true);
    expect(publicAttachmentSourceAvailablePolicy({ ...source, requireMatchingRevision: false, noteIsPurged: true })).toBe(false);
    expect(publicAttachmentSourceAvailablePolicy({ ...source, requireMatchingRevision: false, ownerIsActive: false })).toBe(false);
  });

  it("makes ready callbacks idempotent and blocks callbacks after deletion starts", () => {
    expect(attachmentReadyAction({ isReady: true, deletionStarted: false })).toBe("already-ready");
    expect(attachmentReadyAction({ isReady: false, deletionStarted: true })).toBe("blocked");
    expect(attachmentReadyAction({ isReady: false, deletionStarted: false })).toBe("commit");
    expect(shouldBumpAttachmentRevisionOnDelete({
      scope: "note",
      alreadyBumped: false,
      hasReadyField: true,
      isReady: true
    })).toBe(true);
    expect(shouldBumpAttachmentRevisionOnDelete({
      scope: "note",
      alreadyBumped: false,
      hasReadyField: true,
      isReady: false
    })).toBe(false);
    expect(shouldRetainPendingDeletionReservation({ hasReadyField: true, isReady: false })).toBe(true);
    expect(shouldRetainPendingDeletionReservation({ hasReadyField: false, isReady: false })).toBe(false);
    expect(shouldBumpAttachmentRevisionOnDelete({
      scope: "note",
      alreadyBumped: false,
      hasReadyField: false,
      isReady: false
    })).toBe(true);
    expect(shouldBumpAttachmentRevisionOnDelete({
      scope: "publicShare",
      alreadyBumped: false,
      hasReadyField: true,
      isReady: true
    })).toBe(false);
  });

  it("computes a bounded quota release only while the attachment precondition is claimable", () => {
    expect(quotaReleaseAfterAttachmentClaim({
      attachmentExists: true,
      attachmentUpdateTime: "attachment-v1",
      attachmentCount: 2,
      encryptedSize: 60,
      quotaReserved: true,
      legacyBlobReserved: false,
      quotaExists: true,
      quotaUpdateTime: "quota-v1",
      uid: "owner",
      usedBytes: 100
    })).toEqual({
      attachmentUpdateTime: "attachment-v1",
      quota: {
        attachmentCount: 1,
        quotaUpdateTime: "quota-v1",
        uid: "owner",
        usedBytes: 40
      }
    });
    expect(quotaReleaseAfterAttachmentClaim({
      attachmentExists: false,
      attachmentUpdateTime: "",
      attachmentCount: 2,
      encryptedSize: 60,
      quotaReserved: true,
      legacyBlobReserved: false,
      quotaExists: true,
      quotaUpdateTime: "quota-v1",
      uid: "owner",
      usedBytes: 100
    })).toBeNull();
    expect(quotaReleaseAfterAttachmentClaim({
      attachmentExists: true,
      attachmentUpdateTime: "legacy-attachment",
      attachmentCount: 2,
      encryptedSize: 60,
      quotaReserved: null,
      legacyBlobReserved: true,
      quotaExists: true,
      quotaUpdateTime: "quota-v1",
      uid: "owner",
      usedBytes: 100
    })).toEqual({
      attachmentUpdateTime: "legacy-attachment",
      quota: {
        attachmentCount: 2,
        quotaUpdateTime: "quota-v1",
        uid: "owner",
        usedBytes: 40
      }
    });
    expect(quotaReleaseAfterAttachmentClaim({
      attachmentExists: true,
      attachmentUpdateTime: "legacy-storage",
      attachmentCount: 2,
      encryptedSize: 60,
      quotaReserved: null,
      legacyBlobReserved: false,
      quotaExists: true,
      quotaUpdateTime: "quota-v1",
      uid: "owner",
      usedBytes: 100
    })).toEqual({ attachmentUpdateTime: "legacy-storage", quota: null });
    expect(quotaReleaseAfterAttachmentClaim({
      attachmentExists: true,
      attachmentUpdateTime: "zero-byte-new",
      attachmentCount: 1,
      encryptedSize: 0,
      quotaReserved: true,
      legacyBlobReserved: false,
      quotaExists: true,
      quotaUpdateTime: "quota-v2",
      uid: "owner",
      usedBytes: 0
    })).toEqual({
      attachmentUpdateTime: "zero-byte-new",
      quota: {
        attachmentCount: 0,
        quotaUpdateTime: "quota-v2",
        uid: "owner",
        usedBytes: 0
      }
    });
  });
});
