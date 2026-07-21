import {
  collection,
  doc,
  getDocFromServer,
  getDocsFromServer,
  query,
  runTransaction,
  serverTimestamp,
  Timestamp,
  where,
  type DocumentData
} from "firebase/firestore";
import { db } from "../lib/firebase";

const tombstoneCollection = "googleCalendarTaskTombstones";
const scheduleTaskCollection = "scheduleTasks";
const documentIdPattern = /^[A-Za-z0-9_-]{1,128}$/u;
const deletionAttemptIdPattern = /^[0-9a-f]{32}$/u;
// The authenticated backend's response time is used as the lease anchor. Keep
// one minute of request-latency headroom below the five-minute Rules ceiling.
const deletionLeaseMs = 4 * 60 * 1000;

export interface ScheduleTaskUpdatedAtRevision {
  nanoseconds: number;
  seconds: number;
}

export interface GoogleCalendarTaskTombstone {
  connectionGeneration: string | null;
  createdAt: Timestamp | null;
  deletionAttemptId: string;
  leaseExpiresAt: Timestamp;
  ownerUid: string;
  taskId: string;
}

export type GoogleCalendarTaskTombstoneErrorCode =
  | "deletion_in_progress"
  | "invalid_argument"
  | "invalid_tombstone"
  | "schedule_task_not_found"
  | "schedule_task_owner_mismatch"
  | "schedule_task_revision_changed"
  | "tombstone_owner_mismatch";

export class GoogleCalendarTaskTombstoneError extends Error {
  readonly code: GoogleCalendarTaskTombstoneErrorCode;

  constructor(code: GoogleCalendarTaskTombstoneErrorCode, message: string) {
    super(message);
    this.name = "GoogleCalendarTaskTombstoneError";
    this.code = code;
  }
}

function assertDocumentId(value: string, fieldName: string) {
  if (!documentIdPattern.test(value)) {
    throw new GoogleCalendarTaskTombstoneError("invalid_argument", `${fieldName} 형식이 올바르지 않습니다.`);
  }
}

function assertDeletionAttemptId(value: string) {
  if (!deletionAttemptIdPattern.test(value)) {
    throw new GoogleCalendarTaskTombstoneError("invalid_argument", "삭제 시도 식별자 형식이 올바르지 않습니다.");
  }
}

function normalizedRevision(value: ScheduleTaskUpdatedAtRevision) {
  if (!value
    || !Number.isSafeInteger(value.seconds)
    || value.seconds < 0
    || !Number.isSafeInteger(value.nanoseconds)
    || value.nanoseconds < 0
    || value.nanoseconds > 999_999_999) {
    throw new GoogleCalendarTaskTombstoneError("invalid_argument", "일정 수정 시각을 확인할 수 없습니다.");
  }

  return value;
}

function revisionMatches(value: unknown, expected: ScheduleTaskUpdatedAtRevision) {
  if (!value || typeof value !== "object") {
    return false;
  }
  const revision = value as Partial<ScheduleTaskUpdatedAtRevision>;

  return revision.seconds === expected.seconds && revision.nanoseconds === expected.nanoseconds;
}

function isTimestamp(value: unknown): value is Timestamp {
  if (!value || typeof value !== "object") {
    return false;
  }
  const timestamp = value as Partial<Timestamp>;

  return Number.isSafeInteger(timestamp.seconds)
    && Number(timestamp.seconds) >= 0
    && Number.isSafeInteger(timestamp.nanoseconds)
    && Number(timestamp.nanoseconds) >= 0
    && Number(timestamp.nanoseconds) <= 999_999_999;
}

function parseTombstone(data: DocumentData, expectedOwnerUid: string, expectedTaskId: string) {
  const allowedKeys = new Set([
    "ownerUid",
    "taskId",
    "deletionAttemptId",
    "connectionGeneration",
    "createdAt",
    "leaseExpiresAt"
  ]);
  const connectionGeneration = data.connectionGeneration ?? null;

  if (Object.keys(data).some((key) => !allowedKeys.has(key))
    || data.taskId !== expectedTaskId
    || typeof data.deletionAttemptId !== "string"
    || !deletionAttemptIdPattern.test(data.deletionAttemptId)
    || (connectionGeneration !== null
      && (typeof connectionGeneration !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(connectionGeneration)))
    || !isTimestamp(data.createdAt)
    || !isTimestamp(data.leaseExpiresAt)) {
    throw new GoogleCalendarTaskTombstoneError("invalid_tombstone", "Google Calendar 삭제 상태가 올바르지 않습니다.");
  }
  if (data.ownerUid !== expectedOwnerUid) {
    throw new GoogleCalendarTaskTombstoneError("tombstone_owner_mismatch", "다른 사용자의 삭제 상태에는 접근할 수 없습니다.");
  }

  return {
    ownerUid: expectedOwnerUid,
    taskId: expectedTaskId,
    deletionAttemptId: data.deletionAttemptId,
    connectionGeneration,
    createdAt: data.createdAt,
    leaseExpiresAt: data.leaseExpiresAt
  } satisfies GoogleCalendarTaskTombstone;
}

function timestampMillis(value: Timestamp) {
  return value.seconds * 1000 + Math.floor(value.nanoseconds / 1_000_000);
}

