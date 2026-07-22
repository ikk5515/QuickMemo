import {
  addDoc,
  collection,
  doc,
  getDocFromServer,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  Timestamp,
  updateDoc,
  writeBatch,
  where
} from "firebase/firestore";
import type { FieldValue } from "firebase/firestore";
import { db } from "../lib/firebase";
import { normalizeSchedulePriorityFlags, type SchedulePrioritySource } from "../lib/schedulePriority";
import type {
  EncryptedPayload,
  ScheduleTaskDetails,
  ScheduleTaskDocument,
  ScheduleTaskStatus,
  WrappedNoteKey
} from "../types";

export interface ScheduleTaskSnapshot extends ScheduleTaskDocument {
  id: string;
}

type RawScheduleTaskDocument = Omit<ScheduleTaskDocument, "status"> & SchedulePrioritySource & {
  status?: unknown;
};

export interface CreateScheduleTaskInput {
  ownerUid: string;
  title: EncryptedPayload;
  details: EncryptedPayload;
  wrappedKey: WrappedNoteKey;
  dueDate: string | null;
  dueTimeMinutes: number | null;
  startDate?: string | null;
  endDate?: string | null;
  startTimeMinutes?: number | null;
  endTimeMinutes?: number | null;
  color?: string | null;
  sortOrder?: number | null;
  progressPercent?: number | null;
  isImportant: boolean;
  isUrgent: boolean;
}

export interface UpdateScheduleTaskInput {
  encryptedTitle?: EncryptedPayload;
  encryptedDetails?: EncryptedPayload;
  dueDate?: string | null;
  dueTimeMinutes?: number | null;
  startDate?: string | null;
  endDate?: string | null;
  startTimeMinutes?: number | null;
  endTimeMinutes?: number | null;
  color?: string | null;
  sortOrder?: number | null;
  progressPercent?: number | null;
  isImportant?: boolean;
  isUrgent?: boolean;
  status?: ScheduleTaskStatus;
  completedAt?: FieldValue | Timestamp | null;
}

export interface UpdateScheduleTaskOptions {
  expectedUpdatedAt?: Timestamp;
  googleCalendarChanged?: boolean;
}

export type ScheduleTaskSaveConflictReason = "missing-or-forbidden" | "revision-mismatch";

export class ScheduleTaskRevisionConflictError extends Error {
  readonly code = "schedule-task/revision-conflict";
  readonly reason: ScheduleTaskSaveConflictReason;

  constructor(reason: ScheduleTaskSaveConflictReason) {
    super(
      reason === "revision-mismatch"
        ? "일정이 다른 곳에서 변경되었습니다. 최신 내용을 확인한 뒤 다시 저장해주세요."
        : "일정이 삭제되었거나 접근 권한이 변경되었습니다. 목록을 새로고침한 뒤 다시 시도해주세요."
    );
    this.name = "ScheduleTaskRevisionConflictError";
    this.reason = reason;
  }
}

const googleCalendarTaskFieldNames = new Set<keyof UpdateScheduleTaskInput>([
  "encryptedTitle",
  "dueDate",
  "dueTimeMinutes",
  "startDate",
  "endDate",
  "startTimeMinutes",
  "endTimeMinutes"
]);

function updateChangesGoogleCalendar(input: UpdateScheduleTaskInput) {
  return Object.keys(input).some((key) => googleCalendarTaskFieldNames.has(key as keyof UpdateScheduleTaskInput));
}

function timestampRevision(value: unknown) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const { seconds, nanoseconds } = value as { nanoseconds?: unknown; seconds?: unknown };

  if (
    !Number.isSafeInteger(seconds)
    || !Number.isInteger(nanoseconds)
    || (nanoseconds as number) < 0
    || (nanoseconds as number) > 999_999_999
  ) {
    return null;
  }

  return { nanoseconds: nanoseconds as number, seconds: seconds as number };
}

function timestampRevisionsMatch(current: unknown, expected: Timestamp) {
  const currentRevision = timestampRevision(current);
  const expectedRevision = timestampRevision(expected);

  return Boolean(
    currentRevision
    && expectedRevision
    && currentRevision.seconds === expectedRevision.seconds
    && currentRevision.nanoseconds === expectedRevision.nanoseconds
  );
}

export const defaultScheduleDetails: ScheduleTaskDetails = {
  description: "",
  checklist: []
};

