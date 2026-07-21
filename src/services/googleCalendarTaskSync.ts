import {
  collection,
  doc,
  getDocsFromServer,
  query,
  serverTimestamp,
  setDoc,
  where,
  type DocumentData,
  type Timestamp
} from "firebase/firestore";
import { db } from "../lib/firebase";

const receiptCollection = "googleCalendarTaskSyncReceipts";
const documentIdPattern = /^[A-Za-z0-9_-]{1,128}$/u;
const connectionGenerationPattern = /^[A-Za-z0-9_-]{43}$/u;

type FirestoreTimestampLike = Pick<Timestamp, "nanoseconds" | "seconds">;

export interface GoogleCalendarTaskSyncReceipt {
  connectionGeneration: string;
  ownerUid: string;
  syncedAt: FirestoreTimestampLike;
  taskId: string;
  taskUpdatedAt: FirestoreTimestampLike;
}

interface GoogleCalendarTaskRecoveryRecord {
  calendarUpdatedAt?: FirestoreTimestampLike;
  createdAt?: FirestoreTimestampLike;
  updatedAt?: FirestoreTimestampLike;
}

function validTimestamp(value: unknown): value is FirestoreTimestampLike {
  if (!value || typeof value !== "object") {
    return false;
  }
  const timestamp = value as Partial<FirestoreTimestampLike>;

  return Number.isSafeInteger(timestamp.seconds)
    && Number(timestamp.seconds) >= 0
    && Number.isSafeInteger(timestamp.nanoseconds)
    && Number(timestamp.nanoseconds) >= 0
    && Number(timestamp.nanoseconds) <= 999_999_999;
}

function timestampMillis(value: FirestoreTimestampLike) {
  return value.seconds * 1000 + Math.floor(value.nanoseconds / 1_000_000);
}

function sameTimestamp(left: unknown, right: unknown) {
  return validTimestamp(left)
    && validTimestamp(right)
    && left.seconds === right.seconds
    && left.nanoseconds === right.nanoseconds;
}

export function googleCalendarTaskRevisionTimestamp(task: GoogleCalendarTaskRecoveryRecord) {
  return validTimestamp(task.calendarUpdatedAt)
    ? task.calendarUpdatedAt
    : validTimestamp(task.createdAt)
      ? task.createdAt
      : validTimestamp(task.updatedAt)
        ? task.updatedAt
        : null;
}

function assertDocumentId(value: string, fieldName: string) {
  if (!documentIdPattern.test(value)) {
    throw new Error(`${fieldName} 형식이 올바르지 않습니다.`);
  }
}

function parseReceipt(data: DocumentData, expectedOwnerUid: string, expectedTaskId: string) {
  if (Object.keys(data).some((key) => !new Set([
    "ownerUid",
    "taskId",
    "connectionGeneration",
    "taskUpdatedAt",
    "syncedAt"
  ]).has(key))
    || data.ownerUid !== expectedOwnerUid
    || data.taskId !== expectedTaskId
    || typeof data.connectionGeneration !== "string"
    || !connectionGenerationPattern.test(data.connectionGeneration)
    || !validTimestamp(data.taskUpdatedAt)
    || !validTimestamp(data.syncedAt)) {
    throw new Error("Google Calendar 동기화 영수증이 올바르지 않습니다.");
  }

  return {
    ownerUid: expectedOwnerUid,
    taskId: expectedTaskId,
    connectionGeneration: data.connectionGeneration,
    taskUpdatedAt: data.taskUpdatedAt,
    syncedAt: data.syncedAt
  } satisfies GoogleCalendarTaskSyncReceipt;
}

export function scheduleTaskNeedsGoogleCalendarRecovery(
  task: GoogleCalendarTaskRecoveryRecord,
  receipt: GoogleCalendarTaskSyncReceipt | null,
  connectionGeneration: string,
  connectedAt: string
) {
  const revisionTimestamp = googleCalendarTaskRevisionTimestamp(task);

  if (!connectionGenerationPattern.test(connectionGeneration) || !revisionTimestamp) {
    return false;
  }
  const connectionTime = Date.parse(connectedAt);

  if (!Number.isFinite(connectionTime) || timestampMillis(revisionTimestamp) < connectionTime) {
    return false;
  }

  return receipt?.connectionGeneration !== connectionGeneration
    || !sameTimestamp(receipt.taskUpdatedAt, revisionTimestamp);
}

export async function listGoogleCalendarTaskSyncReceipts(ownerUid: string) {
  assertDocumentId(ownerUid, "사용자 식별자");
  const snapshot = await getDocsFromServer(query(
    collection(db, receiptCollection),
    where("ownerUid", "==", ownerUid)
  ));

  return snapshot.docs.map((document) => parseReceipt(document.data(), ownerUid, document.id));
}

export async function markScheduleTaskGoogleCalendarSynced(
  taskId: string,
  ownerUid: string,
  connectionGeneration: string,
  expectedUpdatedAt: FirestoreTimestampLike
) {
  assertDocumentId(taskId, "일정 식별자");
  assertDocumentId(ownerUid, "사용자 식별자");
  if (!connectionGenerationPattern.test(connectionGeneration) || !validTimestamp(expectedUpdatedAt)) {
    throw new Error("Google Calendar 동기화 영수증 형식이 올바르지 않습니다.");
  }

  await setDoc(doc(db, receiptCollection, taskId), {
    ownerUid,
    taskId,
    connectionGeneration,
    taskUpdatedAt: expectedUpdatedAt,
    syncedAt: serverTimestamp()
  });
}
