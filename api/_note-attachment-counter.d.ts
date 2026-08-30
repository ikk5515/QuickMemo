export const NOTE_ATTACHMENT_COUNT_LIMIT: 100;
export const NOTE_READY_ATTACHMENT_COUNT_FIELD: "readyAttachmentCount";
export const NOTE_ATTACHMENT_COUNTER_ENFORCEMENT_VERSION: 2;
export const NOTE_ATTACHMENT_COUNTER_SCHEMA_VERSION: 2;
export const NOTE_ATTACHMENT_ROLLOUT_DRAIN_ACTIVE: boolean;
export const NOTE_ATTACHMENT_COUNTER_FIELD_PATHS: readonly [
  "schemaVersion",
  "noteId",
  "reservedCount",
  "limitCount",
  "state",
  "accountingMode"
];

export interface NoteAttachmentCounterDocument {
  fields?: Record<string, unknown>;
  updateTime?: string;
}

export type NoteAttachmentCounterState = "missing" | "open" | "closed" | "invalid";
export type NoteReadyAttachmentCountTransition =
  | { state: "unknown" }
  | { state: "invalid" }
  | { currentCount: number; nextCount: number; state: "write" };

export function noteReadyAttachmentCountTransition(
  document: NoteAttachmentCounterDocument | null | undefined,
  delta: 1 | -1
): NoteReadyAttachmentCountTransition;

export function noteAttachmentCounterPath(noteId: string): string;
export function noteAttachmentCounterName(
  projectId: string,
  noteId: string,
  databaseId?: string
): string;
export function noteAttachmentCounterState(
  document: NoteAttachmentCounterDocument | null | undefined,
  expectedNoteId?: string
): NoteAttachmentCounterState;
export function noteAttachmentCounterWrite(input: {
  counterDocument: NoteAttachmentCounterDocument | null;
  counterName: string;
  noteId: string;
  reservedCount: number;
  state: "open" | "closed";
}): Record<string, unknown>;