export function googleCalendarTaskTombstoneIsActive(
  tombstone: GoogleCalendarTaskTombstone,
  now = Date.now()
) {
  return timestampMillis(tombstone.leaseExpiresAt) > now;
}

function randomDeletionAttemptId() {
  const bytes = new Uint8Array(16);

  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export async function beginGoogleCalendarTaskDeletion(
  ownerUid: string,
  taskId: string,
  expectedUpdatedAt: ScheduleTaskUpdatedAtRevision,
  connectionGeneration: string | null = null,
  serverTime: string | null = null
) {
  assertDocumentId(ownerUid, "사용자 식별자");
  assertDocumentId(taskId, "일정 식별자");
  if (connectionGeneration !== null && !/^[A-Za-z0-9_-]{43}$/u.test(connectionGeneration)) {
    throw new GoogleCalendarTaskTombstoneError("invalid_argument", "Google Calendar 연결 식별자가 올바르지 않습니다.");
  }
  const expectedRevision = normalizedRevision(expectedUpdatedAt);
  const deletionAttemptId = randomDeletionAttemptId();
  const parsedServerTime = typeof serverTime === "string" ? Date.parse(serverTime) : Number.NaN;
  const leaseAnchor = Number.isFinite(parsedServerTime) ? parsedServerTime : Date.now();
  const leaseExpiresAt = Timestamp.fromMillis(leaseAnchor + deletionLeaseMs);
  const taskRef = doc(db, scheduleTaskCollection, taskId);
  const tombstoneRef = doc(db, tombstoneCollection, taskId);

  return runTransaction(db, async (transaction) => {
    const taskSnapshot = await transaction.get(taskRef);
    const tombstoneSnapshot = await transaction.get(tombstoneRef);

    if (!taskSnapshot.exists()) {
      throw new GoogleCalendarTaskTombstoneError("schedule_task_not_found", "삭제할 일정을 찾지 못했습니다.");
    }
    const task = taskSnapshot.data();
    if (task.ownerUid !== ownerUid) {
      throw new GoogleCalendarTaskTombstoneError("schedule_task_owner_mismatch", "다른 사용자의 일정은 삭제할 수 없습니다.");
    }
    if (!revisionMatches(task.updatedAt, expectedRevision)) {
      throw new GoogleCalendarTaskTombstoneError(
        "schedule_task_revision_changed",
        "일정이 다른 창에서 변경되었습니다. 최신 내용을 확인한 뒤 다시 시도해주세요."
      );
    }

    if (tombstoneSnapshot.exists()) {
      const tombstone = parseTombstone(tombstoneSnapshot.data(), ownerUid, taskId);

      if (googleCalendarTaskTombstoneIsActive(tombstone, leaseAnchor)) {
        throw new GoogleCalendarTaskTombstoneError(
          "deletion_in_progress",
          "다른 창에서 이 일정을 삭제하고 있습니다. 잠시 후 다시 확인해주세요."
        );
      }
    }

    transaction.set(tombstoneRef, {
      ownerUid,
      taskId,
      deletionAttemptId,
      connectionGeneration,
      createdAt: serverTimestamp(),
      leaseExpiresAt
    });

    return {
      ownerUid,
      taskId,
      deletionAttemptId,
      connectionGeneration,
      createdAt: null,
      leaseExpiresAt
    } satisfies GoogleCalendarTaskTombstone;
  });
}

export async function cancelGoogleCalendarTaskDeletion(
  ownerUid: string,
  taskId: string,
  deletionAttemptId: string
) {
  assertDocumentId(ownerUid, "사용자 식별자");
  assertDocumentId(taskId, "일정 식별자");
  assertDeletionAttemptId(deletionAttemptId);
  const tombstoneRef = doc(db, tombstoneCollection, taskId);

  return runTransaction(db, async (transaction) => {
    const tombstoneSnapshot = await transaction.get(tombstoneRef);

    if (!tombstoneSnapshot.exists()) {
      return false;
    }
    const tombstone = parseTombstone(tombstoneSnapshot.data(), ownerUid, taskId);
    if (tombstone.deletionAttemptId !== deletionAttemptId) {
      return false;
    }

    transaction.delete(tombstoneRef);
    return true;
  });
}

export async function getGoogleCalendarTaskTombstone(ownerUid: string, taskId: string) {
  assertDocumentId(ownerUid, "사용자 식별자");
  assertDocumentId(taskId, "일정 식별자");
  const snapshot = await getDocFromServer(doc(db, tombstoneCollection, taskId));

  return snapshot.exists() ? parseTombstone(snapshot.data(), ownerUid, taskId) : null;
}

export async function listGoogleCalendarTaskTombstones(ownerUid: string) {
  assertDocumentId(ownerUid, "사용자 식별자");
  const snapshot = await getDocsFromServer(query(
    collection(db, tombstoneCollection),
    where("ownerUid", "==", ownerUid)
  ));

  return snapshot.docs.map((document) => parseTombstone(document.data(), ownerUid, document.id));
}

export async function validateGoogleCalendarTaskTombstone(
  ownerUid: string,
  taskId: string,
  deletionAttemptId: string
) {
  assertDeletionAttemptId(deletionAttemptId);
  const tombstone = await getGoogleCalendarTaskTombstone(ownerUid, taskId);

  return tombstone?.deletionAttemptId === deletionAttemptId;
}
