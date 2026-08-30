export const NOTE_ATTACHMENT_COUNT_LIMIT = 100;
export const NOTE_ATTACHMENT_COUNTER_ENFORCEMENT_VERSION = 2;
export const NOTE_ATTACHMENT_COUNTER_SCHEMA_VERSION = 1;
export const NOTE_ATTACHMENT_ROLLOUT_DRAIN_ACTIVE = (
  NOTE_ATTACHMENT_COUNTER_SCHEMA_VERSION < NOTE_ATTACHMENT_COUNTER_ENFORCEMENT_VERSION
);
export const NOTE_ATTACHMENT_COUNTER_FIELD_PATHS = Object.freeze([
  "schemaVersion",
  "noteId",
  "reservedCount",
  "limitCount",
  "state",
  "accountingMode"
]);
const NOTE_ATTACHMENT_COUNTER_MINIMUM_SCHEMA_VERSION = 1;

export function noteAttachmentCounterPath(noteId) {
  return `notes/${noteId}/serverCounters/attachmentsV1`;
}

export function noteAttachmentCounterName(projectId, noteId, databaseId = "(default)") {
  return `projects/${projectId}/databases/${databaseId}/documents/${noteAttachmentCounterPath(noteId)}`;
}

function nonNegativeIntegerField(document, fieldName) {
  const value = document?.fields?.[fieldName]?.integerValue;
  const parsed = typeof value === "string" || typeof value === "number"
    ? Number(value)
    : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function noteAttachmentCounterState(document, expectedNoteId) {
  if (!document) return "missing";
  const state = document?.fields?.state?.stringValue;
  const schemaVersion = nonNegativeIntegerField(document, "schemaVersion");
  const reservedCount = nonNegativeIntegerField(document, "reservedCount");
  const limitCount = nonNegativeIntegerField(document, "limitCount");
  const noteId = document?.fields?.noteId?.stringValue;
  const accountingMode = document?.fields?.accountingMode?.stringValue;
  const expectedAccountingMode = state === "open"
    ? "server_recount_per_reservation"
    : state === "closed"
      ? "closed_note_tombstone"
      : "";

  if (
    typeof document.updateTime !== "string"
    || !document.updateTime
    || (state !== "open" && state !== "closed")
    || schemaVersion === null
    || schemaVersion < NOTE_ATTACHMENT_COUNTER_MINIMUM_SCHEMA_VERSION
    || schemaVersion > NOTE_ATTACHMENT_COUNTER_SCHEMA_VERSION
    || reservedCount === null
    || reservedCount > NOTE_ATTACHMENT_COUNT_LIMIT
    || (state === "closed" && reservedCount !== 0)
    || limitCount !== NOTE_ATTACHMENT_COUNT_LIMIT
    || typeof noteId !== "string"
    || !noteId
    || (expectedNoteId !== undefined && noteId !== expectedNoteId)
    || accountingMode !== expectedAccountingMode
  ) {
    return "invalid";
  }

  return state;
}

export function noteAttachmentCounterWrite({
  counterDocument,
  counterName,
  noteId,
  reservedCount,
  state
}) {
  if (state !== "open" && state !== "closed") {
    throw new Error("Invalid note attachment counter state");
  }
  if (!Number.isSafeInteger(reservedCount) || reservedCount < 0) {
    throw new Error("Invalid note attachment reservation count");
  }
  if (
    reservedCount > NOTE_ATTACHMENT_COUNT_LIMIT
    || (state === "closed" && reservedCount !== 0)
  ) {
    throw new Error("Invalid note attachment reservation count for state");
  }

  let currentDocument;
  if (!counterDocument) {
    currentDocument = { exists: false };
  } else if (typeof counterDocument.updateTime === "string" && counterDocument.updateTime) {
    currentDocument = { updateTime: counterDocument.updateTime };
  } else {
    throw new Error("Invalid note attachment counter precondition");
  }

  return {
    update: {
      name: counterName,
      fields: {
        schemaVersion: { integerValue: String(NOTE_ATTACHMENT_COUNTER_SCHEMA_VERSION) },
        noteId: { stringValue: noteId },
        reservedCount: { integerValue: String(reservedCount) },
        limitCount: { integerValue: String(NOTE_ATTACHMENT_COUNT_LIMIT) },
        state: { stringValue: state },
        accountingMode: {
          stringValue: state === "open"
            ? "server_recount_per_reservation"
            : "closed_note_tombstone"
        }
      }
    },
    currentDocument,
    updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }]
  };
}
