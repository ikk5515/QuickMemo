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
  options: { googleCalendarChanged?: boolean } = {}
) {
  const googleCalendarChanged = options.googleCalendarChanged ?? updateChangesGoogleCalendar(input);

  await updateDoc(doc(db, "scheduleTasks", taskId), {
    ...input,
    updatedBy: uid,
    updatedAt: serverTimestamp(),
    ...(googleCalendarChanged ? { calendarUpdatedAt: serverTimestamp() } : {})
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
