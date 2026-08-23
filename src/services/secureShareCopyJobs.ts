import {
  abortSecureShareCopyingNote,
  activateSecureShareCopyingNote,
  deleteNoteAttachment,
  getAllNoteAttachments,
  listStaleSecureShareCopyingNotes
} from "./notes";

const staleSecureShareCopyAgeMs = 24 * 60 * 60 * 1000;
const recoveryBatchSize = 20;
const recoveryRuns = new Map<string, Promise<SecureShareCopyRecoveryReport>>();

export interface SecureShareCopyRecoveryReport {
  aborted: number;
  activated: number;
  retained: number;
  scanned: number;
}

interface SecureShareCopyRecoveryDependencies {
  abortSecureShareCopyingNote: typeof abortSecureShareCopyingNote;
  activateSecureShareCopyingNote: typeof activateSecureShareCopyingNote;
  deleteNoteAttachment: typeof deleteNoteAttachment;
  getAllNoteAttachments: typeof getAllNoteAttachments;
  listStaleSecureShareCopyingNotes: typeof listStaleSecureShareCopyingNotes;
  now: () => number;
}

const defaultDependencies: SecureShareCopyRecoveryDependencies = {
  abortSecureShareCopyingNote,
  activateSecureShareCopyingNote,
  deleteNoteAttachment,
  getAllNoteAttachments,
  listStaleSecureShareCopyingNotes,
  now: Date.now
};

async function deleteAttachmentWithRetry(
  noteId: string,
  attachmentId: string,
  dependency: typeof deleteNoteAttachment
) {
  let lastError: unknown;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await dependency(noteId, attachmentId);
      return;
    } catch (caught) {
      lastError = caught;
    }
  }

  throw lastError;
}

async function runRecovery(
  uid: string,
  dependencies: SecureShareCopyRecoveryDependencies
): Promise<SecureShareCopyRecoveryReport> {
  const report: SecureShareCopyRecoveryReport = {
    aborted: 0,
    activated: 0,
    retained: 0,
    scanned: 0
  };
  const cutoff = new Date(dependencies.now() - staleSecureShareCopyAgeMs);
  const notes = await dependencies.listStaleSecureShareCopyingNotes(
    uid,
    cutoff,
    recoveryBatchSize
  );
  report.scanned = notes.length;

  for (const note of notes) {
    const copyJobId = note.secureShareCopyJobId;
    const expectedCount = note.secureShareCopyExpectedAttachmentCount;
    const reservedCount = note.secureShareCopyReservedAttachmentCount;
    const readyCount = note.secureShareCopyReadyAttachmentCount;
    const revision = note.revision;

    if (
      note.ownerUid !== uid
      || note.secureShareCopyState !== "copying"
      || Boolean(
        note.secureShareCopyCleanupClaimId
        || note.secureShareCopyCleanupClaimedAt
      )
      || !copyJobId
      || typeof expectedCount !== "number"
      || !Number.isSafeInteger(expectedCount)
      || typeof reservedCount !== "number"
      || !Number.isSafeInteger(reservedCount)
      || typeof readyCount !== "number"
      || !Number.isSafeInteger(readyCount)
      || typeof revision !== "number"
      || !Number.isSafeInteger(revision)
      || expectedCount < 0
      || expectedCount > 100
      || reservedCount < 0
      || reservedCount > expectedCount
      || readyCount < 0
      || readyCount > reservedCount
    ) {
      report.retained += 1;
      continue;
    }

    if (reservedCount === expectedCount && readyCount === expectedCount) {
      try {
        await dependencies.activateSecureShareCopyingNote({
          copyJobId,
          expectedRevision: revision,
          noteId: note.id,
          uid
        });
        report.activated += 1;
      } catch {
        report.retained += 1;
      }
      continue;
    }

    try {
      const attachments = await dependencies.getAllNoteAttachments(note.id);

      if (attachments.some((attachment) =>
        attachment.secureShareCopyJobId !== copyJobId
        || attachment.noteId !== note.id
      )) {
        report.retained += 1;
        continue;
      }

      for (const attachment of attachments) {
        await deleteAttachmentWithRetry(
          note.id,
          attachment.id,
          dependencies.deleteNoteAttachment
        );
      }

      await dependencies.abortSecureShareCopyingNote({
        copyJobId,
        expectedRevision: revision,
        noteId: note.id,
        uid
      });
      report.aborted += 1;
    } catch {
      // Keep the durable copying marker so a later login/focus pass can retry.
      report.retained += 1;
    }
  }

  return report;
}

export function reapStaleSecureShareCopyJobs(
  uid: string,
  dependencies: SecureShareCopyRecoveryDependencies = defaultDependencies
) {
  if (!/^[A-Za-z0-9_-]{1,160}$/u.test(uid)) {
    return Promise.resolve({
      aborted: 0,
      activated: 0,
      retained: 0,
      scanned: 0
    } satisfies SecureShareCopyRecoveryReport);
  }

  const existing = recoveryRuns.get(uid);
  if (existing) {
    return existing;
  }

  const run = runRecovery(uid, dependencies).finally(() => {
    if (recoveryRuns.get(uid) === run) {
      recoveryRuns.delete(uid);
    }
  });
  recoveryRuns.set(uid, run);
  return run;
}
