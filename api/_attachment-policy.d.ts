export interface AttachmentActorPolicyInput {
  callerIsActive: boolean;
  callerIsAdmin: boolean;
  uid: string;
  ownerUid: string;
  participantUids: string[];
  noteIsDeleted: boolean;
  noteIsPurged: boolean;
  ownerIsActive: boolean;
  ownerIsAdmin: boolean;
  ownerAllowedShareTargetUids: string[];
}

export interface AttachmentDeletePolicyInput extends AttachmentActorPolicyInput {
  uploadedBy: string;
}

export interface PublicAttachmentSourcePolicyInput {
  ownerIsActive: boolean;
  shareOwnerUid: string;
  noteOwnerUid: string;
  noteIsDeleted: boolean;
  noteIsPurged: boolean;
  requireMatchingRevision: boolean;
  shareSourceRevision: number;
  noteRevision: number;
  shareSourceAttachmentRevision: number;
  noteAttachmentRevision: number;
}

export interface QuotaReleaseClaimInput {
  attachmentExists: boolean;
  attachmentUpdateTime: string;
  attachmentCount: number;
  encryptedSize: number;
  quotaReserved: boolean | null;
  legacyBlobReserved: boolean;
  quotaExists: boolean;
  quotaUpdateTime: string;
  uid: string;
  usedBytes: number;
}

export function publicShareGenericAttachmentBaseName(extension: string): string;
export function isValidEncryptedFileNamePayload(value: unknown): value is {
  version: 1;
  algorithm: "AES-GCM";
  cipherText: string;
  iv: string;
};

export function ownerAllowsAttachmentParticipant(input: Pick<
  AttachmentActorPolicyInput,
  "uid" | "ownerUid" | "ownerIsActive" | "ownerIsAdmin" | "ownerAllowedShareTargetUids"
>): boolean;
export function canReadNoteAttachmentPolicy(input: AttachmentActorPolicyInput): boolean;
export function canUploadNoteAttachmentPolicy(input: AttachmentActorPolicyInput): boolean;
export function canDeleteNoteAttachmentPolicy(input: AttachmentDeletePolicyInput): boolean;
export function publicAttachmentSourceAvailablePolicy(input: PublicAttachmentSourcePolicyInput): boolean;
export function attachmentReadyAction(input: {
  isReady: boolean;
  deletionStarted: boolean;
}): "already-ready" | "blocked" | "commit";
export function shouldBumpAttachmentRevisionOnDelete(input: {
  scope: "note" | "publicShare";
  alreadyBumped: boolean;
  hasReadyField: boolean;
  isReady: boolean;
}): boolean;
export function shouldRetainPendingDeletionReservation(input: {
  hasReadyField: boolean;
  isReady: boolean;
}): boolean;
export function quotaReleaseAfterAttachmentClaim(input: QuotaReleaseClaimInput): {
  attachmentUpdateTime: string;
  quota: null | {
    attachmentCount: number;
    quotaUpdateTime: string;
    uid: string;
    usedBytes: number;
  };
} | null;
