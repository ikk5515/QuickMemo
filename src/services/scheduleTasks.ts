import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  Timestamp,
  updateDoc,
  writeBatch,
  where
} from "firebase/firestore";
import type { FieldValue } from "firebase/firestore";
import { db } from "../lib/firebase";
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
  isImportant?: boolean;
  isUrgent?: boolean;
  status?: ScheduleTaskStatus;
  completedAt?: FieldValue | Timestamp | null;
}

export const defaultScheduleDetails: ScheduleTaskDetails = {
  description: "",
  checklist: []
};

function snapshotList(snapshot: { docs: Array<{ id: string; data: () => unknown }> }) {
  return snapshot.docs
    .map((document) => ({ id: document.id, ...(document.data() as ScheduleTaskDocument) }))
    .sort((left, right) => timestampMillis(right.updatedAt) - timestampMillis(left.updatedAt));
}

function timestampMillis(timestamp: ScheduleTaskDocument["updatedAt"]) {
  return timestamp && typeof timestamp.toMillis === "function" ? timestamp.toMillis() : 0;
}

export function subscribeScheduleTasks(uid: string, callback: (tasks: ScheduleTaskSnapshot[]) => void, onError?: (error: Error) => void) {
  const tasksQuery = query(collection(db, "scheduleTasks"), where("ownerUid", "==", uid));

  return onSnapshot(
    tasksQuery,
    (snapshot) => callback(snapshotList(snapshot)),
    (error) => onError?.(error)
  );
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
    completedAt: null
  });
}

export async function updateScheduleTask(taskId: string, uid: string, input: UpdateScheduleTaskInput) {
  await updateDoc(doc(db, "scheduleTasks", taskId), {
    ...input,
    updatedBy: uid,
    updatedAt: serverTimestamp()
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
  await deleteDoc(doc(db, "scheduleTasks", taskId));
}