export function normalizeScheduleTaskDocument(data: unknown): ScheduleTaskDocument {
  const task = data as RawScheduleTaskDocument;
  const status = task.status === "completed" || task.status === "archived" ? task.status : "active";

  return {
    ...task,
    ...normalizeSchedulePriorityFlags(task),
    status: status as ScheduleTaskDocument["status"]
  };
}

function snapshotList(snapshot: { docs: Array<{ id: string; data: () => unknown }> }) {
  return snapshot.docs.map((document) => ({ id: document.id, ...normalizeScheduleTaskDocument(document.data()) }));
}

export function subscribeScheduleTasks(uid: string, callback: (tasks: ScheduleTaskSnapshot[]) => void, onError?: (error: Error) => void) {
  const tasksQuery = query(collection(db, "scheduleTasks"), where("ownerUid", "==", uid));

  return onSnapshot(
    tasksQuery,
    (snapshot) => callback(snapshotList(snapshot)),
    (error) => onError?.(error)
  );
}

export async function getScheduleTask(taskId: string) {
  const snapshot = await getDocFromServer(doc(db, "scheduleTasks", taskId));

  return snapshot.exists() ? ({ id: snapshot.id, ...(snapshot.data() as ScheduleTaskDocument) } satisfies ScheduleTaskSnapshot) : null;
}

export async function createScheduleTask(input: CreateScheduleTaskInput) {
  return addDoc(collection(db, "scheduleTasks"), {
    ownerUid: input.ownerUid,
    status: "active",
    dueDate: input.dueDate,
    dueTimeMinutes: input.dueTimeMinutes,
    startDate: input.startDate ?? input.dueDate,
    endDate: input.endDate ?? input.startDate ?? input.dueDate,
    startTimeMinutes: input.startTimeMinutes ?? input.dueTimeMinutes,
    endTimeMinutes: input.endTimeMinutes ?? null,
    color: input.color ?? null,
    sortOrder: input.sortOrder ?? null,
    progressPercent: input.progressPercent ?? 0,
    isImportant: input.isImportant,
    isUrgent: input.isUrgent,
    encryptedTitle: input.title,
    encryptedDetails: input.details,
    wrappedKeys: {
      [input.ownerUid]: input.wrappedKey
    },
    createdBy: input.ownerUid,
    updatedBy: input.ownerUid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    calendarUpdatedAt: serverTimestamp(),
    completedAt: null
  });
}

export async function updateScheduleTask(
  taskId: string,
  uid: string,
  input: UpdateScheduleTaskInput,
  options: UpdateScheduleTaskOptions = {}
) {
  const googleCalendarChanged = options.googleCalendarChanged ?? updateChangesGoogleCalendar(input);
  const expectedUpdatedAt = options.expectedUpdatedAt;
  const taskRef = doc(db, "scheduleTasks", taskId);
  const update = {
    ...input,
    updatedBy: uid,
    updatedAt: serverTimestamp(),
    ...(googleCalendarChanged ? { calendarUpdatedAt: serverTimestamp() } : {})
  };

  if (expectedUpdatedAt === undefined) {
    await updateDoc(taskRef, update);
    return;
  }

  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(taskRef);

    if (!snapshot.exists()) {
      throw new ScheduleTaskRevisionConflictError("missing-or-forbidden");
    }

    const currentTask = snapshot.data() as Partial<ScheduleTaskDocument>;

    if (currentTask.ownerUid !== uid) {
      throw new ScheduleTaskRevisionConflictError("missing-or-forbidden");
    }

    if (!timestampRevisionsMatch(currentTask.updatedAt, expectedUpdatedAt)) {
      throw new ScheduleTaskRevisionConflictError("revision-mismatch");
    }

    transaction.update(taskRef, update);
  });
}

export async function updateScheduleTaskOrderBatch(
  uid: string,
  updates: Array<{ taskId: string; sortOrder: number | null }>
) {
  const batch = writeBatch(db);

  updates.forEach((update) => {
    batch.update(doc(db, "scheduleTasks", update.taskId), {
      sortOrder: update.sortOrder,
      updatedBy: uid,
      updatedAt: serverTimestamp()
    });
  });

  await batch.commit();
}

export async function deleteScheduleTask(taskId: string) {
  const taskRef = doc(db, "scheduleTasks", taskId);
  const receiptRef = doc(db, "googleCalendarTaskSyncReceipts", taskId);

  await runTransaction(db, async (transaction) => {
    const receipt = await transaction.get(receiptRef);

    transaction.delete(taskRef);
    if (receipt.exists()) {
      transaction.delete(receiptRef);
    }
  });
}
