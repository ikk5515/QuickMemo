import { Buffer } from "node:buffer";

function canonicalBase64ByteLength(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    return -1;
  }

  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes.byteLength : -1;
}

export function publicShareGenericAttachmentBaseName(extension) {
  return `shared-${extension}-attachment`;
}

export function isValidEncryptedFileNamePayload(value) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "algorithm,cipherText,iv,version"
    || value.version !== 1
    || value.algorithm !== "AES-GCM"
  ) {
    return false;
  }

  const cipherTextBytes = canonicalBase64ByteLength(value.cipherText);
  const ivBytes = canonicalBase64ByteLength(value.iv);
  return cipherTextBytes >= 17 && cipherTextBytes <= 768 && ivBytes === 12;
}

export function ownerAllowsAttachmentParticipant(input) {
  return input.uid === input.ownerUid
    || (
      input.ownerIsActive === true
      && (
        input.ownerIsAdmin === true
        || input.ownerAllowedShareTargetUids.includes(input.uid)
      )
    );
}

export function canReadNoteAttachmentPolicy(input) {
  if (!input.callerIsActive || input.noteIsPurged) {
    return false;
  }

  if (input.noteIsDeleted) {
    return input.callerIsAdmin || input.uid === input.ownerUid;
  }

  if (input.callerIsAdmin || input.uid === input.ownerUid) {
    return true;
  }

  return input.participantUids.includes(input.uid)
    && ownerAllowsAttachmentParticipant(input);
}

export function canUploadNoteAttachmentPolicy(input) {
  return input.callerIsActive === true
    && !input.noteIsDeleted
    && !input.noteIsPurged
    && input.participantUids.includes(input.uid)
    && ownerAllowsAttachmentParticipant(input);
}

export function canDeleteNoteAttachmentPolicy(input) {
  if (!input.callerIsActive) {
    return false;
  }

  if (input.callerIsAdmin || input.uid === input.ownerUid) {
    return true;
  }

  return !input.noteIsDeleted
    && !input.noteIsPurged
    && input.participantUids.includes(input.uid)
    && input.uploadedBy === input.uid
    && ownerAllowsAttachmentParticipant(input);
}

export function publicAttachmentSourceAvailablePolicy(input) {
  if (
    !input.ownerIsActive
    || input.shareOwnerUid !== input.noteOwnerUid
    || input.noteIsDeleted
    || input.noteIsPurged
  ) {
    return false;
  }

  if (!input.requireMatchingRevision) {
    return true;
  }

  return input.shareSourceRevision === input.noteRevision
    && input.shareSourceAttachmentRevision === input.noteAttachmentRevision;
}

export function attachmentReadyAction(input) {
  if (input.isReady) {
    return "already-ready";
  }

  if (input.deletionStarted) {
    return "blocked";
  }

  return "commit";
}

export function shouldBumpAttachmentRevisionOnDelete(input) {
  return input.scope === "note"
    && !input.alreadyBumped
    && (!input.hasReadyField || input.isReady === true);
}

export function shouldRetainPendingDeletionReservation(input) {
  return input.hasReadyField && input.isReady === false;
}

export function quotaReleaseAfterAttachmentClaim(input) {
  if (!input.attachmentExists || !input.attachmentUpdateTime) {
    return null;
  }

  const bytes = Math.max(0, input.encryptedSize);

  const releaseLegacyBlobBytes = input.quotaReserved === null && input.legacyBlobReserved;
  const releaseNewReservation = input.quotaReserved === true;

  if (
    (!releaseLegacyBlobBytes && !releaseNewReservation)
    || !input.quotaExists
    || !input.quotaUpdateTime
    || !input.uid
    || (bytes <= 0 && !releaseNewReservation)
  ) {
    return {
      attachmentUpdateTime: input.attachmentUpdateTime,
      quota: null
    };
  }

  return {
    attachmentUpdateTime: input.attachmentUpdateTime,
    quota: {
      attachmentCount: releaseNewReservation
        ? Math.max(0, input.attachmentCount - 1)
        : Math.max(0, input.attachmentCount),
      quotaUpdateTime: input.quotaUpdateTime,
      uid: input.uid,
      usedBytes: Math.max(0, input.usedBytes - bytes)
    }
  };
}
