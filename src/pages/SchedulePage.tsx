import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
  pointerWithin,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  BriefcaseBusiness,
  CalendarSync,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  Flag,
  GripVertical,
  Grid2X2,
  LoaderCircle,
  Minus,
  Pencil,
  Plus,
  Save,
  Search,
  Trash2,
  UserRound,
  X
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { FormEvent, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import { serverTimestamp } from "firebase/firestore";
import { useLocation, useNavigate } from "react-router-dom";
import { AppSelect } from "../components/AppSelect";
import { AppShell } from "../components/AppShell";
import {
  GoogleCalendarSyncDialog,
  type GoogleCalendarDialogOperation,
  type GoogleCalendarSyncProgress
} from "../components/GoogleCalendarSyncDialog";
import { UnlockPanel } from "../components/UnlockPanel";
import { useAuth } from "../context/AuthContext";
import { groupChecklistItems } from "../lib/checklist";
import { decryptText, encryptText, generateNoteKey, unwrapNoteKey, wrapNoteKey } from "../lib/crypto";
import { getKoreanHolidayMapForDates, type KoreanHoliday } from "../lib/koreanHolidays";
import { defaultMatrixLabels } from "../lib/matrixLabels";
import { mapWithConcurrency } from "../lib/mapWithConcurrency";
import { useModalFocus } from "../lib/useModalFocus";
import {
  defaultScheduleCategoryFilter,
  defaultScheduleTaskCategory,
  scheduleCategoryEncryptionValue,
  scheduleCategoryFromEncryptionValue,
  scheduleCategoryLabel,
  scheduleTaskMatchesCategory
} from "../lib/scheduleCategory";
import {
  normalizePrimaryScheduleView,
  scheduleViewFromSearch,
  scheduleViewHref,
  type PrimaryScheduleView
} from "../lib/scheduleNavigation";
import {
  addDays,
  buildScheduleTaskOrderUpdates,
  buildCalendarMonth,
  buildCalendarTaskLayout,
  compareCalendarAgendaTasks,
  compareTaskSchedule,
  emptyScheduleDetails,
  formatScheduleDateRange,
  formatScheduleTimeRange,
  formatTaskTime,
  groupTasksByMatrix,
  isSafeScheduleDateRange,
  isValidScheduleDateString,
  matrixPriorityForSection,
  maxScheduleTaskRangeDays,
  nextScheduleTaskColor,
  normalizeScheduleDetails,
  normalizeScheduleTaskColor,
  taskEndDate,
  taskStartDate,
  taskStartTime,
  tasksByDate,
  timeInputToMinutes,
  toLocalDateString,
  type MatrixQuadrantKey,
  type MatrixSection
} from "../lib/scheduleHelpers";
import {
  beginGoogleCalendarDeletionWorkflow,
  clearGoogleCalendarSession,
  deleteGoogleCalendarTask,
  detectedGoogleCalendarTimeZone,
  disconnectedGoogleCalendarStatus,
  disconnectGoogleCalendar,
  endGoogleCalendarDeletionWorkflow,
  getGoogleCalendarConnectionStatus,
  googleCalendarErrorCode,
  googleCalendarErrorMessage,
  GoogleCalendarError,
  reconcileGoogleCalendarTask,
  reportGoogleCalendarSync,
  startGoogleCalendarConnection,
  upsertGoogleCalendarTask,
  type GoogleCalendarConnectionStatus,
  type GoogleCalendarDeletionWorkflow,
  type GoogleCalendarSyncResult,
  type GoogleCalendarTaskInput
} from "../services/googleCalendar";
import { inspectGoogleCalendarTaskAuthority } from "../services/googleCalendarTaskAuthority";
import {
  googleCalendarTaskRevisionTimestamp,
  listGoogleCalendarTaskSyncReceipts,
  markScheduleTaskGoogleCalendarSynced,
  scheduleTaskNeedsGoogleCalendarRecovery
} from "../services/googleCalendarTaskSync";
import {
  beginGoogleCalendarTaskDeletion,
  cancelGoogleCalendarTaskDeletion,
  getGoogleCalendarTaskTombstone,
  listGoogleCalendarTaskTombstones,
  type GoogleCalendarTaskTombstone
} from "../services/googleCalendarTaskTombstones";
import {
  createScheduleTask,
  deleteScheduleTask,
  getScheduleTask,
  subscribeScheduleTasks,
  updateScheduleTask,
  updateScheduleTaskOrderBatch,
  type UpdateScheduleTaskInput,
  type ScheduleTaskSnapshot
} from "../services/scheduleTasks";
import {
  defaultUserPreferences,
  getCachedUserPreferences,
  getUserPreferences,
  subscribeUserPreferences
} from "../services/userPreferences";
import type {
  DecryptedScheduleTask,
  EncryptedPayload,
  MatrixLabels,
  ScheduleChecklistItem,
  ScheduleCategoryFilter,
  ScheduleTaskDetails,
  ScheduleTaskCategory
} from "../types";

const scheduleTabs: Array<{ view: PrimaryScheduleView; label: string; shortLabel: string; Icon: LucideIcon }> = [
  { view: "calendar", label: "달력", shortLabel: "달력", Icon: CalendarDays },
  { view: "matrix", label: "매트릭스", shortLabel: "매트릭스", Icon: Grid2X2 }
];

const scheduleCategoryFilters: Array<{ value: ScheduleCategoryFilter; label: string }> = [
  { value: "all", label: "전체" },
  { value: "work", label: "업무" },
  { value: "personal", label: "개인" }
];

const scheduleViewTitles: Record<PrimaryScheduleView, string> = {
  calendar: "달력",
  matrix: "매트릭스"
};

const taskPageSize = 5;
const scheduleDateRangeValidationMessage = `일정 날짜는 실제 날짜여야 하고 같은 연도 안에서 최대 ${maxScheduleTaskRangeDays}일까지 선택할 수 있습니다.`;

function categoryForNewTask(filter: ScheduleCategoryFilter): ScheduleTaskCategory {
  return filter === "personal" ? "personal" : defaultScheduleTaskCategory;
}

type DecryptedTaskCache = Map<string, {
  details: ScheduleTaskDetails;
  encryptedCategory: ScheduleTaskSnapshot["encryptedCategory"];
  encryptedDetails: ScheduleTaskSnapshot["encryptedDetails"];
  encryptedTitle: ScheduleTaskSnapshot["encryptedTitle"];
  title: string;
  wrappedKey: ScheduleTaskSnapshot["wrappedKeys"][string];
}>;

const scheduleDecryptConcurrency = 6;

function sameEncryptedPayload(
  left: ScheduleTaskSnapshot["encryptedTitle"],
  right: ScheduleTaskSnapshot["encryptedTitle"]
) {
  return left.version === right.version
    && left.algorithm === right.algorithm
    && left.iv === right.iv
    && left.cipherText === right.cipherText;
}

function parseEncryptedScheduleCategory(value: string): EncryptedPayload {
  if (value.length === 0 || value.length > 1024) {
    throw new Error("schedule-task/invalid-encrypted-category");
  }

  const parsed = JSON.parse(value) as unknown;
  const allowedKeys = new Set(["version", "algorithm", "cipherText", "iv"]);

  if (
    !parsed
    || typeof parsed !== "object"
    || Object.keys(parsed).length !== allowedKeys.size
    || Object.keys(parsed).some((key) => !allowedKeys.has(key))
    || (parsed as { version?: unknown }).version !== 1
    || (parsed as { algorithm?: unknown }).algorithm !== "AES-GCM"
    || typeof (parsed as { cipherText?: unknown }).cipherText !== "string"
    || typeof (parsed as { iv?: unknown }).iv !== "string"
    || (parsed as { cipherText: string }).cipherText.length === 0
    || (parsed as { cipherText: string }).cipherText.length > 512
    || (parsed as { iv: string }).iv.length === 0
    || (parsed as { iv: string }).iv.length > 256
  ) {
    throw new Error("schedule-task/invalid-encrypted-category");
  }

  return parsed as EncryptedPayload;
}

async function decryptScheduleTaskDetails(
  task: Pick<ScheduleTaskSnapshot, "encryptedCategory" | "encryptedDetails">,
  taskKey: CryptoKey
) {
  const [detailsJson, encryptedCategoryValue] = await Promise.all([
    decryptText(task.encryptedDetails, taskKey),
    task.encryptedCategory
      ? decryptText(parseEncryptedScheduleCategory(task.encryptedCategory), taskKey)
      : Promise.resolve(null)
  ]);
  const details = normalizeScheduleDetails(JSON.parse(detailsJson) as unknown);

  return task.encryptedCategory
    ? { ...details, category: scheduleCategoryFromEncryptionValue(encryptedCategoryValue) }
    : details;
}

function scheduleTaskDetailsEncryptionValue(details: ScheduleTaskDetails) {
  return JSON.stringify({
    description: details.description,
    checklist: details.checklist
  });
}

function sameWrappedKey(
  left: ScheduleTaskSnapshot["wrappedKeys"][string],
  right: ScheduleTaskSnapshot["wrappedKeys"][string]
) {
  return left.version === right.version
    && left.algorithm === right.algorithm
    && left.wrappedKey === right.wrappedKey;
}

function pruneScheduleDecryptCache<TCache extends Map<string, unknown>>(cache: TCache, snapshots: Array<{ id: string }>) {
  const activeIds = new Set(snapshots.map((snapshot) => snapshot.id));

  for (const id of cache.keys()) {
    if (!activeIds.has(id)) {
      cache.delete(id);
    }
  }
}

function useKoreanHolidayMap(dateStrings: string[]) {
  const cacheKey = dateStrings.join("|");
  const [holidayMap, setHolidayMap] = useState<Record<string, KoreanHoliday[]>>({});

  useEffect(() => {
    let active = true;

    if (dateStrings.length === 0) {
      setHolidayMap({});
      return () => {
        active = false;
      };
    }

    void getKoreanHolidayMapForDates(dateStrings).then((nextHolidayMap) => {
      if (active) {
        setHolidayMap(nextHolidayMap);
      }
    });

    return () => {
      active = false;
    };
  }, [cacheKey, dateStrings]);

  return holidayMap;
}
type TaskDetailsUpdater = (details: ScheduleTaskDetails) => ScheduleTaskDetails;

interface QuickDefaults {
  category?: ScheduleTaskCategory;
  startDate?: string | null;
  endDate?: string | null;
  startTimeMinutes?: number | null;
  endTimeMinutes?: number | null;
  color?: string | null;
  isImportant?: boolean;
  isUrgent?: boolean;
}

interface TaskDraft {
  category: ScheduleTaskCategory;
  title: string;
  description: string;
  checklist: ScheduleChecklistItem[];
  startDate: string;
  endDate: string;
  timeMode: "none" | "point" | "range";
  startTime: string;
  endTime: string;
  color: string;
  progressPercent: number;
  isImportant: boolean;
  isUrgent: boolean;
  status: DecryptedScheduleTask["status"];
}

interface CreateTaskDraft {
  category: ScheduleTaskCategory;
  title: string;
  description: string;
  checklist: ScheduleChecklistItem[];
  startDate: string;
  endDate: string;
  timeMode: "none" | "point" | "range";
  startTime: string;
  endTime: string;
  color: string;
  isImportant: boolean;
  isUrgent: boolean;
}

function googleCalendarTaskFromDecrypted(task: DecryptedScheduleTask): GoogleCalendarTaskInput {
  const revisionTimestamp = googleCalendarTaskRevisionTimestamp(task);

  return {
    id: task.id,
    ownerUid: task.ownerUid,
    title: task.title,
    startDate: taskStartDate(task),
    endDate: taskEndDate(task),
    startTimeMinutes: taskStartTime(task),
    endTimeMinutes: task.endTimeMinutes ?? null,
    revision: googleCalendarTaskRevision(revisionTimestamp)
  };
}

function googleCalendarTaskRevision(value: { nanoseconds: number; seconds: number } | null | undefined) {
  if (!value
    || !Number.isSafeInteger(value.seconds)
    || value.seconds < 0
    || !Number.isSafeInteger(value.nanoseconds)
    || value.nanoseconds < 0
    || value.nanoseconds > 999_999_999) {
    return null;
  }

  return `${String(value.seconds).padStart(12, "0")}.${String(value.nanoseconds).padStart(9, "0")}`;
}

function googleCalendarTaskRevisionValue(revision: string | null | undefined) {
  const match = /^(\d{12})\.(\d{9})$/u.exec(revision ?? "");

  if (!match) {
    return null;
  }
  const seconds = Number(match[1]);
  const nanoseconds = Number(match[2]);

  if (!Number.isSafeInteger(seconds)
    || seconds < 0
    || !Number.isSafeInteger(nanoseconds)
    || nanoseconds < 0
    || nanoseconds > 999_999_999) {
    return null;
  }

  return { nanoseconds, seconds };
}

function isEligibleExistingGoogleCalendarTask(task: DecryptedScheduleTask) {
  const startDate = taskStartDate(task);
  const endDate = taskEndDate(task) ?? startDate;

  return (task.status === "active" || task.status === "completed")
    && isValidScheduleDateString(startDate)
    && isValidScheduleDateString(endDate)
    && endDate >= startDate;
}

type ScheduleTimeModeDraft = Pick<CreateTaskDraft, "endDate" | "endTime" | "startDate" | "startTime" | "timeMode">;

interface CreateDialogState {
  allowPriority?: boolean;
  defaults: QuickDefaults;
  title: string;
}

type ChecklistGroupKey = "checked" | "unchecked";

interface ChecklistDisplayGroup<TItem extends ScheduleChecklistItem> {
  countLabel: string;
  items: TItem[];
  key: ChecklistGroupKey;
  label: string;
}

function checklistDisplayGroups<TItem extends ScheduleChecklistItem>(items: TItem[]): ChecklistDisplayGroup<TItem>[] {
  const { checkedItems, uncheckedItems } = groupChecklistItems(items);
  const groups: ChecklistDisplayGroup<TItem>[] = [
    {
      countLabel: `${checkedItems.length}개`,
      items: checkedItems,
      key: "checked",
      label: "완료됨"
    },
    {
      countLabel: `${uncheckedItems.length}개`,
      items: uncheckedItems,
      key: "unchecked",
      label: "남은 항목"
    }
  ];

  return groups.filter((group) => group.items.length > 0);
}

const googleCalendarRecoveryMaxAttempts = 3;
const googleCalendarRecoveryBackgroundRetryMs = 5 * 60 * 1000;
const googleCalendarForegroundSyncs = new Map<string, number>();

function beginGoogleCalendarForegroundSync(key: string) {
  googleCalendarForegroundSyncs.set(key, (googleCalendarForegroundSyncs.get(key) ?? 0) + 1);
}

function endGoogleCalendarForegroundSync(key: string) {
  const remaining = (googleCalendarForegroundSyncs.get(key) ?? 1) - 1;

  if (remaining > 0) {
    googleCalendarForegroundSyncs.set(key, remaining);
  } else {
    googleCalendarForegroundSyncs.delete(key);
  }
}
const googleCalendarBatchBlockingErrorCodes = new Set([
  "client_crypto_unavailable",
  "connection_changed",
  "google_reconnect_required",
  "invalid_auth_response",
  "invalid_token_response",
  "login_required",
  "network_error",
  "not_configured",
  "not_connected",
  "permission_denied",
  "rate_limited",
  "reauthorization_required",
  "google_unavailable"
]);

function googleCalendarTaskReadError(caught: unknown) {
  const code = caught && typeof caught === "object"
    ? (caught as { code?: unknown }).code
    : null;

  if (code === "permission-denied" || code === "firestore/permission-denied") {
    return new GoogleCalendarError(
      "permission_denied",
      "일정의 최신 내용을 읽을 권한이 없습니다. 사용자 활성 상태를 확인해주세요."
    );
  }
  if (new Set([
    "aborted",
    "deadline-exceeded",
    "firestore/aborted",
    "firestore/deadline-exceeded",
    "firestore/resource-exhausted",
    "firestore/unavailable",
    "resource-exhausted",
    "unavailable"
  ]).has(String(code))) {
    return new GoogleCalendarError(
      "network_error",
      "일정의 최신 내용을 확인하지 못했습니다. 네트워크를 확인한 뒤 다시 시도해주세요.",
      true
    );
  }
  return new GoogleCalendarError(
    "task_read_failed",
    "이 일정의 최신 내용을 확인하지 못했습니다. 다른 일정은 계속 동기화합니다."
  );
}

function googleCalendarBatchShouldStop(caught: unknown) {
  const code = googleCalendarErrorCode(caught);

  if (code === "event_conflict" || code === "calendar_request_failed") {
    return false;
  }
  return !(caught instanceof GoogleCalendarError)
    || caught.retryable
    || googleCalendarBatchBlockingErrorCodes.has(code);
}

function googleCalendarBatchRetryDelay(caught: unknown) {
  return caught instanceof GoogleCalendarError ? caught.retryAfterMs ?? 2_000 : 2_000;
}

function googleCalendarTaskRecoverySignature(task: DecryptedScheduleTask) {
  const revision = googleCalendarTaskRevision(googleCalendarTaskRevisionTimestamp(task)) ?? "pending";

  return [
    task.id,
    revision,
    taskStartDate(task) ?? "",
    taskEndDate(task) ?? "",
    taskStartTime(task) ?? "",
    task.endTimeMinutes ?? "",
    task.encryptedTitle.cipherText,
    task.encryptedTitle.iv
  ].join(":");
}

interface GoogleCalendarRecoveryWorkerProps {
  connection: GoogleCalendarConnectionStatus;
  onFailure: (caught: unknown, failureKeys: string[]) => void | Promise<void>;
  onRecoveryStateResolved: (failureKey: string) => void;
  onRecoveryStateUnresolved: (failureKey: string, warning: string) => void;
  onSuccess: (syncedCount: number, taskIds: string[]) => void;
  ownerUid: string;
  paused: boolean;
  scheduleTasksLoaded: boolean;
  tasks: DecryptedScheduleTask[];
}

interface GoogleCalendarTaskSyncQueueRequest {
  connectionLifecycleEpoch: number;
  previouslyDated: boolean;
  uiEpoch: number;
  version: number;
}

interface GoogleCalendarTaskSyncFailure {
  surfaced: boolean;
  warning: string;
}

type GoogleCalendarTaskSyncOutcome =
  | { kind: "deferred" }
  | { kind: "failed"; caught: unknown; warning: string }
  | { kind: "not-needed" }
  | { kind: "synced"; syncedCount: number };

function GoogleCalendarRecoveryWorker({
  connection,
  onFailure,
  onRecoveryStateResolved,
  onRecoveryStateUnresolved,
  onSuccess,
  ownerUid,
  paused,
  scheduleTasksLoaded,
  tasks
}: GoogleCalendarRecoveryWorkerProps) {
  const [retryTick, setRetryTick] = useState(0);
  const attemptsRef = useRef(new Map<string, number>());
  const callbackRef = useRef({
    onFailure,
    onRecoveryStateResolved,
    onRecoveryStateUnresolved,
    onSuccess
  });
  const tasksRef = useRef(tasks);
  const recoverySignature = useMemo(
    () => tasks.map(googleCalendarTaskRecoverySignature).sort().join("|"),
    [tasks]
  );

  useEffect(() => {
    callbackRef.current = {
      onFailure,
      onRecoveryStateResolved,
      onRecoveryStateUnresolved,
      onSuccess
    };
  }, [onFailure, onRecoveryStateResolved, onRecoveryStateUnresolved, onSuccess]);

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  useEffect(() => {
    attemptsRef.current.clear();
    setRetryTick(0);
  }, [connection.connectionGeneration, ownerUid]);

  useEffect(() => {
    const resumeRecovery = () => {
      attemptsRef.current.clear();
      setRetryTick((current) => current + 1);
    };
    const resumeVisibleRecovery = () => {
      if (document.visibilityState === "visible") {
        resumeRecovery();
      }
    };

    window.addEventListener("online", resumeRecovery);
    document.addEventListener("visibilitychange", resumeVisibleRecovery);
    return () => {
      window.removeEventListener("online", resumeRecovery);
      document.removeEventListener("visibilitychange", resumeVisibleRecovery);
    };
  }, []);

  useEffect(() => {
    const generation = connection.connectionGeneration;
    const connectedAt = connection.connectedAt;

    if (!connection.connected
      || connection.needsReconnect
      || !generation
      || !connectedAt
      || !Number.isFinite(Date.parse(connectedAt))
      || !scheduleTasksLoaded
      || paused) {
      return undefined;
    }

    const controller = new AbortController();
    let active = true;
    let retryDelayMs: number | null = null;
    let retryTimer: number | null = null;
    let firstFailure: unknown = null;
    let succeeded = 0;
    const failedSyncKeys = new Set<string>();
    const succeededTaskIds = new Set<string>();
    const recoveryStateFailureKey = `recovery-state:${ownerUid}:${generation}`;

    const requestRetry = (key: string, baseDelayMs = 2_000) => {
      const attempt = (attemptsRef.current.get(key) ?? 0) + 1;

      attemptsRef.current.set(key, attempt);
      if (attempt > googleCalendarRecoveryMaxAttempts) {
        retryDelayMs = retryDelayMs === null
          ? googleCalendarRecoveryBackgroundRetryMs
          : Math.min(retryDelayMs, googleCalendarRecoveryBackgroundRetryMs);
        return attempt;
      }
      const delay = Math.min(30_000, baseDelayMs * (2 ** Math.max(0, attempt - 1)));

      retryDelayMs = retryDelayMs === null ? delay : Math.min(retryDelayMs, delay);
      return attempt;
    };

    const receiptKey = (task: DecryptedScheduleTask) => {
      const revisionTimestamp = googleCalendarTaskRevisionTimestamp(task);

      return `receipt:${generation}:${task.id}:${googleCalendarTaskRevision(revisionTimestamp) ?? "pending"}`;
    };

    const reconcileTask = async (task: DecryptedScheduleTask) => {
      const key = receiptKey(task);
      const revisionTimestamp = googleCalendarTaskRevisionTimestamp(task);

      if (!revisionTimestamp || !googleCalendarTaskRevision(revisionTimestamp)) {
        requestRetry(key, 1_000);
        return false;
      }
      if (googleCalendarForegroundSyncs.has(`${ownerUid}:${task.id}`)) {
        retryDelayMs = retryDelayMs === null ? 1_000 : Math.min(retryDelayMs, 1_000);
        return false;
      }
      const input = googleCalendarTaskFromDecrypted(task);
      const authorityBefore = await inspectGoogleCalendarTaskAuthority(input);

      if (authorityBefore === "deleted" || authorityBefore === "stale") {
        requestRetry(key, authorityBefore === "deleted" ? 10_000 : 1_000);
        return false;
      }
      if (authorityBefore === "current") {
        await upsertGoogleCalendarTask(
          input,
          connection.timeZone || detectedGoogleCalendarTimeZone(),
          controller.signal
        );
      } else {
        await deleteGoogleCalendarTask(
          { id: task.id, ownerUid },
          controller.signal
        );
      }

      const authorityAfter = await inspectGoogleCalendarTaskAuthority(input);
      const expectedAuthority = taskStartDate(task) ? "current" : "undated";

      if (authorityAfter !== expectedAuthority) {
        requestRetry(key, 1_000);
        return false;
      }

      await markScheduleTaskGoogleCalendarSynced(
        task.id,
        ownerUid,
        generation,
        revisionTimestamp
      );
      attemptsRef.current.delete(key);
      return true;
    };

    const recover = async () => {
      // Let Firestore deliver the initial encrypted and decrypted snapshots as
      // one stable batch before starting network recovery.
      await new Promise<void>((resolve) => {
        let settled = false;
        const finishInitialDelay = () => {
          if (settled) {
            return;
          }
          settled = true;
          if (retryTimer !== null) {
            window.clearTimeout(retryTimer);
            retryTimer = null;
          }
          controller.signal.removeEventListener("abort", finishInitialDelay);
          resolve();
        };

        retryTimer = window.setTimeout(finishInitialDelay, 250);
        controller.signal.addEventListener("abort", finishInitialDelay, { once: true });
      });
      if (!active || controller.signal.aborted) {
        return;
      }
      const currentTasks = tasksRef.current;
      const decryptedById = new Map(currentTasks.map((task) => [task.id, task]));

      let tombstones: GoogleCalendarTaskTombstone[] = [];
      let receipts = new Map<string, Awaited<ReturnType<typeof listGoogleCalendarTaskSyncReceipts>>[number]>();
      let recoveryStateAvailable = true;

      const recordRecoveryStateFailure = (key: string, caught: unknown) => {
        recoveryStateAvailable = false;
        callbackRef.current.onRecoveryStateUnresolved(
          recoveryStateFailureKey,
          "Google Calendar 동기화 보호 상태를 확인하지 못했습니다. 연결이 복구되면 자동으로 다시 확인합니다."
        );
        const attempt = requestRetry(key);

        if (attempt <= googleCalendarRecoveryMaxAttempts || firstFailure) {
          return;
        }
        firstFailure = caught instanceof GoogleCalendarError
          ? caught
          : new GoogleCalendarError(
            "calendar_request_failed",
            "Google Calendar 동기화 보호 상태를 확인하지 못했습니다. 잠시 후 자동으로 다시 시도합니다.",
            true
          );
        failedSyncKeys.add(recoveryStateFailureKey);
      };

      const [receiptResult, tombstoneResult] = await Promise.allSettled([
        listGoogleCalendarTaskSyncReceipts(ownerUid),
        listGoogleCalendarTaskTombstones(ownerUid)
      ]);

      if (receiptResult.status === "fulfilled") {
        receipts = new Map(receiptResult.value.map((receipt) => [receipt.taskId, receipt]));
        attemptsRef.current.delete(`receipt-list:${generation}`);
      } else {
        recordRecoveryStateFailure(`receipt-list:${generation}`, receiptResult.reason);
      }
      if (tombstoneResult.status === "fulfilled") {
        tombstones = tombstoneResult.value;
        attemptsRef.current.delete(`tombstone-list:${generation}`);
      } else {
        recordRecoveryStateFailure(`tombstone-list:${generation}`, tombstoneResult.reason);
      }

      if (!active || controller.signal.aborted) {
        return;
      }
      if (!recoveryStateAvailable) {
        if (firstFailure) {
          await callbackRef.current.onFailure(firstFailure, Array.from(failedSyncKeys));
        }
        if (!active || controller.signal.aborted) {
          return;
        }
        if (retryDelayMs !== null) {
          retryTimer = window.setTimeout(() => setRetryTick((current) => current + 1), retryDelayMs);
        }
        return;
      }

      const matchingTombstones = tombstones.filter(
        (tombstone) => tombstone.connectionGeneration === generation
      );
      const matchingTombstoneIds = new Set(matchingTombstones.map((tombstone) => tombstone.taskId));
      let batchBlocked = false;

      for (const tombstone of matchingTombstones) {
        if (!active || controller.signal.aborted) {
          return;
        }
        const key = `tombstone:${generation}:${tombstone.taskId}:${tombstone.deletionAttemptId}`;

        try {
          const serverTask = await getScheduleTask(tombstone.taskId);

          if (serverTask && serverTask.ownerUid === ownerUid) {
            const decryptedTask = decryptedById.get(tombstone.taskId);

            if (!decryptedTask) {
              requestRetry(key, 1_000);
              continue;
            }
            const authority = await inspectGoogleCalendarTaskAuthority(
              googleCalendarTaskFromDecrypted(decryptedTask)
            );

            if (authority === "deleted") {
              // The server clock still sees an active deletion lease. Never
              // recreate or cancel another tab's in-progress deletion.
              requestRetry(key, 10_000);
              continue;
            }
            if (authority === "stale" || !await reconcileTask(decryptedTask)) {
              requestRetry(key, 1_000);
              continue;
            }
          } else if (!serverTask) {
            await deleteGoogleCalendarTask(
              { id: tombstone.taskId, ownerUid },
              controller.signal
            );
            const taskAfterDelete = await getScheduleTask(tombstone.taskId);

            if (taskAfterDelete) {
              requestRetry(key, 1_000);
              continue;
            }
          } else {
            continue;
          }

          const cleared = await cancelGoogleCalendarTaskDeletion(
            ownerUid,
            tombstone.taskId,
            tombstone.deletionAttemptId
          );

          if (!cleared) {
            // A newer deletion attempt replaced this lease. Its owner decides
            // the final state; this recovery run must not delete it.
            requestRetry(key, 10_000);
            continue;
          }
          attemptsRef.current.delete(key);
          succeeded += 1;
          succeededTaskIds.add(tombstone.taskId);
        } catch (caught) {
          firstFailure ??= caught;
          failedSyncKeys.add(tombstone.taskId);
          requestRetry(key, googleCalendarBatchRetryDelay(caught));
          if (googleCalendarBatchShouldStop(caught)) {
            batchBlocked = true;
            break;
          }
        }
      }

      for (const task of !batchBlocked ? currentTasks : []) {
        if (!active || controller.signal.aborted) {
          return;
        }
        if (matchingTombstoneIds.has(task.id)
          || !scheduleTaskNeedsGoogleCalendarRecovery(
            task,
            receipts.get(task.id) ?? null,
            generation,
            connectedAt
          )) {
          continue;
        }
        const key = receiptKey(task);

        try {
          if (await reconcileTask(task)) {
            succeeded += 1;
            succeededTaskIds.add(task.id);
          }
        } catch (caught) {
          firstFailure ??= caught;
          failedSyncKeys.add(task.id);
          requestRetry(key, googleCalendarBatchRetryDelay(caught));
          if (googleCalendarBatchShouldStop(caught)) {
            batchBlocked = true;
            break;
          }
        }
      }

      if (!active || controller.signal.aborted) {
        return;
      }
      if (firstFailure) {
        await callbackRef.current.onFailure(firstFailure, Array.from(failedSyncKeys));
      }
      if (succeeded > 0) {
        callbackRef.current.onSuccess(succeeded, Array.from(succeededTaskIds));
      }
      callbackRef.current.onRecoveryStateResolved(recoveryStateFailureKey);
      if (!active || controller.signal.aborted) {
        return;
      }
      if (retryDelayMs !== null) {
        retryTimer = window.setTimeout(() => setRetryTick((current) => current + 1), retryDelayMs);
      }
    };

    void recover();

    return () => {
      active = false;
      controller.abort();
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
    };
  }, [
    connection.connected,
    connection.connectedAt,
    connection.connectionGeneration,
    connection.needsReconnect,
    connection.timeZone,
    ownerUid,
    paused,
    retryTick,
    scheduleTasksLoaded,
    recoverySignature
  ]);

  return null;
}

export default function SchedulePage() {
  const { privateKey, profile } = useAuth();
  const preferencesCryptoContext = useMemo(
    () => profile && privateKey ? { privateKey, profile } : undefined,
    [privateKey, profile]
  );
  const googleCalendarProfileUid = profile?.uid ?? null;
  const location = useLocation();
  const navigate = useNavigate();
  const [activeView, setActiveView] = useState<PrimaryScheduleView | null>(() =>
    scheduleViewFromSearch(location.search)
      ?? (profile ? normalizePrimaryScheduleView(getCachedUserPreferences(profile.uid)?.scheduleDefaultView) : null)
  );
  const [matrixLabels, setMatrixLabels] = useState<MatrixLabels>(() =>
    profile ? getCachedUserPreferences(profile.uid)?.matrixLabels ?? defaultMatrixLabels : defaultMatrixLabels
  );
  const [scheduleCategoryFilter, setScheduleCategoryFilter] = useState<ScheduleCategoryFilter>(() =>
    profile
      ? getCachedUserPreferences(profile.uid)?.scheduleDefaultCategory ?? defaultScheduleCategoryFilter
      : defaultScheduleCategoryFilter
  );
  const scheduleDefaultCategoryRef = useRef<ScheduleCategoryFilter | null>(null);
  const scheduleCategoryPreferenceResolvedRef = useRef(false);
  const scheduleCategoryTouchedBeforePreferenceRef = useRef(false);
  const [tasks, setTasks] = useState<ScheduleTaskSnapshot[]>([]);
  const [scheduleTasksLoaded, setScheduleTasksLoaded] = useState(false);
  const [decryptedTasks, setDecryptedTasks] = useState<DecryptedScheduleTask[]>([]);
  const [viewTaskId, setViewTaskId] = useState<string | null>(null);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const createDialogReturnFocusRef = useRef<HTMLElement | null>(null);
  const taskModalReturnFocusRef = useRef<HTMLElement | null>(null);
  const taskDeleteConfirmReturnFocusRef = useRef<HTMLElement | null>(null);
  const [deleteConfirmationTask, setDeleteConfirmationTask] = useState<DecryptedScheduleTask | null>(null);
  const [taskDeletionPending, setTaskDeletionPending] = useState(false);
  const [taskDeletionError, setTaskDeletionError] = useState<string | null>(null);
  const [taskDuplicationPending, setTaskDuplicationPending] = useState(false);
  const [selectedCalendarDate, setSelectedCalendarDate] = useState(() => toLocalDateString(new Date()));
  const [calendarCursor, setCalendarCursor] = useState(() => new Date());
  const [createDialog, setCreateDialog] = useState<CreateDialogState | null>(null);
  const [scheduleQuery, setScheduleQuery] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [today, setToday] = useState(() => toLocalDateString(new Date()));
  const [googleCalendarDialogOpen, setGoogleCalendarDialogOpen] = useState(false);
  const [googleCalendarConnection, setGoogleCalendarConnection] = useState<GoogleCalendarConnectionStatus>(
    disconnectedGoogleCalendarStatus
  );
  const [googleCalendarLoading, setGoogleCalendarLoading] = useState(false);
  const [googleCalendarOperation, setGoogleCalendarOperation] = useState<GoogleCalendarDialogOperation>(null);
  const [googleCalendarProgress, setGoogleCalendarProgress] = useState<GoogleCalendarSyncProgress | null>(null);
  const [googleCalendarError, setGoogleCalendarError] = useState<string | null>(null);
  const [googleCalendarNotice, setGoogleCalendarNotice] = useState<string | null>(null);
  const [googleCalendarTaskSyncPendingCount, setGoogleCalendarTaskSyncPendingCount] = useState(0);
  const decryptedTasksRef = useRef<DecryptedScheduleTask[]>([]);
  const decryptedTaskCacheRef = useRef<DecryptedTaskCache>(new Map());
  const decryptCacheIdentityRef = useRef<{ privateKey: CryptoKey | null; uid: string | null }>({
    privateKey: null,
    uid: null
  });
  const taskDetailsUpdateQueueRef = useRef<Partial<Record<string, Promise<ScheduleTaskDetails>>>>({});
  const schedulePrimaryActionRef = useRef<HTMLButtonElement>(null);
  const googleCalendarPopupRef = useRef<Window | null>(null);
  const googleCalendarAttemptRef = useRef(0);
  const googleCalendarStatusRequestRef = useRef(0);
  const googleCalendarOperationRef = useRef<GoogleCalendarDialogOperation>(null);
  const googleCalendarUiEpochRef = useRef(0);
  const googleCalendarSyncAbortRef = useRef<AbortController | null>(null);
  const googleCalendarTaskSyncQueueRef = useRef(new Map<string, GoogleCalendarTaskSyncQueueRequest>());
  const googleCalendarConnectionLifecycleEpochRef = useRef(0);
  const googleCalendarConnectionGenerationRef = useRef<string | null>(null);
  const googleCalendarTaskSyncFailuresRef = useRef(new Map<string, GoogleCalendarTaskSyncFailure>());
  const googleCalendarTaskSyncPreviouslyDatedRef = useRef(new Map<string, boolean>());
  const googleCalendarTaskSyncRunnersRef = useRef(new Map<string, symbol>());
  const googleCalendarTaskSyncVersionsRef = useRef(new Map<string, number>());
  const taskDuplicationPendingRef = useRef(false);
  const needsScheduleData = Boolean(privateKey) && activeView !== null;

  const refreshGoogleCalendarStatus = useCallback(async (
    showLoading = true,
    surfaceError = true,
    signal?: AbortSignal
  ) => {
    if (!googleCalendarProfileUid || !privateKey) {
      googleCalendarConnectionGenerationRef.current = null;
      setGoogleCalendarConnection(disconnectedGoogleCalendarStatus);
      return disconnectedGoogleCalendarStatus;
    }

    const requestId = googleCalendarStatusRequestRef.current + 1;
    googleCalendarStatusRequestRef.current = requestId;

    if (showLoading) {
      setGoogleCalendarLoading(true);
    }

    try {
      const nextStatus = await getGoogleCalendarConnectionStatus(signal);

      if (googleCalendarStatusRequestRef.current === requestId) {
        const previousGeneration = googleCalendarConnectionGenerationRef.current;
        const generationChanged = previousGeneration !== nextStatus.connectionGeneration;

        googleCalendarConnectionGenerationRef.current = nextStatus.connectionGeneration;
        if (generationChanged) {
          const staleFailureWarnings = new Set(
            Array.from(googleCalendarTaskSyncFailuresRef.current.values(), (failure) => failure.warning)
          );

          googleCalendarConnectionLifecycleEpochRef.current += 1;
          googleCalendarTaskSyncQueueRef.current.clear();
          googleCalendarTaskSyncRunnersRef.current.clear();
          googleCalendarTaskSyncVersionsRef.current.clear();
          googleCalendarTaskSyncFailuresRef.current.clear();
          googleCalendarTaskSyncPreviouslyDatedRef.current.clear();
          setGoogleCalendarTaskSyncPendingCount(0);
          setGoogleCalendarError(null);
          setError((current) => current && staleFailureWarnings.has(current) ? null : current);
        }
        const surfacedFailure = Array.from(googleCalendarTaskSyncFailuresRef.current.values())
          .reverse()
          .find((failure) => failure.surfaced);

        setGoogleCalendarConnection(surfacedFailure
          ? { ...nextStatus, lastSyncStatus: "failed" }
          : nextStatus);
        if (surfaceError) {
          setGoogleCalendarError(surfacedFailure?.warning ?? null);
          setGoogleCalendarNotice(null);
        }
      }
      return nextStatus;
    } catch (caught) {
      if (googleCalendarStatusRequestRef.current === requestId && surfaceError) {
        setGoogleCalendarConnection((current) => ({ ...current, lastSyncStatus: "failed" }));
        setGoogleCalendarError(googleCalendarErrorMessage(caught));
      }
      throw caught;
    } finally {
      if (showLoading && googleCalendarStatusRequestRef.current === requestId) {
        setGoogleCalendarLoading(false);
      }
    }
  }, [googleCalendarProfileUid, privateKey]);

  useEffect(() => {
    const taskSyncQueue = googleCalendarTaskSyncQueueRef.current;
    const taskSyncRunners = googleCalendarTaskSyncRunnersRef.current;
    const taskSyncVersions = googleCalendarTaskSyncVersionsRef.current;
    const taskSyncFailures = googleCalendarTaskSyncFailuresRef.current;
    const taskSyncPreviouslyDated = googleCalendarTaskSyncPreviouslyDatedRef.current;

    googleCalendarUiEpochRef.current += 1;
    googleCalendarAttemptRef.current += 1;
    googleCalendarStatusRequestRef.current += 1;
    googleCalendarSyncAbortRef.current?.abort();
    googleCalendarSyncAbortRef.current = null;
    googleCalendarPopupRef.current?.close();
    googleCalendarPopupRef.current = null;
    clearGoogleCalendarSession();
    googleCalendarConnectionGenerationRef.current = null;
    setGoogleCalendarConnection(disconnectedGoogleCalendarStatus);
    setGoogleCalendarError(null);
    setGoogleCalendarNotice(null);
    setGoogleCalendarDialogOpen(false);
    setGoogleCalendarOperation(null);
    googleCalendarOperationRef.current = null;
    setGoogleCalendarProgress(null);
    taskSyncQueue.clear();
    taskSyncRunners.clear();
    taskSyncVersions.clear();
    taskSyncFailures.clear();
    taskSyncPreviouslyDated.clear();
    googleCalendarConnectionLifecycleEpochRef.current += 1;
    setGoogleCalendarTaskSyncPendingCount(0);

    if (googleCalendarProfileUid && privateKey) {
      void refreshGoogleCalendarStatus(false, false).catch(() => undefined);
    }

    return () => {
      googleCalendarUiEpochRef.current += 1;
      googleCalendarAttemptRef.current += 1;
      googleCalendarStatusRequestRef.current += 1;
      googleCalendarSyncAbortRef.current?.abort();
      googleCalendarSyncAbortRef.current = null;
      googleCalendarPopupRef.current?.close();
      googleCalendarPopupRef.current = null;
      googleCalendarOperationRef.current = null;
      taskSyncQueue.clear();
      taskSyncRunners.clear();
      taskSyncVersions.clear();
      taskSyncFailures.clear();
      taskSyncPreviouslyDated.clear();
      googleCalendarConnectionLifecycleEpochRef.current += 1;
      googleCalendarConnectionGenerationRef.current = null;
      clearGoogleCalendarSession();
    };
  }, [googleCalendarProfileUid, privateKey, refreshGoogleCalendarStatus]);

  useEffect(() => {
    if (!googleCalendarDialogOpen || !googleCalendarProfileUid || !privateKey) {
      return;
    }

    const refreshVisibleConnection = () => {
      if (document.visibilityState === "hidden" || googleCalendarOperationRef.current) {
        return;
      }

      void refreshGoogleCalendarStatus(false, false).catch(() => undefined);
    };
    const interval = window.setInterval(refreshVisibleConnection, 30_000);

    document.addEventListener("visibilitychange", refreshVisibleConnection);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshVisibleConnection);
    };
  }, [googleCalendarDialogOpen, googleCalendarProfileUid, privateKey, refreshGoogleCalendarStatus]);

  useEffect(() => {
    const requestedView = scheduleViewFromSearch(location.search);

    if (requestedView) {
      setActiveView(requestedView);
      return undefined;
    }

    const rawRequestedView = new URLSearchParams(location.search).get("view");

    if (rawRequestedView) {
      navigate(scheduleViewHref("calendar"), { replace: true });
      return undefined;
    }

    if (!profile) {
      setActiveView(null);
      return undefined;
    }

    let active = true;
    const cachedPreferences = getCachedUserPreferences(profile.uid);

    const cachedView = normalizePrimaryScheduleView(cachedPreferences?.scheduleDefaultView);

    setActiveView(cachedView);

    void getUserPreferences(profile.uid)
      .then((preferences) => {
        if (active) {
          const nextView = normalizePrimaryScheduleView(preferences.scheduleDefaultView);

          setActiveView(nextView);
        }
      })
      .catch(() => {
        if (active) {
          const fallbackView = normalizePrimaryScheduleView(
            cachedPreferences?.scheduleDefaultView ?? defaultUserPreferences.scheduleDefaultView
          );

          setActiveView(fallbackView);
        }
      });

    return () => {
      active = false;
    };
  }, [location.search, navigate, profile]);

  useEffect(() => {
    if (!profile) {
      setMatrixLabels(defaultMatrixLabels);
      setScheduleCategoryFilter(defaultScheduleCategoryFilter);
      scheduleDefaultCategoryRef.current = null;
      scheduleCategoryPreferenceResolvedRef.current = false;
      scheduleCategoryTouchedBeforePreferenceRef.current = false;
      return undefined;
    }

    const cachedPreferences = getCachedUserPreferences(profile.uid);
    const cachedDefaultCategory = cachedPreferences?.scheduleDefaultCategory ?? defaultScheduleCategoryFilter;

    setMatrixLabels(cachedPreferences?.matrixLabels ?? defaultMatrixLabels);
    setScheduleCategoryFilter(cachedDefaultCategory);
    scheduleDefaultCategoryRef.current = cachedDefaultCategory;
    scheduleCategoryPreferenceResolvedRef.current = false;
    scheduleCategoryTouchedBeforePreferenceRef.current = false;

    return subscribeUserPreferences(
      profile.uid,
      (preferences) => {
        setMatrixLabels(preferences.matrixLabels);
        const defaultCategoryChanged = scheduleDefaultCategoryRef.current !== preferences.scheduleDefaultCategory;
        const userSelectedBeforeInitialPreference = scheduleCategoryTouchedBeforePreferenceRef.current;

        scheduleDefaultCategoryRef.current = preferences.scheduleDefaultCategory;
        if (
          defaultCategoryChanged
          && (scheduleCategoryPreferenceResolvedRef.current || !userSelectedBeforeInitialPreference)
        ) {
          setScheduleCategoryFilter(preferences.scheduleDefaultCategory);
        }
        scheduleCategoryPreferenceResolvedRef.current = true;
        scheduleCategoryTouchedBeforePreferenceRef.current = false;
      },
      () => {
        setMatrixLabels(cachedPreferences?.matrixLabels ?? defaultMatrixLabels);
        scheduleCategoryPreferenceResolvedRef.current = true;
        scheduleCategoryTouchedBeforePreferenceRef.current = false;
      },
      preferencesCryptoContext
    );
  }, [preferencesCryptoContext, profile]);

  useEffect(() => {
    let timeoutId: number | undefined;

    function scheduleMidnightRefresh() {
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }

      const now = new Date();
      const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);

      timeoutId = window.setTimeout(() => {
        setToday(toLocalDateString(new Date()));
        scheduleMidnightRefresh();
      }, Math.max(1000, nextMidnight.getTime() - now.getTime()));
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        setToday(toLocalDateString(new Date()));
        scheduleMidnightRefresh();
      }
    }

    scheduleMidnightRefresh();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (!profile || !needsScheduleData) {
      setTasks([]);
      setScheduleTasksLoaded(false);
      return undefined;
    }

    setScheduleTasksLoaded(false);

    return subscribeScheduleTasks(
      profile.uid,
      (nextTasks) => {
        setTasks(nextTasks);
        setScheduleTasksLoaded(true);
        setError(null);
      },
      (caught) => {
        setScheduleTasksLoaded(false);
        setError(scheduleActionError(caught, "일정 목록을 불러오지 못했습니다."));
      }
    );
  }, [needsScheduleData, profile]);

  useEffect(() => {
    const uid = profile?.uid ?? null;
    const currentIdentity = decryptCacheIdentityRef.current;

    if (currentIdentity.privateKey !== privateKey || currentIdentity.uid !== uid) {
      decryptedTaskCacheRef.current.clear();
      setDecryptedTasks([]);
      decryptCacheIdentityRef.current = { privateKey, uid };
    }
  }, [privateKey, profile?.uid]);

  useEffect(() => {
    if (!profile || !privateKey) {
      decryptedTaskCacheRef.current.clear();
      setDecryptedTasks([]);
      return undefined;
    }

    const safeProfile = profile;
    const safePrivateKey = privateKey;
    let active = true;

    const ownsCurrentCache = () => active
      && decryptCacheIdentityRef.current.privateKey === safePrivateKey
      && decryptCacheIdentityRef.current.uid === safeProfile.uid;

    async function decryptTasks() {
      if (!ownsCurrentCache()) {
        return;
      }

      pruneScheduleDecryptCache(decryptedTaskCacheRef.current, tasks);
      const nextTasks = await mapWithConcurrency(
        tasks,
        scheduleDecryptConcurrency,
        async (task) => {
          if (!ownsCurrentCache()) {
            return null;
          }

          const wrappedKey = task.wrappedKeys[safeProfile.uid];

          if (!wrappedKey) {
            decryptedTaskCacheRef.current.delete(task.id);
            return null;
          }

          const cached = decryptedTaskCacheRef.current.get(task.id);

          if (
            cached
            && sameEncryptedPayload(cached.encryptedTitle, task.encryptedTitle)
            && cached.encryptedCategory === task.encryptedCategory
            && sameEncryptedPayload(cached.encryptedDetails, task.encryptedDetails)
            && sameWrappedKey(cached.wrappedKey, wrappedKey)
          ) {
            decryptedTaskCacheRef.current.set(task.id, {
              ...cached,
              encryptedCategory: task.encryptedCategory,
              encryptedDetails: task.encryptedDetails,
              encryptedTitle: task.encryptedTitle,
              wrappedKey
            });

            return {
              ...task,
              title: cached.title,
              details: cached.details
            } satisfies DecryptedScheduleTask;
          }

          try {
            const taskKey = await unwrapNoteKey(wrappedKey, safePrivateKey);
            const [title, details] = await Promise.all([
              decryptText(task.encryptedTitle, taskKey),
              decryptScheduleTaskDetails(task, taskKey)
            ]);

            const decryptedTask = {
              ...task,
              title,
              details
            } satisfies DecryptedScheduleTask;

            if (!ownsCurrentCache()) {
              return null;
            }

            decryptedTaskCacheRef.current.set(task.id, {
              details: decryptedTask.details,
              encryptedCategory: task.encryptedCategory,
              encryptedDetails: task.encryptedDetails,
              encryptedTitle: task.encryptedTitle,
              title: decryptedTask.title,
              wrappedKey
            });
            return decryptedTask;
          } catch {
            if (ownsCurrentCache()) {
              decryptedTaskCacheRef.current.delete(task.id);
            }
            return null;
          }
        }
      );

      if (ownsCurrentCache()) {
        setDecryptedTasks(nextTasks.filter((task): task is DecryptedScheduleTask => Boolean(task)));
      }
    }

    void decryptTasks();

    return () => {
      active = false;
    };
  }, [privateKey, profile, tasks]);

  useEffect(() => {
    decryptedTasksRef.current = decryptedTasks;
  }, [decryptedTasks]);

  const sortedTasks = useMemo(() => [...decryptedTasks].sort(compareTaskSchedule), [decryptedTasks]);
  const categoryViewActive = activeView === "calendar" || activeView === "matrix";
  const showTaskCategories = !categoryViewActive || scheduleCategoryFilter === "all";
  const categoryFilteredTasks = useMemo(
    () => categoryViewActive
      ? sortedTasks.filter((task) => scheduleTaskMatchesCategory(task, scheduleCategoryFilter))
      : sortedTasks,
    [categoryViewActive, scheduleCategoryFilter, sortedTasks]
  );
  const eligibleGoogleCalendarTasks = useMemo(
    () => sortedTasks.filter(isEligibleExistingGoogleCalendarTask),
    [sortedTasks]
  );
  const displayedTasks = useMemo(
    () => categoryFilteredTasks.filter((task) => scheduleTaskMatchesQuery(task, scheduleQuery)),
    [categoryFilteredTasks, scheduleQuery]
  );
  const viewTask = useMemo(
    () => sortedTasks.find((task) => task.id === viewTaskId) ?? null,
    [viewTaskId, sortedTasks]
  );
  const editingTask = useMemo(
    () => sortedTasks.find((task) => task.id === editingTaskId) ?? null,
    [editingTaskId, sortedTasks]
  );
  const matrixSections = useMemo(
    () => activeView === "matrix" ? groupTasksByMatrix(displayedTasks, today, matrixLabels) : [],
    [activeView, displayedTasks, matrixLabels, today]
  );
  const activeMatrixTaskCount = useMemo(
    () => activeView === "matrix" ? categoryFilteredTasks.filter((task) => task.status !== "completed").length : 0,
    [activeView, categoryFilteredTasks]
  );
  const visibleMatrixTaskCount = useMemo(
    () => activeView === "matrix" ? displayedTasks.filter((task) => task.status !== "completed").length : 0,
    [activeView, displayedTasks]
  );
  const calendarWeeks = useMemo(
    () => activeView === "calendar"
      ? buildCalendarMonth(calendarCursor.getFullYear(), calendarCursor.getMonth(), today)
      : [],
    [activeView, calendarCursor, today]
  );
  const calendarTaskMap = useMemo(
    () => activeView === "calendar" ? tasksByDate(displayedTasks) : {},
    [activeView, displayedTasks]
  );
  const calendarTaskLayout = useMemo(
    () => activeView === "calendar" ? buildCalendarTaskLayout(calendarWeeks, displayedTasks) : {},
    [activeView, calendarWeeks, displayedTasks]
  );
  const calendarDateStrings = useMemo(
    () => activeView === "calendar"
      ? calendarWeeks.flatMap((week) => week.days.map((day) => day.dateString))
      : [],
    [activeView, calendarWeeks]
  );
  const calendarHolidayMap = useKoreanHolidayMap(calendarDateStrings);
  const selectedDayTasks = useMemo(
    () => activeView === "calendar"
      ? [...(calendarTaskMap[selectedCalendarDate] ?? [])].sort(compareCalendarAgendaTasks)
      : [],
    [activeView, calendarTaskMap, selectedCalendarDate]
  );

  if (!profile) {
    return null;
  }

  if (!privateKey) {
    return (
      <AppShell>
        <UnlockPanel />
      </AppShell>
    );
  }

  const unlockedProfile = profile;
  const unlockedPrivateKey = privateKey;

  async function authoritativeGoogleCalendarTask(
    taskId: string
  ): Promise<GoogleCalendarTaskInput | null> {
    let latestTask: Awaited<ReturnType<typeof getScheduleTask>>;

    try {
      latestTask = await getScheduleTask(taskId);
    } catch (caught) {
      throw googleCalendarTaskReadError(caught);
    }

    if (!latestTask || latestTask.ownerUid !== unlockedProfile.uid) {
      return null;
    }
    const rawStatus = (latestTask as { status?: unknown }).status;

    if (typeof rawStatus === "string"
      && rawStatus !== "active"
      && rawStatus !== "completed") {
      return null;
    }
    const wrappedKey = latestTask.wrappedKeys?.[unlockedProfile.uid];
    if (!wrappedKey) {
      throw new GoogleCalendarError(
        "task_decryption_failed",
        "이 일정의 암호화 키를 찾지 못했습니다. 다른 일정은 계속 동기화합니다."
      );
    }
    let title: string;

    try {
      const taskKey = await unwrapNoteKey(wrappedKey, unlockedPrivateKey);

      title = await decryptText(latestTask.encryptedTitle, taskKey);
    } catch {
      throw new GoogleCalendarError(
        "task_decryption_failed",
        "이 일정의 제목을 안전하게 읽지 못했습니다. 다른 일정은 계속 동기화합니다."
      );
    }
    const startDate = latestTask.startDate ?? latestTask.dueDate ?? null;
    const calendarRevisionTimestamp = googleCalendarTaskRevisionTimestamp(latestTask);

    const googleTask: GoogleCalendarTaskInput = {
      id: latestTask.id,
      ownerUid: latestTask.ownerUid,
      title: title.trim() || "제목 없음",
      startDate,
      endDate: startDate ? latestTask.endDate ?? startDate : null,
      startTimeMinutes: latestTask.startTimeMinutes ?? latestTask.dueTimeMinutes ?? null,
      endTimeMinutes: latestTask.endTimeMinutes ?? null,
      revision: googleCalendarTaskRevision(calendarRevisionTimestamp)
    };

    return googleTask;
  }

  function applyGoogleCalendarSyncSuccess(syncedCount: number) {
    const lastSyncAt = new Date().toISOString();

    setGoogleCalendarConnection((current) => ({
      ...current,
      connected: true,
      needsReconnect: false,
      lastSyncAt,
      lastSyncStatus: "synced",
      syncedCount
    }));
    setGoogleCalendarError(null);
    setGoogleCalendarNotice(null);
  }

  function reportGoogleCalendarSyncSuccess(syncedCount: number) {
    void reportGoogleCalendarSync({ status: "synced", syncedCount }).catch(() => undefined);
  }

  function applyGoogleCalendarSyncFailure(caught: unknown, syncedCount = 0) {
    const code = googleCalendarErrorCode(caught);
    const needsReconnect = new Set([
      "connection_changed",
      "google_reconnect_required",
      "not_connected",
      "permission_denied",
      "reauthorization_required"
    ]).has(code);

    setGoogleCalendarConnection((current) => ({
      ...current,
      connected: needsReconnect ? false : current.connected,
      needsReconnect: needsReconnect || current.needsReconnect,
      lastSyncAt: new Date().toISOString(),
      lastSyncStatus: "failed",
      syncedCount
    }));
    setGoogleCalendarError(googleCalendarErrorMessage(caught));
    setGoogleCalendarNotice(null);
  }

  async function reportGoogleCalendarSyncFailure(caught: unknown, syncedCount = 0) {
    const code = googleCalendarErrorCode(caught);
    const needsReconnect = new Set([
      "connection_changed",
      "google_reconnect_required",
      "not_connected",
      "permission_denied",
      "reauthorization_required"
    ]).has(code);

    const persistReconnectFailure = code === "permission_denied" || code === "reauthorization_required";

    if (!needsReconnect || persistReconnectFailure) {
      await reportGoogleCalendarSync({
        failureCode: code,
        status: "failed",
        syncedCount
      }).catch(() => undefined);
    }
  }

  async function updateGoogleCalendarSyncFailure(caught: unknown, syncedCount = 0, report = true) {
    applyGoogleCalendarSyncFailure(caught, syncedCount);

    if (report) {
      await reportGoogleCalendarSyncFailure(caught, syncedCount);
    }
  }

  function latestGoogleCalendarTaskSyncFailure() {
    const failures = Array.from(googleCalendarTaskSyncFailuresRef.current.values());

    return failures.length > 0 ? failures[failures.length - 1] : null;
  }

  function surfaceGoogleCalendarTaskSyncFailure(taskId: string, warning: string, caught: unknown) {
    const failures = googleCalendarTaskSyncFailuresRef.current;

    failures.delete(taskId);
    failures.set(taskId, { surfaced: true, warning });
    applyGoogleCalendarSyncFailure(caught);
    setGoogleCalendarError(warning);
    setStatus(null);
    setError(warning);
  }

  function rememberGoogleCalendarTaskSyncFailures(failureKeys: Iterable<string>, warning: string) {
    const failures = googleCalendarTaskSyncFailuresRef.current;

    for (const failureKey of failureKeys) {
      failures.delete(failureKey);
      failures.set(failureKey, { surfaced: true, warning });
    }
  }

  function rememberUnresolvedGoogleCalendarRecoveryState(failureKey: string, warning: string) {
    const failures = googleCalendarTaskSyncFailuresRef.current;
    const existingFailure = failures.get(failureKey);

    if (!existingFailure) {
      failures.set(failureKey, { surfaced: false, warning });
    }
  }

  function clearGoogleCalendarTaskSyncFailures(taskIds: string[], syncedCount: number) {
    const failures = googleCalendarTaskSyncFailuresRef.current;

    taskIds.forEach((taskId) => failures.delete(taskId));
    const remainingFailure = latestGoogleCalendarTaskSyncFailure();

    if (remainingFailure) {
      remainingFailure.surfaced = true;
      setGoogleCalendarConnection((current) => ({ ...current, lastSyncStatus: "failed" }));
      setGoogleCalendarError(remainingFailure.warning);
      setStatus(null);
      setError(remainingFailure.warning);
      return false;
    }

    applyGoogleCalendarSyncSuccess(syncedCount);
    setError(null);
    return true;
  }

  function invalidateGoogleCalendarTaskSyncLifecycle() {
    googleCalendarConnectionLifecycleEpochRef.current += 1;
    googleCalendarStatusRequestRef.current += 1;
    googleCalendarTaskSyncQueueRef.current.clear();
    googleCalendarTaskSyncRunnersRef.current.clear();
    googleCalendarTaskSyncVersionsRef.current.clear();
    googleCalendarTaskSyncFailuresRef.current.clear();
    googleCalendarTaskSyncPreviouslyDatedRef.current.clear();
    setGoogleCalendarTaskSyncPendingCount(0);
  }

  async function recordGoogleCalendarTaskSyncReceipt(
    task: GoogleCalendarTaskInput,
    connection: GoogleCalendarConnectionStatus,
    manualExistingSync = false
  ) {
    const taskUpdatedAt = googleCalendarTaskRevisionValue(task.revision);

    if (!connection.connectionGeneration || !taskUpdatedAt) {
      throw new GoogleCalendarError(
        "connection_changed",
        "Google Calendar 연결 또는 일정 수정본이 변경되었습니다. 다시 동기화해주세요."
      );
    }

    try {
      await markScheduleTaskGoogleCalendarSynced(
        task.id,
        task.ownerUid,
        connection.connectionGeneration,
        taskUpdatedAt
      );
    } catch (caught) {
      throw new GoogleCalendarError(
        "sync_receipt_failed",
        manualExistingSync
          ? `Google 일정은 반영했지만 동기화 상태를 저장하지 못했습니다. 기존 일정 동기화를 다시 실행하면 같은 Google 일정에 중복 없이 이어서 확인합니다. ${scheduleActionError(caught, "동기화 상태를 저장하지 못했습니다.")}`
          : `Google 일정은 반영했지만 동기화 상태를 저장하지 못했습니다. ${scheduleActionError(caught, "잠시 후 자동으로 다시 확인합니다.")}`,
        true
      );
    }
  }

  async function upsertGoogleCalendarTaskWithRetry(
    task: GoogleCalendarTaskInput,
    maxRetries = 0,
    timeZone = googleCalendarConnection.timeZone || detectedGoogleCalendarTimeZone(),
    signal?: AbortSignal,
    authorityReconciliations = 0,
    deletionWorkflow?: GoogleCalendarDeletionWorkflow,
    verifiedStatus?: GoogleCalendarConnectionStatus
  ): Promise<GoogleCalendarSyncResult> {
    const authorityBeforeSync = await inspectGoogleCalendarTaskAuthority(task);

    if (authorityBeforeSync === "deleted" || authorityBeforeSync === "undated") {
      return deleteGoogleCalendarTaskWithAuthorityReconciliation(
        task,
        maxRetries,
        timeZone,
        signal,
        authorityReconciliations,
        undefined,
        deletionWorkflow,
        verifiedStatus
      );
    }
    if (authorityBeforeSync === "stale") {
      if (authorityReconciliations >= 2) {
        return { eventId: null, outcome: "skipped" as const };
      }
      const latestTask = await authoritativeGoogleCalendarTask(task.id);

      if (!latestTask) {
        return deleteGoogleCalendarTaskWithAuthorityReconciliation(
          task,
          maxRetries,
          timeZone,
          signal,
          authorityReconciliations,
          undefined,
          deletionWorkflow,
          verifiedStatus
        );
      }
      return upsertGoogleCalendarTaskWithRetry(
        latestTask,
        maxRetries,
        timeZone,
        signal,
        authorityReconciliations + 1,
        deletionWorkflow,
        verifiedStatus
      );
    }

    let attempt = 0;

    while (true) {
      if (signal?.aborted) {
        throw new GoogleCalendarError("sync_cancelled", "기존 일정 동기화를 취소했습니다.");
      }

      try {
        const result = verifiedStatus
          ? await upsertGoogleCalendarTask(task, timeZone, signal, deletionWorkflow, verifiedStatus)
          : deletionWorkflow
          ? await upsertGoogleCalendarTask(task, timeZone, signal, deletionWorkflow)
          : await upsertGoogleCalendarTask(task, timeZone, signal);
        const authorityAfterSync = await inspectGoogleCalendarTaskAuthority(task);

        if (authorityAfterSync === "deleted" || authorityAfterSync === "undated") {
          return deleteGoogleCalendarTaskWithAuthorityReconciliation(
            task,
            maxRetries,
            timeZone,
            undefined,
            authorityReconciliations,
            undefined,
            deletionWorkflow,
            verifiedStatus
          );
        }
        if (authorityAfterSync === "stale") {
          if (authorityReconciliations >= 2) {
            return { ...result, outcome: "skipped" as const };
          }
          const latestTask = await authoritativeGoogleCalendarTask(task.id);

          if (!latestTask) {
            return deleteGoogleCalendarTaskWithAuthorityReconciliation(
              task,
              maxRetries,
              timeZone,
              undefined,
              authorityReconciliations,
              undefined,
              deletionWorkflow,
              verifiedStatus
            );
          }
          return upsertGoogleCalendarTaskWithRetry(
            latestTask,
            maxRetries,
            timeZone,
            undefined,
            authorityReconciliations + 1,
            deletionWorkflow,
            verifiedStatus
          );
        }

        return result;
      } catch (caught) {
        const retryable = caught instanceof GoogleCalendarError && caught.retryable;

        if (!retryable || attempt >= maxRetries) {
          throw caught;
        }

        const retryAfter = caught.retryAfterMs ?? 0;
        const backoff = Math.min(5_000, 500 * (2 ** attempt) + Math.floor(Math.random() * 250));
        await new Promise<void>((resolve, reject) => {
          if (signal?.aborted) {
            reject(new GoogleCalendarError("sync_cancelled", "기존 일정 동기화를 취소했습니다."));
            return;
          }

          const delay = Math.max(retryAfter, backoff);
          const timer = window.setTimeout(() => {
            signal?.removeEventListener("abort", handleAbort);
            resolve();
          }, delay);
          const handleAbort = () => {
            window.clearTimeout(timer);
            reject(new GoogleCalendarError("sync_cancelled", "기존 일정 동기화를 취소했습니다."));
          };

          signal?.addEventListener("abort", handleAbort, { once: true });
        });
        attempt += 1;
      }
    }
  }

  async function deleteGoogleCalendarTaskWithAuthorityReconciliation(
    task: GoogleCalendarTaskInput,
    maxRetries: number,
    timeZone: string,
    signal: AbortSignal | undefined,
    authorityReconciliations: number,
    onRemoteDelete?: (remoteWasPresent: boolean) => void,
    deletionWorkflow?: GoogleCalendarDeletionWorkflow,
    verifiedStatus?: GoogleCalendarConnectionStatus
  ): Promise<GoogleCalendarSyncResult> {
    const deleteInput = { id: task.id, ownerUid: task.ownerUid };
    const result = verifiedStatus
      ? await deleteGoogleCalendarTask(deleteInput, signal, deletionWorkflow, verifiedStatus)
      : deletionWorkflow
      ? await deleteGoogleCalendarTask(deleteInput, signal, deletionWorkflow)
      : signal
        ? await deleteGoogleCalendarTask(deleteInput, signal)
        : await deleteGoogleCalendarTask(deleteInput);
    onRemoteDelete?.(result.remoteWasPresent === true);
    let authorityAfterDelete: Awaited<ReturnType<typeof inspectGoogleCalendarTaskAuthority>>;

    try {
      authorityAfterDelete = await inspectGoogleCalendarTaskAuthority(task);
    } catch (caught) {
      if (!onRemoteDelete) {
        const latestTask = await authoritativeGoogleCalendarTask(task.id).catch(() => null);

        if (latestTask?.startDate) {
          if (verifiedStatus) {
            await upsertGoogleCalendarTask(
              latestTask,
              timeZone,
              undefined,
              deletionWorkflow,
              verifiedStatus
            );
          } else if (deletionWorkflow) {
            await upsertGoogleCalendarTask(latestTask, timeZone, undefined, deletionWorkflow);
          } else {
            await upsertGoogleCalendarTask(latestTask, timeZone, undefined);
          }
        }
      }
      throw caught;
    }

    if (authorityAfterDelete === "deleted" || authorityAfterDelete === "undated") {
      return result;
    }

    const latestTask = await authoritativeGoogleCalendarTask(task.id);

    if (!latestTask || !latestTask.startDate) {
      return result;
    }
    if (authorityReconciliations >= 2) {
      // Never leave a currently dated QuickMemo task without a Google event just
      // because the bounded reconciliation limit was reached.
      if (verifiedStatus) {
        await upsertGoogleCalendarTask(
          latestTask,
          timeZone,
          undefined,
          deletionWorkflow,
          verifiedStatus
        );
      } else if (deletionWorkflow) {
        await upsertGoogleCalendarTask(latestTask, timeZone, undefined, deletionWorkflow);
      } else {
        await upsertGoogleCalendarTask(latestTask, timeZone, undefined);
      }
      throw new GoogleCalendarError(
        "event_conflict",
        "일정이 다른 창에서 계속 변경되고 있습니다. 최신 내용을 확인한 뒤 다시 동기화해주세요."
      );
    }

    return upsertGoogleCalendarTaskWithRetry(
      latestTask,
      maxRetries,
      timeZone,
      undefined,
      authorityReconciliations + 1,
      deletionWorkflow,
      verifiedStatus
    );
  }

  async function reconcileGoogleCalendarTaskAfterSave(
    task: GoogleCalendarTaskInput,
    connection: GoogleCalendarConnectionStatus,
    authorityReconciliations = 0,
    signal?: AbortSignal
  ): Promise<{
    receiptTask: GoogleCalendarTaskInput | null;
    result: GoogleCalendarSyncResult;
  }> {
    const timeZone = connection.timeZone || detectedGoogleCalendarTimeZone();
    let reconciliation: Awaited<ReturnType<typeof reconcileGoogleCalendarTask>>;

    try {
      reconciliation = await reconcileGoogleCalendarTask(
        task,
        timeZone,
        signal,
        undefined,
        connection
      );
    } catch (caught) {
      // If a Google mutation may have completed but the final authority check
      // failed, restore a still-dated authoritative task before surfacing the
      // error. Tombstoned, deleted, and undated tasks intentionally stay absent.
      if (caught instanceof GoogleCalendarError && caught.mutationMayHaveApplied) {
        const latestTask = await authoritativeGoogleCalendarTask(task.id).catch(() => null);

        if (latestTask?.startDate) {
          await upsertGoogleCalendarTask(
            latestTask,
            timeZone,
            undefined,
            undefined,
            connection
          );
        }
      }
      throw caught;
    }
    const stableAuthority = reconciliation.authorityBefore !== "stale"
      && reconciliation.authorityBefore === reconciliation.authorityAfter;

    if (stableAuthority) {
      if (reconciliation.authorityAfter === "ineligible") {
        throw new GoogleCalendarError(
          "invalid_auth_response",
          "Google Calendar 일정의 동기화 자격을 확인하지 못했습니다."
        );
      }

      if (reconciliation.authorityAfter === "undated") {
        const latestTask = await authoritativeGoogleCalendarTask(task.id);

        if (latestTask?.startDate) {
          if (authorityReconciliations >= 2) {
            await upsertGoogleCalendarTask(
              latestTask,
              timeZone,
              signal,
              undefined,
              connection
            );
            throw new GoogleCalendarError(
              "event_conflict",
              "일정이 다른 창에서 계속 변경되고 있습니다. 최신 내용을 확인한 뒤 다시 동기화해주세요."
            );
          }

          return reconcileGoogleCalendarTaskAfterSave(
            latestTask,
            connection,
            authorityReconciliations + 1,
            signal
          );
        }

        return { receiptTask: latestTask, result: reconciliation.result };
      }

      return {
        receiptTask: reconciliation.authorityAfter === "deleted" ? null : task,
        result: reconciliation.result
      };
    }

    const latestTask = await authoritativeGoogleCalendarTask(task.id);

    if (authorityReconciliations >= 2) {
      // Match the legacy bounded reconciliation guarantee: if a delete raced
      // with a newly dated revision, restore the latest event before surfacing
      // the conflict. The durable receipt is intentionally not written because
      // convergence was not proven for an exact revision.
      if (reconciliation.result.outcome === "deleted"
        && latestTask?.startDate) {
        await upsertGoogleCalendarTask(
          latestTask,
          timeZone,
          signal,
          undefined,
          connection
        );
      }
      throw new GoogleCalendarError(
        "event_conflict",
        "일정이 다른 창에서 계속 변경되고 있습니다. 최신 내용을 확인한 뒤 다시 동기화해주세요."
      );
    }

    return reconcileGoogleCalendarTaskAfterSave(
      latestTask ?? task,
      connection,
      authorityReconciliations + 1,
      signal
    );
  }

  async function reconcileGoogleCalendarTaskAfterSaveWithRetry(
    task: GoogleCalendarTaskInput,
    connection: GoogleCalendarConnectionStatus,
    signal: AbortSignal,
    maxRetries = 2
  ) {
    let attempt = 0;

    while (true) {
      if (signal.aborted) {
        throw new GoogleCalendarError("sync_cancelled", "기존 일정 동기화를 취소했습니다.");
      }

      try {
        return await reconcileGoogleCalendarTaskAfterSave(
          task,
          connection,
          0,
          signal
        );
      } catch (caught) {
        const retryable = caught instanceof GoogleCalendarError && caught.retryable;

        if (!retryable || attempt >= maxRetries) {
          throw caught;
        }

        const retryAfter = caught.retryAfterMs ?? 0;
        const backoff = Math.min(5_000, 500 * (2 ** attempt) + Math.floor(Math.random() * 250));
        await new Promise<void>((resolve, reject) => {
          if (signal.aborted) {
            reject(new GoogleCalendarError("sync_cancelled", "기존 일정 동기화를 취소했습니다."));
            return;
          }

          const timer = window.setTimeout(() => {
            signal.removeEventListener("abort", handleAbort);
            resolve();
          }, Math.max(retryAfter, backoff));
          const handleAbort = () => {
            window.clearTimeout(timer);
            reject(new GoogleCalendarError("sync_cancelled", "기존 일정 동기화를 취소했습니다."));
          };

          signal.addEventListener("abort", handleAbort, { once: true });
        });
        attempt += 1;
      }
    }
  }

  async function syncGoogleCalendarTaskAfterSave(
    taskId: string,
    previouslyDated = false
  ): Promise<GoogleCalendarTaskSyncOutcome> {
    const foregroundSyncKey = `${unlockedProfile.uid}:${taskId}`;

    beginGoogleCalendarForegroundSync(foregroundSyncKey);
    try {
      let currentConnection: GoogleCalendarConnectionStatus;

      try {
        currentConnection = await refreshGoogleCalendarStatus(false, false);
      } catch (caught) {
        return {
          kind: "failed",
          caught,
          warning: `일정은 QuickMemo에 저장했지만 Google Calendar 연결 상태를 확인하지 못했습니다. ${googleCalendarErrorMessage(caught)}`
        };
      }

      if (currentConnection.needsReconnect) {
        const caught = new GoogleCalendarError(
          "reauthorization_required",
          "Google Calendar 계정을 다시 연결해야 동기화됩니다."
        );

        return {
          kind: "failed",
          caught,
          warning: "일정은 QuickMemo에 저장했지만 Google Calendar 계정을 다시 연결해야 동기화됩니다."
        };
      }

      if (!currentConnection.connected) {
        return { kind: "deferred" };
      }

      let task: GoogleCalendarTaskInput | null;

      try {
        task = await authoritativeGoogleCalendarTask(taskId);
      } catch (caught) {
        return {
          kind: "failed",
          caught,
          warning: `일정은 QuickMemo에 저장했지만 최신 내용을 확인하지 못해 Google Calendar에는 반영하지 않았습니다. ${scheduleActionError(caught, "최신 일정을 확인하지 못했습니다.")}`
        };
      }
      if (!task) {
        return { kind: "deferred" };
      }

      if (!task.startDate && !previouslyDated) {
        return { kind: "not-needed" };
      }

      try {
        const { receiptTask, result } = await reconcileGoogleCalendarTaskAfterSave(
          task,
          currentConnection
        );
        if (receiptTask) {
          await recordGoogleCalendarTaskSyncReceipt(receiptTask, currentConnection);
        }
        return { kind: "synced", syncedCount: result.outcome === "skipped" ? 0 : 1 };
      } catch (caught) {
        const warning = caught instanceof GoogleCalendarError && caught.code === "sync_receipt_failed"
          ? caught.message
          : `일정은 QuickMemo에 저장했지만 Google Calendar에는 반영하지 못했습니다. ${googleCalendarErrorMessage(caught)}`;

        return {
          kind: "failed",
          caught,
          warning
        };
      }
    } finally {
      endGoogleCalendarForegroundSync(foregroundSyncKey);
    }
  }

  function enqueueGoogleCalendarTaskSync(taskId: string, previouslyDated = false) {
    const queue = googleCalendarTaskSyncQueueRef.current;
    const runners = googleCalendarTaskSyncRunnersRef.current;
    const versions = googleCalendarTaskSyncVersionsRef.current;
    const stickyPreviouslyDated = googleCalendarTaskSyncPreviouslyDatedRef.current;
    const version = (versions.get(taskId) ?? 0) + 1;
    const queued = queue.get(taskId);
    const uiEpoch = googleCalendarUiEpochRef.current;
    const connectionLifecycleEpoch = googleCalendarConnectionLifecycleEpochRef.current;
    const mustReconcilePreviousDate = previouslyDated
      || stickyPreviouslyDated.get(taskId) === true
      || (queued?.connectionLifecycleEpoch === connectionLifecycleEpoch && queued.previouslyDated);

    if (mustReconcilePreviousDate) {
      stickyPreviouslyDated.set(taskId, true);
    }
    versions.set(taskId, version);
    queue.set(taskId, {
      connectionLifecycleEpoch,
      previouslyDated: mustReconcilePreviousDate,
      uiEpoch,
      version
    });
    setGoogleCalendarError(null);
    setGoogleCalendarNotice(null);
    if (runners.has(taskId)) {
      return;
    }

    const runnerToken = Symbol(taskId);

    runners.set(taskId, runnerToken);
    setGoogleCalendarTaskSyncPendingCount((current) => current + 1);
    void (async () => {
      let drainConverged = false;

      try {
        // Yield once so double submissions and rapid edits in the same turn are
        // collapsed before any Google or Vercel request starts.
        await Promise.resolve();
        while (googleCalendarUiEpochRef.current === uiEpoch
          && googleCalendarConnectionLifecycleEpochRef.current === connectionLifecycleEpoch) {
          const request = queue.get(taskId);

          if (!request) {
            break;
          }
          if (request.uiEpoch !== uiEpoch
            || request.connectionLifecycleEpoch !== connectionLifecycleEpoch) {
            break;
          }
          queue.delete(taskId);
          const sameConnectionLifecycle = () => googleCalendarUiEpochRef.current === uiEpoch
            && googleCalendarConnectionLifecycleEpochRef.current === request.connectionLifecycleEpoch;
          const isCurrentTaskRequest = () => sameConnectionLifecycle()
            && versions.get(taskId) === request.version;
          const outcome = await syncGoogleCalendarTaskAfterSave(
            taskId,
            request.previouslyDated || stickyPreviouslyDated.get(taskId) === true
          );

          drainConverged = outcome.kind === "synced" || outcome.kind === "not-needed";
          if (outcome.kind === "failed") {
            if (sameConnectionLifecycle()) {
              void reportGoogleCalendarSyncFailure(outcome.caught);
            }
            if (isCurrentTaskRequest()) {
              surfaceGoogleCalendarTaskSyncFailure(taskId, outcome.warning, outcome.caught);
            }
          } else if ((outcome.kind === "synced" || outcome.kind === "not-needed") && isCurrentTaskRequest()) {
            const syncedCount = outcome.kind === "synced" ? outcome.syncedCount : 0;

            const allTaskFailuresCleared = clearGoogleCalendarTaskSyncFailures([taskId], syncedCount);

            if (outcome.kind === "synced" && sameConnectionLifecycle() && allTaskFailuresCleared) {
              reportGoogleCalendarSyncSuccess(syncedCount);
            }
          }
        }
      } finally {
        const ownsRunner = runners.get(taskId) === runnerToken;

        if (ownsRunner) {
          runners.delete(taskId);
        }
        if (ownsRunner && googleCalendarUiEpochRef.current === uiEpoch) {
          setGoogleCalendarTaskSyncPendingCount((current) => Math.max(0, current - 1));
        }
        const pendingRequest = queue.get(taskId);

        if (pendingRequest?.uiEpoch === uiEpoch
          && pendingRequest.connectionLifecycleEpoch === connectionLifecycleEpoch) {
          queue.delete(taskId);
        }
        if (ownsRunner && !queue.has(taskId)) {
          versions.delete(taskId);
          if (drainConverged) {
            stickyPreviouslyDated.delete(taskId);
          }
        }
      }
    })();
  }

  function googleCalendarPopupResult(popup: Window) {
    try {
      const popupUrl = new URL(popup.location.href);

      if (popupUrl.origin !== window.location.origin) {
        return null;
      }

      if (popupUrl.pathname === "/schedule") {
        return "returned";
      }

      if (popupUrl.pathname !== "/api/google-calendar-auth") {
        return null;
      }

      const result = popupUrl.searchParams.get("result");
      return new Set(["success", "cancelled", "failed"]).has(result ?? "") ? result : null;
    } catch {
      return null;
    }
  }

  function openGoogleCalendarDialog() {
    const surfacedFailure = Array.from(googleCalendarTaskSyncFailuresRef.current.values())
      .reverse()
      .find((failure) => failure.surfaced);

    setGoogleCalendarDialogOpen(true);
    setGoogleCalendarError(surfacedFailure?.warning ?? null);
    setGoogleCalendarNotice(null);
    void refreshGoogleCalendarStatus(true, true).catch(() => undefined);
  }

  function closeGoogleCalendarDialog() {
    if (googleCalendarOperationRef.current) {
      return;
    }

    googleCalendarAttemptRef.current += 1;
    googleCalendarPopupRef.current?.close();
    googleCalendarPopupRef.current = null;
    setGoogleCalendarDialogOpen(false);
    setGoogleCalendarProgress(null);
    setGoogleCalendarNotice(null);
  }

  async function syncExistingGoogleCalendarTasks(
    verifiedConnection?: GoogleCalendarConnectionStatus
  ) {
    if (googleCalendarOperationRef.current) {
      return;
    }

    const eligibleTasks = decryptedTasksRef.current.filter(isEligibleExistingGoogleCalendarTask);

    if (!eligibleTasks.length) {
      setGoogleCalendarError(null);
      setGoogleCalendarNotice("동기화할 날짜 있는 기존 일정이 없습니다.");
      setStatus("동기화할 날짜 있는 기존 일정이 없습니다.");
      return;
    }

    const uiEpoch = googleCalendarUiEpochRef.current;
    const abortController = new AbortController();

    googleCalendarSyncAbortRef.current = abortController;
    googleCalendarOperationRef.current = "syncing";
    setGoogleCalendarOperation("syncing");
    setGoogleCalendarError(null);
    setGoogleCalendarNotice(null);
    setGoogleCalendarProgress({ completed: 0, total: eligibleTasks.length });

    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    let unchanged = 0;
    let firstFailure: unknown = null;
    let cancelled = false;
    const failedTaskIds = new Set<string>();
    const succeededTaskIds = new Set<string>();
    const progressInterval = Math.max(1, Math.ceil(eligibleTasks.length / 20));
    const updateBulkProgress = (completed: number) => {
      if (completed === eligibleTasks.length || completed % progressInterval === 0) {
        setGoogleCalendarProgress({ completed, total: eligibleTasks.length });
      }
    };

    try {
      const currentConnection = verifiedConnection
        ?? await refreshGoogleCalendarStatus(false, false, abortController.signal);

      if (googleCalendarUiEpochRef.current !== uiEpoch || abortController.signal.aborted) {
        return;
      }
      if (!currentConnection.connected || currentConnection.needsReconnect) {
        throw new GoogleCalendarError("not_connected", "Google Calendar 계정을 먼저 연결해주세요.");
      }
      for (let index = 0; index < eligibleTasks.length; index += 1) {
        const task = eligibleTasks[index];

        if (googleCalendarUiEpochRef.current !== uiEpoch || abortController.signal.aborted) {
          cancelled = true;
          break;
        }

        try {
          const { receiptTask, result } = await reconcileGoogleCalendarTaskAfterSaveWithRetry(
            googleCalendarTaskFromDecrypted(task),
            currentConnection,
            abortController.signal
          );
          if (receiptTask) {
            await recordGoogleCalendarTaskSyncReceipt(receiptTask, currentConnection, true);
          }
          succeededTaskIds.add(task.id);
          if (!receiptTask) {
            skipped += 1;
          } else if (result.outcome === "skipped") {
            unchanged += 1;
          } else {
            succeeded += 1;
          }
          if (abortController.signal.aborted) {
            cancelled = true;
            updateBulkProgress(index + 1);
            break;
          }
        } catch (caught) {
          if (googleCalendarUiEpochRef.current !== uiEpoch) {
            return;
          }
          if (googleCalendarErrorCode(caught) === "sync_cancelled") {
            cancelled = true;
            break;
          }

          failed += 1;
          failedTaskIds.add(task.id);
          firstFailure ??= caught;

          if (googleCalendarBatchShouldStop(caught)) {
            failed += eligibleTasks.length - index - 1;
            eligibleTasks.slice(index + 1).forEach((remainingTask) => {
              failedTaskIds.add(remainingTask.id);
            });
            updateBulkProgress(eligibleTasks.length);
            break;
          }
        }

        if (googleCalendarUiEpochRef.current !== uiEpoch) {
          return;
        }
        updateBulkProgress(index + 1);
      }

      if (googleCalendarUiEpochRef.current !== uiEpoch) {
        return;
      }

      if (cancelled) {
        if (failed > 0) {
          const failure = firstFailure ?? new GoogleCalendarError("unknown_error", "일부 일정을 동기화하지 못했습니다.");
          const failureMessage = `${succeeded}개는 반영했고 ${failed}개는 반영하지 못한 상태에서 동기화를 중단했습니다.${unchanged ? ` 이미 최신인 ${unchanged}개는 중복 없이 유지했습니다.` : ""}${skipped ? ` 변경된 ${skipped}개는 건너뛰었습니다.` : ""} ${googleCalendarErrorMessage(failure)}`;

          rememberGoogleCalendarTaskSyncFailures(failedTaskIds, failureMessage);
          succeededTaskIds.forEach((taskId) => googleCalendarTaskSyncFailuresRef.current.delete(taskId));
          await updateGoogleCalendarSyncFailure(failure, succeeded, false);
          await reportGoogleCalendarSync({
            failureCode: googleCalendarErrorCode(failure),
            status: "failed",
            syncedCount: succeeded
          }).catch(() => undefined);
          setGoogleCalendarError(failureMessage);
          setGoogleCalendarNotice(null);
          setStatus(null);
          setError(failureMessage);
        } else {
          const cancellationMessage = succeeded > 0
            ? `${succeeded}개 일정을 반영한 뒤 기존 일정 동기화를 중단했습니다.${unchanged ? ` 이미 최신인 ${unchanged}개는 중복 없이 유지했습니다.` : ""}${skipped ? ` 변경된 ${skipped}개는 건너뛰었습니다.` : ""}`
            : `기존 일정 동기화를 중단했습니다.${unchanged ? ` 이미 최신인 ${unchanged}개는 중복 없이 유지했습니다.` : ""}${skipped ? ` 변경된 ${skipped}개는 건너뛰었습니다.` : ""}`;
          const allTaskFailuresCleared = succeededTaskIds.size > 0
            ? clearGoogleCalendarTaskSyncFailures(Array.from(succeededTaskIds), succeeded)
            : googleCalendarTaskSyncFailuresRef.current.size === 0;

          if (succeededTaskIds.size > 0 && allTaskFailuresCleared) {
            reportGoogleCalendarSyncSuccess(succeeded);
          } else if (succeededTaskIds.size === 0 && allTaskFailuresCleared) {
            setGoogleCalendarError(null);
          }
          setGoogleCalendarNotice(cancellationMessage);
          if (allTaskFailuresCleared) {
            setStatus(cancellationMessage);
            setError(null);
          }
        }
      } else if (failed === 0) {
        const allTaskFailuresCleared = clearGoogleCalendarTaskSyncFailures(
          Array.from(succeededTaskIds),
          succeeded
        );

        if (allTaskFailuresCleared) {
          reportGoogleCalendarSyncSuccess(succeeded);
          setGoogleCalendarNotice(null);
          setStatus([
            succeeded ? `${succeeded}개 일정을 Google Calendar에 동기화했습니다.` : "",
            unchanged ? `이미 최신인 ${unchanged}개는 중복 없이 유지했습니다.` : "",
            skipped ? `실행 중 변경된 ${skipped}개는 안전하게 건너뛰었습니다.` : ""
          ].filter(Boolean).join(" "));
          setError(null);
        }
      } else {
        const failure = firstFailure ?? new GoogleCalendarError("unknown_error", "일부 일정을 동기화하지 못했습니다.");
        const failureMessage = `${succeeded}개는 반영했고 ${failed}개는 반영하지 못했습니다.${unchanged ? ` 이미 최신인 ${unchanged}개는 중복 없이 유지했습니다.` : ""}${skipped ? ` 변경된 ${skipped}개는 건너뛰었습니다.` : ""} ${googleCalendarErrorMessage(failure)}`;

        rememberGoogleCalendarTaskSyncFailures(failedTaskIds, failureMessage);
        succeededTaskIds.forEach((taskId) => googleCalendarTaskSyncFailuresRef.current.delete(taskId));

        await updateGoogleCalendarSyncFailure(failure, succeeded, false);
        await reportGoogleCalendarSync({
          failureCode: googleCalendarErrorCode(failure),
          status: "failed",
          syncedCount: succeeded
        }).catch(() => undefined);

        setGoogleCalendarError(failureMessage);
        setGoogleCalendarNotice(null);
        setStatus(null);
        setError(failureMessage);
      }
    } catch (caught) {
      if (googleCalendarUiEpochRef.current === uiEpoch) {
        if (abortController.signal.aborted || googleCalendarErrorCode(caught) === "sync_cancelled") {
          const cancellationMessage = "기존 일정 동기화를 중단했습니다.";

          setGoogleCalendarError(null);
          setGoogleCalendarNotice(cancellationMessage);
          setStatus(cancellationMessage);
          setError(null);
        } else {
          rememberGoogleCalendarTaskSyncFailures(
            eligibleTasks.map((task) => task.id),
            googleCalendarErrorMessage(caught)
          );
          await updateGoogleCalendarSyncFailure(caught, succeeded, false);
        }
      }
    } finally {
      if (googleCalendarSyncAbortRef.current === abortController) {
        googleCalendarSyncAbortRef.current = null;
      }
      if (googleCalendarUiEpochRef.current === uiEpoch && googleCalendarOperationRef.current === "syncing") {
        setGoogleCalendarProgress(null);
        googleCalendarOperationRef.current = null;
        setGoogleCalendarOperation(null);
      }
    }
  }

  function cancelGoogleCalendarSync() {
    googleCalendarSyncAbortRef.current?.abort();
  }

  function connectGoogleCalendar(syncExisting: boolean) {
    if (googleCalendarOperationRef.current) {
      return;
    }

    invalidateGoogleCalendarTaskSyncLifecycle();
    const connectionGenerationBeforeConnect = googleCalendarConnection.connectionGeneration;
    const uiEpoch = googleCalendarUiEpochRef.current;
    const width = 520;
    const height = 720;
    const left = Math.max(0, window.screenX + Math.round((window.outerWidth - width) / 2));
    const top = Math.max(0, window.screenY + Math.round((window.outerHeight - height) / 2));
    const popup = window.open(
      "about:blank",
      "_blank",
      `popup=yes,width=${width},height=${height},left=${left},top=${top}`
    );

    if (!popup) {
      setGoogleCalendarConnection((current) => ({ ...current, lastSyncStatus: "failed" }));
      setGoogleCalendarError("팝업이 차단되었습니다. 브라우저에서 팝업을 허용한 뒤 다시 시도해주세요.");
      return;
    }

    try {
      popup.opener = null;
    } catch {
      // Some browsers do not allow changing opener after window creation.
    }

    const attemptId = googleCalendarAttemptRef.current + 1;
    googleCalendarAttemptRef.current = attemptId;
    googleCalendarPopupRef.current?.close();
    googleCalendarPopupRef.current = popup;
    googleCalendarOperationRef.current = "connecting";
    setGoogleCalendarOperation("connecting");
    setGoogleCalendarError(null);
    setGoogleCalendarNotice(null);

    void (async () => {
      try {
        const { authorizationUrl, connectionAttemptId } = await startGoogleCalendarConnection(
          detectedGoogleCalendarTimeZone()
        );

        if (googleCalendarAttemptRef.current !== attemptId || popup.closed) {
          throw new GoogleCalendarError("popup_closed", "Google 로그인 창이 닫혔습니다. 다시 시도해주세요.");
        }

        popup.location.replace(authorizationUrl);
        const deadline = Date.now() + 5 * 60 * 1000;

        while (Date.now() < deadline) {
          await new Promise((resolve) => window.setTimeout(resolve, 750));

          if (googleCalendarAttemptRef.current !== attemptId || googleCalendarUiEpochRef.current !== uiEpoch) {
            return;
          }

          const popupResult = popup.closed ? null : googleCalendarPopupResult(popup);
          if (popupResult === "cancelled") {
            throw new GoogleCalendarError("authorization_cancelled", "Google Calendar 연결을 취소했습니다.");
          }
          if (popupResult === "failed") {
            throw new GoogleCalendarError("authorization_failed", "Google Calendar 연결을 완료하지 못했습니다.");
          }

          if (popupResult !== "success" && popupResult !== "returned" && !popup.closed) {
            continue;
          }

          const nextStatus = await refreshGoogleCalendarStatus(false, false);
          const generationChanged = Boolean(nextStatus.connectionGeneration)
            && nextStatus.connectionGeneration !== connectionGenerationBeforeConnect;
          const attemptMatches = nextStatus.connectionAttemptId === connectionAttemptId;

          if (nextStatus.connected && !nextStatus.needsReconnect && generationChanged && attemptMatches) {
            if (googleCalendarAttemptRef.current !== attemptId || googleCalendarUiEpochRef.current !== uiEpoch) {
              return;
            }
            popup.close();
            googleCalendarPopupRef.current = null;
            invalidateGoogleCalendarTaskSyncLifecycle();
            setGoogleCalendarConnection(nextStatus);
            googleCalendarOperationRef.current = null;
            setGoogleCalendarOperation(null);
            setGoogleCalendarError(null);

            if (syncExisting) {
              await syncExistingGoogleCalendarTasks(nextStatus);
            }
            return;
          }

          if (popup.closed) {
            throw new GoogleCalendarError("popup_closed", "Google 로그인 창이 닫혔습니다. 다시 시도해주세요.");
          }

          throw new GoogleCalendarError("authorization_failed", "Google Calendar 연결을 완료하지 못했습니다.");
        }

        throw new GoogleCalendarError(
          "authorization_timeout",
          "Google 계정 확인 시간이 초과되었습니다. 로그인 창을 닫고 다시 시도해주세요."
        );
      } catch (caught) {
        popup.close();
        if (googleCalendarPopupRef.current === popup) {
          googleCalendarPopupRef.current = null;
        }
        if (googleCalendarAttemptRef.current === attemptId && googleCalendarUiEpochRef.current === uiEpoch) {
          const code = googleCalendarErrorCode(caught);

          if (code === "authorization_cancelled" || code === "popup_closed") {
            setGoogleCalendarError(null);
            setGoogleCalendarNotice(
              code === "authorization_cancelled"
                ? "Google Calendar 연결을 취소했습니다. 기존 일정은 변경되지 않았습니다."
                : "Google 로그인 창이 닫혔습니다. 연결하려면 다시 시도해주세요."
            );
          } else {
            await updateGoogleCalendarSyncFailure(caught, 0, false);
          }
        }
      } finally {
        if (googleCalendarAttemptRef.current === attemptId && googleCalendarUiEpochRef.current === uiEpoch) {
          if (googleCalendarOperationRef.current === "connecting") {
            googleCalendarOperationRef.current = null;
          }
          setGoogleCalendarOperation((current) => current === "connecting" ? null : current);
        }
      }
    })();
  }

  async function removeGoogleCalendarConnection() {
    if (googleCalendarOperationRef.current) {
      return;
    }

    invalidateGoogleCalendarTaskSyncLifecycle();
    const uiEpoch = googleCalendarUiEpochRef.current;
    const connectionGeneration = googleCalendarConnection.connectionGeneration;
    const connectionIdentity = googleCalendarConnection.connectionIdentity ?? null;

    googleCalendarOperationRef.current = "disconnecting";
    setGoogleCalendarOperation("disconnecting");
    setGoogleCalendarError(null);
    setGoogleCalendarNotice(null);

    try {
      await disconnectGoogleCalendar(connectionGeneration, connectionIdentity);
      if (googleCalendarUiEpochRef.current !== uiEpoch) {
        return;
      }
      googleCalendarConnectionGenerationRef.current = null;
      setGoogleCalendarConnection({
        ...disconnectedGoogleCalendarStatus,
        configured: googleCalendarConnection.configured
      });
      setStatus("Google Calendar 연결을 해제했습니다. 기존 Google 일정은 유지됩니다.");
      setError(null);
    } catch (caught) {
      if (googleCalendarUiEpochRef.current === uiEpoch) {
        setGoogleCalendarConnection((current) => ({ ...current, lastSyncStatus: "failed" }));
        setGoogleCalendarError(googleCalendarErrorMessage(caught));
      }
    } finally {
      if (googleCalendarUiEpochRef.current === uiEpoch && googleCalendarOperationRef.current === "disconnecting") {
        googleCalendarOperationRef.current = null;
        setGoogleCalendarOperation(null);
      }
    }
  }

  async function encryptTaskFields(title: string, details: ScheduleTaskDetails, taskKey: CryptoKey) {
    return Promise.all([
      encryptText(title.trim() || "제목 없음", taskKey),
      encryptText(scheduleTaskDetailsEncryptionValue(details), taskKey),
      encryptText(scheduleCategoryEncryptionValue(details.category), taskKey)
    ]);
  }

  async function createTask(draft: CreateTaskDraft) {
    const trimmedTitle = draft.title.trim();

    if (!trimmedTitle) {
      return false;
    }

    const startDate = draft.startDate || draft.endDate || null;
    const endDate = startDate ? draft.endDate || startDate : null;

    if (startDate && !isSafeScheduleDateRange(startDate, endDate)) {
      setError(scheduleDateRangeValidationMessage);
      return false;
    }

    try {
      const startTimeMinutes = draft.timeMode === "none" ? null : timeInputToMinutes(draft.startTime);
      const endTimeMinutes = draft.timeMode === "range" ? timeInputToMinutes(draft.endTime) : null;
      const taskKey = await generateNoteKey();
      const details: ScheduleTaskDetails = {
        category: draft.category,
        description: draft.description,
        checklist: draft.checklist
          .map((item) => ({ ...item, text: item.text.trim() }))
          .filter((item) => item.text)
      };
      const [encryptedTitle, encryptedDetails, encryptedCategory] = await encryptTaskFields(trimmedTitle, details, taskKey);
      const wrappedKey = await wrapNoteKey(taskKey, unlockedProfile.publicKeyJwk);

      const createdTask = await createScheduleTask({
        ownerUid: unlockedProfile.uid,
        title: encryptedTitle,
        encryptedCategory: JSON.stringify(encryptedCategory),
        details: encryptedDetails,
        wrappedKey,
        dueDate: startDate,
        dueTimeMinutes: startTimeMinutes,
        startDate,
        endDate,
        startTimeMinutes,
        endTimeMinutes,
        color: normalizeScheduleTaskColor(draft.color),
        sortOrder: null,
        progressPercent: 0,
        isImportant: draft.isImportant,
        isUrgent: draft.isUrgent
      });
      if (createdTask?.id) {
        enqueueGoogleCalendarTaskSync(createdTask.id);
      }
      setStatus("일정을 추가했습니다.");
      setError(null);
      return true;
    } catch (caught) {
      setError(scheduleActionError(caught, "일정을 추가하지 못했습니다."));
      return false;
    }
  }

  async function toggleTask(task: DecryptedScheduleTask) {
    try {
      const nextCompleted = task.status !== "completed";
      await updateScheduleTask(task.id, unlockedProfile.uid, {
        status: nextCompleted ? "completed" : "active",
        completedAt: nextCompleted ? serverTimestamp() : null
      });
      setError(null);
    } catch (caught) {
      setError(scheduleActionError(caught, "일정 완료 상태를 바꾸지 못했습니다."));
    }
  }

  async function saveTask(
    task: DecryptedScheduleTask,
    draft: TaskDraft,
    expectedUpdatedAt: DecryptedScheduleTask["updatedAt"]
  ) {
    const wrappedKey = task.wrappedKeys[unlockedProfile.uid];

    if (!wrappedKey) {
      const message = "일정 암호화 키를 찾지 못했습니다.";

      setError(message);
      return message;
    }
    if (!expectedUpdatedAt) {
      const message = "일정의 최신 상태를 확인할 수 없습니다. 목록을 새로고침한 뒤 다시 저장해주세요.";

      setError(message);
      return message;
    }

    try {
      const taskKey = await unwrapNoteKey(wrappedKey, unlockedPrivateKey);
      const normalizedTitle = draft.title.trim() || "제목 없음";
      const titleChanged = normalizedTitle !== task.title;
      const details: ScheduleTaskDetails = {
        category: draft.category,
        description: draft.description,
        checklist: draft.checklist
          .map((item) => ({ ...item, text: item.text.trim() }))
          .filter((item) => item.text)
      };
      const [encryptedTitle, encryptedDetails, encryptedCategory] = await Promise.all([
        titleChanged ? encryptText(normalizedTitle, taskKey) : Promise.resolve(task.encryptedTitle),
        encryptText(scheduleTaskDetailsEncryptionValue(details), taskKey),
        encryptText(scheduleCategoryEncryptionValue(details.category), taskKey)
      ]);
      const nextCompleted = draft.status === "completed";
      const startDate = draft.startDate || null;
      const endDate = draft.endDate || startDate;
      const startTimeMinutes = draft.timeMode === "none" ? null : timeInputToMinutes(draft.startTime);
      const endTimeMinutes = draft.timeMode === "range" ? timeInputToMinutes(draft.endTime) : null;
      const googleCalendarChanged = titleChanged
        || startDate !== taskStartDate(task)
        || endDate !== taskEndDate(task)
        || startTimeMinutes !== taskStartTime(task)
        || endTimeMinutes !== (task.endTimeMinutes ?? null);

      if (startDate && !isSafeScheduleDateRange(startDate, endDate)) {
        setError(scheduleDateRangeValidationMessage);
        return scheduleDateRangeValidationMessage;
      }

      await updateScheduleTask(task.id, unlockedProfile.uid, {
        ...(titleChanged ? { encryptedTitle } : {}),
        encryptedCategory: JSON.stringify(encryptedCategory),
        encryptedDetails,
        dueDate: startDate,
        dueTimeMinutes: startTimeMinutes,
        startDate,
        endDate,
        startTimeMinutes,
        endTimeMinutes,
        color: normalizeScheduleTaskColor(draft.color),
        sortOrder: startDate === taskStartDate(task) ? (task.sortOrder ?? null) : null,
        progressPercent: normalizeTaskProgressPercent(draft.progressPercent),
        isImportant: draft.isImportant,
        isUrgent: draft.isUrgent,
        status: draft.status,
        completedAt: nextCompleted ? (task.completedAt ?? serverTimestamp()) : null
      }, { expectedUpdatedAt, googleCalendarChanged });
      setEditingTaskId(null);
      setViewTaskId(null);
      if (googleCalendarChanged) {
        enqueueGoogleCalendarTaskSync(
          task.id,
          Boolean(taskStartDate(task))
        );
      }
      setStatus("일정을 저장했습니다.");
      setError(null);
      return null;
    } catch (caught) {
      const message = scheduleActionError(caught, "일정을 저장하지 못했습니다.");

      setError(message);
      return message;
    }
  }

  async function latestTaskDetails(task: DecryptedScheduleTask, taskKey: CryptoKey) {
    const latestTask = await getScheduleTask(task.id);

    if (!latestTask || latestTask.ownerUid !== unlockedProfile.uid || !latestTask.updatedAt) {
      throw new Error("schedule-task/latest-details-unavailable");
    }

    return {
      details: await decryptScheduleTaskDetails(latestTask, taskKey),
      needsCategoryMigration: !latestTask.encryptedCategory,
      updatedAt: latestTask.updatedAt
    };
  }

  function normalizeMutableTaskDetails(details: ScheduleTaskDetails): ScheduleTaskDetails {
    const normalizedDetails = normalizeScheduleDetails(details);

    return {
      category: normalizedDetails.category,
      description: normalizedDetails.description,
      checklist: normalizedDetails.checklist
        .map((item) => ({ ...item, text: item.text.trim() }))
        .filter((item) => item.text)
    };
  }

  async function updateTaskDetails(task: DecryptedScheduleTask, updateDetails: TaskDetailsUpdater, fallback: string) {
    const wrappedKey = task.wrappedKeys[unlockedProfile.uid];

    if (!wrappedKey) {
      setError("일정 암호화 키를 찾지 못했습니다.");
      return false;
    }

    const previousUpdate = taskDetailsUpdateQueueRef.current[task.id] ?? Promise.resolve(task.details);
    const nextUpdate = previousUpdate
      .catch(() => task.details)
      .then(async () => {
        const taskKey = await unwrapNoteKey(wrappedKey, unlockedPrivateKey);

        for (let attempt = 0; attempt < 2; attempt += 1) {
          const latest = await latestTaskDetails(task, taskKey);
          const nextDetails = normalizeMutableTaskDetails(updateDetails(latest.details));
          const [encryptedDetails, encryptedCategory] = await Promise.all([
            encryptText(scheduleTaskDetailsEncryptionValue(nextDetails), taskKey),
            latest.needsCategoryMigration
              ? encryptText(scheduleCategoryEncryptionValue(nextDetails.category), taskKey)
              : Promise.resolve(null)
          ]);

          try {
            await updateScheduleTask(
              task.id,
              unlockedProfile.uid,
              {
                ...(encryptedCategory ? { encryptedCategory: JSON.stringify(encryptedCategory) } : {}),
                encryptedDetails
              },
              { expectedUpdatedAt: latest.updatedAt, googleCalendarChanged: false }
            );
            return nextDetails;
          } catch (caught) {
            if (
              attempt === 0
              && typeof caught === "object"
              && caught !== null
              && "code" in caught
              && caught.code === "schedule-task/revision-conflict"
            ) {
              continue;
            }
            throw caught;
          }
        }

        throw new Error("schedule-task/details-update-conflict");
      });

    taskDetailsUpdateQueueRef.current[task.id] = nextUpdate;

    try {
      await nextUpdate;
      setError(null);
      return true;
    } catch (caught) {
      setError(scheduleActionError(caught, fallback));
      return false;
    } finally {
      if (taskDetailsUpdateQueueRef.current[task.id] === nextUpdate) {
        delete taskDetailsUpdateQueueRef.current[task.id];
      }
    }
  }

  async function toggleTaskChecklistItem(task: DecryptedScheduleTask, itemId: string) {
    await updateTaskDetails(
      task,
      (details) => ({
        category: details.category,
        description: details.description,
        checklist: details.checklist.map((item) =>
          item.id === itemId ? { ...item, checked: !item.checked } : item
        )
      }),
      "체크리스트 상태를 저장하지 못했습니다."
    );
  }

  async function updateTaskProgress(task: DecryptedScheduleTask, percent: number) {
    try {
      await updateScheduleTask(task.id, unlockedProfile.uid, {
        progressPercent: normalizeTaskProgressPercent(percent)
      });
      setError(null);
    } catch (caught) {
      setError(scheduleActionError(caught, "진행률을 저장하지 못했습니다."));
    }
  }

  async function duplicateTask(task: DecryptedScheduleTask) {
    if (taskDuplicationPendingRef.current) {
      return;
    }

    taskDuplicationPendingRef.current = true;
    setTaskDuplicationPending(true);

    try {
      const details = task.details ?? emptyScheduleDetails;
      const copiedDetails: ScheduleTaskDetails = {
        category: details.category,
        description: details.description,
        checklist: details.checklist.map((item) => ({
          id: crypto.randomUUID(),
          text: item.text,
          checked: false
        }))
      };
      const startDate = taskStartDate(task);
      const endDate = taskEndDate(task);
      const startTimeMinutes = taskStartTime(task);
      const taskKey = await generateNoteKey();
      const [encryptedTitle, encryptedDetails, encryptedCategory] = await encryptTaskFields(task.title, copiedDetails, taskKey);
      const wrappedKey = await wrapNoteKey(taskKey, unlockedProfile.publicKeyJwk);

      const copiedTask = await createScheduleTask({
        ownerUid: unlockedProfile.uid,
        title: encryptedTitle,
        encryptedCategory: JSON.stringify(encryptedCategory),
        details: encryptedDetails,
        wrappedKey,
        dueDate: startDate,
        dueTimeMinutes: startTimeMinutes,
        startDate,
        endDate,
        startTimeMinutes,
        endTimeMinutes: task.endTimeMinutes ?? null,
        color: normalizeScheduleTaskColor(task.color),
        sortOrder: null,
        progressPercent: 0,
        isImportant: task.isImportant,
        isUrgent: task.isUrgent
      });
      setViewTaskId(null);
      if (copiedTask?.id) {
        enqueueGoogleCalendarTaskSync(copiedTask.id);
      }
      setStatus("일정을 복사했습니다.");
      setError(null);
    } catch (caught) {
      setError(scheduleActionError(caught, "일정을 복사하지 못했습니다."));
    } finally {
      taskDuplicationPendingRef.current = false;
      setTaskDuplicationPending(false);
    }
  }

  async function moveTaskToMatrixSection(task: DecryptedScheduleTask, sectionKey: MatrixQuadrantKey) {
    const priority = matrixPriorityForSection(sectionKey);
    const startDate = taskStartDate(task);
    const containsToday = taskDateRangeContains(task, today);
    const isOverdue = isTaskDateRangeOverdue(task, today);
    const moveToToday = sectionKey === "urgentImportant" && !containsToday && !isOverdue;
    const firstPriorityDate = addDays(today, 1);
    const moveToFirstPriority = sectionKey === "firstPriority" && isValidScheduleDateString(startDate) && startDate <= today;

    if (isOverdue && sectionKey !== "urgentImportant") {
      setStatus("날짜가 지난 업무는 오늘까지 해야 할 일에 유지됩니다.");
      setError(null);
      return;
    }

    let updateInput: UpdateScheduleTaskInput = priority;

    if (moveToToday) {
      updateInput = {
        ...priority,
        dueDate: today,
        startDate: today,
        endDate: today,
        sortOrder: null
      };
    } else if (moveToFirstPriority) {
      updateInput = {
        ...priority,
        dueDate: firstPriorityDate,
        startDate: firstPriorityDate,
        endDate: firstPriorityDate,
        sortOrder: null
      };
    }

    if (!moveToToday && !moveToFirstPriority && task.isImportant === priority.isImportant && task.isUrgent === priority.isUrgent) {
      return;
    }

    const movedDate = moveToToday ? today : moveToFirstPriority ? firstPriorityDate : null;

    if (movedDate && !task.updatedAt) {
      setError("업무의 최신 상태를 확인할 수 없어 위치를 변경하지 않았습니다. 잠시 후 다시 시도해주세요.");
      return;
    }

    try {
      if (movedDate) {
        await updateScheduleTask(task.id, unlockedProfile.uid, updateInput, {
          expectedUpdatedAt: task.updatedAt
        });
      } else {
        await updateScheduleTask(task.id, unlockedProfile.uid, updateInput);
      }
      if (movedDate) {
        enqueueGoogleCalendarTaskSync(task.id, Boolean(taskStartDate(task)));
      }
      setStatus("업무 위치를 변경했습니다.");
      setError(null);
    } catch (caught) {
      setError(scheduleActionError(caught, "업무 위치를 변경하지 못했습니다."));
    }
  }

  async function reorderTasksWithinDate(activeTaskId: string, overTaskId: string) {
    const updates = buildScheduleTaskOrderUpdates(categoryFilteredTasks, activeTaskId, overTaskId);

    if (updates == null) {
      setError("동일한 날짜 내에서만 순서를 변경할 수 있습니다.");
      return;
    }

    if (!updates.length) {
      return;
    }

    if (updates.length > 450) {
      setError("한 날짜의 일정이 너무 많아 순서를 한 번에 저장할 수 없습니다. 분류를 선택한 뒤 다시 시도해주세요.");
      return;
    }

    try {
      await updateScheduleTaskOrderBatch(unlockedProfile.uid, updates);
      setStatus("업무 순서를 저장했습니다.");
      setError(null);
    } catch (caught) {
      setError(scheduleActionError(caught, "업무 순서를 저장하지 못했습니다."));
    }
  }

  function requestTaskDeletion(task: DecryptedScheduleTask, trigger: HTMLElement) {
    if (taskDeletionPending) {
      return;
    }

    setTaskDeletionError(null);
    taskDeleteConfirmReturnFocusRef.current = trigger;
    setDeleteConfirmationTask(task);
  }

  function cancelTaskDeletion() {
    if (taskDeletionPending) {
      return;
    }

    setTaskDeletionError(null);
    setDeleteConfirmationTask(null);
  }

  async function confirmTaskDeletion() {
    const task = deleteConfirmationTask;

    if (!task || taskDeletionPending) {
      return;
    }

    setTaskDeletionPending(true);
    setTaskDeletionError(null);
    let deletedGoogleEvent = false;
    let deletionWorkflow: GoogleCalendarDeletionWorkflow | null = null;
    let localTaskDeleted = false;
    let deletionTombstone: GoogleCalendarTaskTombstone | null = null;
    let deletionTimeZone = googleCalendarConnection.timeZone || detectedGoogleCalendarTimeZone();

    try {
      let currentConnection: GoogleCalendarConnectionStatus;

      try {
        currentConnection = await refreshGoogleCalendarStatus(false, false);
      } catch (caught) {
        const message = `Google Calendar 연결 상태를 확인하지 못해 QuickMemo 일정은 유지했습니다. ${googleCalendarErrorMessage(caught)}`;

        setTaskDeletionError(message);
        setError(message);
        return;
      }

      if (currentConnection.needsReconnect) {
        const message = "Google Calendar에 남는 일정을 막기 위해 계정을 다시 연결한 뒤 삭제해주세요.";

        setTaskDeletionError(message);
        setError(message);
        return;
      }

      if (!task.updatedAt) {
        throw new Error("일정의 최신 상태를 확인할 수 없습니다. 잠시 후 다시 시도해주세요.");
      }
      deletionTombstone = await beginGoogleCalendarTaskDeletion(
        unlockedProfile.uid,
        task.id,
        task.updatedAt,
        currentConnection.connectionGeneration,
        currentConnection.serverTime ?? null
      );

      const shouldDeleteFromGoogle = currentConnection.connected && !currentConnection.needsReconnect;

      if (shouldDeleteFromGoogle) {
        try {
          if (!currentConnection.connectionGeneration) {
            throw new GoogleCalendarError(
              "connection_changed",
              "Google Calendar 연결 상태를 다시 확인해주세요."
            );
          }
          deletionWorkflow = await beginGoogleCalendarDeletionWorkflow(
            unlockedProfile.uid,
            currentConnection.connectionGeneration,
            undefined,
            currentConnection
          );
          deletionTimeZone = currentConnection.timeZone || deletionTimeZone;
          const googleTask = googleCalendarTaskFromDecrypted(task);
          const reconciliation = await reconcileGoogleCalendarTask(
            googleTask,
            deletionTimeZone,
            undefined,
            deletionWorkflow,
            currentConnection
          );
          deletedGoogleEvent = reconciliation.result.remoteWasPresent === true;
          if (reconciliation.authorityBefore !== "deleted"
            || (reconciliation.authorityAfter !== "deleted"
              && reconciliation.authorityAfter !== "undated")) {
            throw new GoogleCalendarError(
              "event_conflict",
              "삭제 중 일정이 다른 창에서 변경되었습니다. 최신 내용을 확인한 뒤 다시 시도해주세요.",
              false,
              null,
              reconciliation.result.remoteWasPresent === true
            );
          }
        } catch (caught) {
          let tombstoneCleared = false;
          let googleRestoreFailed = false;
          const remoteDeletionIsAmbiguous = caught instanceof GoogleCalendarError
            && caught.mutationMayHaveApplied;

          if (deletedGoogleEvent) {
            try {
              const latestTask = await authoritativeGoogleCalendarTask(task.id);

              if (latestTask) {
                if (latestTask.startDate) {
                  await upsertGoogleCalendarTask(
                    latestTask,
                    deletionTimeZone,
                    undefined,
                    deletionWorkflow ?? undefined
                  );
                }
                tombstoneCleared = await cancelGoogleCalendarTaskDeletion(
                  deletionTombstone.ownerUid,
                  deletionTombstone.taskId,
                  deletionTombstone.deletionAttemptId
                );
              }
            } catch {
              googleRestoreFailed = true;
            }
          } else if (!remoteDeletionIsAmbiguous) {
            tombstoneCleared = await cancelGoogleCalendarTaskDeletion(
              deletionTombstone.ownerUid,
              deletionTombstone.taskId,
              deletionTombstone.deletionAttemptId
            ).catch(() => false);
          }
          if (tombstoneCleared) {
            deletionTombstone = null;
          }
          await updateGoogleCalendarSyncFailure(caught);
          const recoveryNotice = googleRestoreFailed
            ? " Google 일정 복구를 확인하지 못해 삭제 보호 상태를 유지했습니다. 잠시 후 다시 시도해주세요."
            : remoteDeletionIsAmbiguous
              ? " Google의 삭제 결과를 확인할 수 없어 삭제 보호 상태를 유지했습니다. 연결이 복구되면 자동으로 다시 확인합니다."
              : !tombstoneCleared
                ? " 삭제 보호 상태를 정리하지 못했습니다. 잠시 후 다시 시도해주세요."
                : "";
          const message = `Google Calendar에서 일정을 먼저 삭제하지 못해 QuickMemo 일정은 유지했습니다. ${googleCalendarErrorMessage(caught)}${recoveryNotice}`;

          setTaskDeletionError(message);
          setError(message);
          return;
        }
      }

      await deleteScheduleTask(task.id);
      localTaskDeleted = true;
      setDeleteConfirmationTask(null);
      setEditingTaskId(null);
      setViewTaskId(null);
      setStatus("일정을 삭제했습니다. Google Calendar 상태를 안전하게 마무리하고 있습니다.");
      setError(null);

      const cleanupTombstone = deletionTombstone;
      const cleanupWorkflow = deletionWorkflow;
      const cleanupUiEpoch = googleCalendarUiEpochRef.current;
      const cleanupConnectionLifecycleEpoch = googleCalendarConnectionLifecycleEpochRef.current;
      const canUseCleanupLifecycle = () => googleCalendarUiEpochRef.current === cleanupUiEpoch
        && googleCalendarConnectionLifecycleEpochRef.current === cleanupConnectionLifecycleEpoch;

      // The remote-first delete, account-bound workflow renewal, and local
      // Firestore delete above remain on the critical path. Only the redundant
      // remote absence verification and durable tombstone cleanup continue in
      // the background after QuickMemo has already deleted the task.
      deletionWorkflow = null;
      setGoogleCalendarTaskSyncPendingCount((current) => current + 1);
      void (async () => {
        let googleCleanupWarning: string | null = null;
        let googleCleanupFailure: unknown = null;

        if (shouldDeleteFromGoogle) {
          try {
            await deleteGoogleCalendarTaskWithAuthorityReconciliation(
              googleCalendarTaskFromDecrypted(task),
              0,
              deletionTimeZone,
              undefined,
              0,
              undefined,
              cleanupWorkflow ?? undefined
            );
          } catch (caught) {
            googleCleanupFailure = caught;
            googleCleanupWarning = `QuickMemo 일정은 삭제했지만 Google Calendar의 삭제 상태를 다시 확인하지 못했습니다. 삭제 보호 상태를 유지하고 연결이 복구되면 다시 확인합니다. ${googleCalendarErrorMessage(caught)}`;
          }
        }
        if (cleanupTombstone && !googleCleanupWarning) {
          try {
            const tombstoneCleared = await cancelGoogleCalendarTaskDeletion(
              cleanupTombstone.ownerUid,
              cleanupTombstone.taskId,
              cleanupTombstone.deletionAttemptId
            );

            if (!tombstoneCleared) {
              const remainingTombstone = await getGoogleCalendarTaskTombstone(
                cleanupTombstone.ownerUid,
                cleanupTombstone.taskId
              );

              if (remainingTombstone?.deletionAttemptId === cleanupTombstone.deletionAttemptId) {
                googleCleanupWarning = "일정은 삭제했지만 삭제 보호 상태가 아직 남아 있습니다. 잠시 후 자동으로 다시 확인합니다.";
              } else if (remainingTombstone) {
                googleCleanupWarning = "일정은 삭제했지만 더 최신 삭제 보호 작업이 진행 중입니다. 해당 작업이 안전하게 마무리될 때까지 보호 상태를 유지합니다.";
              }
            }
          } catch (caught) {
            googleCleanupFailure = caught;
            googleCleanupWarning = "일정은 삭제했지만 삭제 보호 상태를 정리하지 못했습니다.";
          }
        }
        if (!canUseCleanupLifecycle()) {
          return;
        }
        if (googleCleanupWarning) {
          const caught = googleCleanupFailure ?? new GoogleCalendarError(
            "calendar_request_failed",
            googleCleanupWarning,
            true
          );

          void reportGoogleCalendarSyncFailure(caught);
          surfaceGoogleCalendarTaskSyncFailure(task.id, googleCleanupWarning, caught);
        } else {
          if (clearGoogleCalendarTaskSyncFailures([task.id], 1)) {
            reportGoogleCalendarSyncSuccess(1);
          }
          setStatus("일정을 삭제했습니다.");
        }
      })().finally(async () => {
        if (cleanupWorkflow) {
          await endGoogleCalendarDeletionWorkflow(cleanupWorkflow).catch(() => undefined);
        }
        if (canUseCleanupLifecycle()) {
          setGoogleCalendarTaskSyncPendingCount((current) => Math.max(0, current - 1));
        }
      });
    } catch (caught) {
      let taskStillExists = false;
      let tombstoneCleared = deletionTombstone === null;
      let googleRestoreFailed = false;

      if (!localTaskDeleted && deletionTombstone) {
        try {
          const latestTask = await getScheduleTask(task.id);

          taskStillExists = Boolean(latestTask && latestTask.ownerUid === unlockedProfile.uid);
          if (taskStillExists) {
            if (deletedGoogleEvent) {
              const latestGoogleTask = await authoritativeGoogleCalendarTask(task.id);

              if (latestGoogleTask?.startDate) {
                await upsertGoogleCalendarTask(
                  latestGoogleTask,
                  deletionTimeZone,
                  undefined,
                  deletionWorkflow ?? undefined
                );
              }
            }
            tombstoneCleared = await cancelGoogleCalendarTaskDeletion(
              deletionTombstone.ownerUid,
              deletionTombstone.taskId,
              deletionTombstone.deletionAttemptId
            );
          }
        } catch {
          tombstoneCleared = false;
          googleRestoreFailed = deletedGoogleEvent && taskStillExists;
        }
      }
      if (googleRestoreFailed) {
        await updateGoogleCalendarSyncFailure(
          new GoogleCalendarError(
            "calendar_request_failed",
            "Google Calendar 일정 복구를 확인하지 못했습니다."
          )
        );
      }
      const baseMessage = scheduleActionError(caught, "일정을 삭제하지 못했습니다.");
      const message = googleRestoreFailed
        ? `${baseMessage} Google 일정 복구를 확인하지 못해 삭제 보호 상태를 유지했습니다. 잠시 후 다시 시도해주세요.`
        : deletionTombstone && !localTaskDeleted && !tombstoneCleared
          ? `${baseMessage} 삭제 보호 상태를 정리하지 못했습니다. 같은 일정에서 삭제를 다시 시도해주세요.`
          : baseMessage;

      setTaskDeletionError(message);
      setError(message);
    } finally {
      if (deletionWorkflow) {
        await endGoogleCalendarDeletionWorkflow(deletionWorkflow).catch(() => undefined);
      }
      setTaskDeletionPending(false);
    }
  }

  function moveCalendarMonth(offset: number) {
    setCalendarCursor((current) => new Date(current.getFullYear(), current.getMonth() + offset, 1));
  }

  function refreshToday() {
    const nextToday = toLocalDateString(new Date());

    setToday(nextToday);
    return nextToday;
  }

  function goToday() {
    const nextToday = new Date();
    const nextTodayString = toLocalDateString(nextToday);

    setToday(nextTodayString);
    setCalendarCursor(new Date(nextToday.getFullYear(), nextToday.getMonth(), 1));
    setSelectedCalendarDate(nextTodayString);
  }

  function openQuickTaskDialog() {
    const currentToday = refreshToday();

    if (activeView === "matrix") {
      setCreateDialog({
        defaults: {
          category: categoryForNewTask(scheduleCategoryFilter),
          startDate: currentToday,
          endDate: currentToday,
          color: nextScheduleTaskColor(decryptedTasks),
          isImportant: true,
          isUrgent: true
        },
        title: "새 일정 추가"
      });
      return;
    }

    if (activeView === "calendar") {
      openCalendarCreateDialog(selectedCalendarDate);
      return;
    }

    setCreateDialog({
      defaults: {
        category: categoryForNewTask(scheduleCategoryFilter),
        startDate: currentToday,
        endDate: currentToday,
        color: nextScheduleTaskColor(decryptedTasks)
      },
      title: "새 일정 추가"
    });
  }

  function openScheduleTab(view: PrimaryScheduleView) {
    navigate(scheduleViewHref(view));
  }

  function selectScheduleCategoryFilter(value: ScheduleCategoryFilter) {
    if (!scheduleCategoryPreferenceResolvedRef.current) {
      scheduleCategoryTouchedBeforePreferenceRef.current = true;
    }
    setScheduleCategoryFilter(value);
  }

  function openCalendarCreateDialog(dateString: string) {
    setSelectedCalendarDate(dateString);
    setCreateDialog({
      defaults: {
        category: categoryForNewTask(scheduleCategoryFilter),
        startDate: dateString,
        endDate: dateString,
        color: nextScheduleTaskColor(decryptedTasks)
      },
      title: `${formatDateLabel(dateString)} 일정 추가`
    });
  }

  function openMatrixCreateDialog(section: MatrixSection) {
    const currentToday = refreshToday();
    const defaultDate = section.key === "firstPriority" ? addDays(currentToday, 1) : currentToday;

    setCreateDialog({
      allowPriority: false,
      defaults: {
        category: categoryForNewTask(scheduleCategoryFilter),
        startDate: defaultDate,
        endDate: defaultDate,
        color: nextScheduleTaskColor(decryptedTasks),
        isImportant: section.isImportant,
        isUrgent: section.isUrgent
      },
      title: `${section.label} 일정 추가`
    });
  }

  const googleCalendarStateLabel = googleCalendarTaskSyncPendingCount > 0 || googleCalendarOperation === "syncing"
    ? "동기화 중"
    : googleCalendarConnection.lastSyncStatus === "synced"
    ? "동기화 완료"
    : googleCalendarConnection.lastSyncStatus === "failed"
      ? "동기화 실패"
      : "미동기화";
  const searchResultCount = displayedTasks.length;

  return (
    <AppShell>
      <GoogleCalendarRecoveryWorker
        connection={googleCalendarConnection}
        onFailure={(caught, failureKeys) => {
          rememberGoogleCalendarTaskSyncFailures(
            failureKeys,
            googleCalendarErrorMessage(caught)
          );
          return updateGoogleCalendarSyncFailure(caught);
        }}
        onRecoveryStateResolved={(failureKey) => {
          const resolvedFailure = googleCalendarTaskSyncFailuresRef.current.get(failureKey);

          if (!resolvedFailure) {
            return;
          }
          googleCalendarTaskSyncFailuresRef.current.delete(failureKey);
          if (resolvedFailure.surfaced
            && clearGoogleCalendarTaskSyncFailures([], 0)) {
            reportGoogleCalendarSyncSuccess(0);
          }
        }}
        onRecoveryStateUnresolved={rememberUnresolvedGoogleCalendarRecoveryState}
        onSuccess={(syncedCount, taskIds) => {
          if (clearGoogleCalendarTaskSyncFailures(taskIds, syncedCount)) {
            reportGoogleCalendarSyncSuccess(syncedCount);
          }
        }}
        ownerUid={unlockedProfile.uid}
        paused={Boolean(googleCalendarOperation)}
        scheduleTasksLoaded={scheduleTasksLoaded}
        tasks={decryptedTasks}
      />
      <section className="schedule-workspace obsidian-schedule-pane" aria-label="일정관리 작업공간">
        <header className="schedule-header">
          <div>
            <p className="section-kicker">QUICKMEMO</p>
            <h1>{activeView ? scheduleViewTitles[activeView] : "일정관리"}</h1>
          </div>
          <label className="schedule-search-control">
            <Search size={17} aria-hidden="true" />
            <span className="sr-only">일정 검색</span>
            <input
              aria-label="일정 검색"
              onChange={(event) => setScheduleQuery(event.target.value)}
              placeholder="일정, 설명, 체크리스트 검색"
              type="search"
              value={scheduleQuery}
            />
          </label>
          <nav className="schedule-view-tabs" aria-label="일정관리 보기">
            {scheduleTabs.map(({ Icon, label, shortLabel, view }) => (
              <button
                key={view}
                aria-pressed={activeView === view}
                className={activeView === view ? "active" : ""}
                type="button"
                onClick={() => openScheduleTab(view)}
                aria-label={label}
              >
                <Icon size={18} />
                <span>{shortLabel}</span>
              </button>
            ))}
          </nav>
          <div className="schedule-header-actions">
            {scheduleQuery.trim() && (
              <span className="schedule-query-result">
                검색 결과 {searchResultCount}개
              </span>
            )}
            <button
              aria-haspopup="dialog"
              aria-label={`Google Calendar 동기화: ${googleCalendarStateLabel}`}
              className="icon-button google-calendar-trigger"
              data-sync-state={googleCalendarTaskSyncPendingCount > 0 || googleCalendarOperation === "syncing"
                ? "syncing"
                : googleCalendarConnection.lastSyncStatus}
              onClick={openGoogleCalendarDialog}
              title={`Google Calendar · ${googleCalendarStateLabel}`}
              type="button"
            >
              <CalendarSync size={17} aria-hidden="true" />
              <span className="google-calendar-trigger-status" aria-hidden="true" />
            </button>
            <button
              ref={schedulePrimaryActionRef}
              className="schedule-primary-action"
              type="button"
              onClick={(event) => {
                createDialogReturnFocusRef.current = event.currentTarget;
                openQuickTaskDialog();
              }}
            >
              <Plus size={16} />
              새 일정
            </button>
          </div>
        </header>

        {categoryViewActive && (
          <div className="schedule-category-toolbar">
            <span className="schedule-category-toolbar-label">분류</span>
            <div className="schedule-category-filter" role="group" aria-label="일정 분류">
              {scheduleCategoryFilters.map(({ label, value }) => (
                <button
                  aria-label={`${label} 일정 보기`}
                  aria-pressed={scheduleCategoryFilter === value}
                  className={scheduleCategoryFilter === value ? "active" : ""}
                  key={value}
                  onClick={() => selectScheduleCategoryFilter(value)}
                  type="button"
                >
                  {scheduleCategoryFilter === value && <Check aria-hidden="true" size={13} />}
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {(error || status) && (
          <div className={`schedule-feedback ${error ? "error" : ""}`} role="status">
            {error || status}
          </div>
        )}

        {!activeView && <p className="schedule-empty">설정한 일정 화면을 여는 중입니다.</p>}

        {activeView === "calendar" && (
          <CalendarView
            calendarTaskLayout={calendarTaskLayout}
            calendarTaskMap={calendarTaskMap}
            holidayMap={calendarHolidayMap}
            selectedDate={selectedCalendarDate}
            selectedDayTasks={selectedDayTasks}
            weeks={calendarWeeks}
            monthLabel={calendarMonthLabel(calendarCursor)}
            onAddDate={openCalendarCreateDialog}
            onMoveMonth={moveCalendarMonth}
            onOpen={setViewTaskId}
            onSelectDate={setSelectedCalendarDate}
            onToday={goToday}
            onToggle={(task) => void toggleTask(task)}
            showCategory={showTaskCategories}
          />
        )}

        {activeView === "matrix" && (
          <MatrixView
            filterQuery={scheduleQuery.trim()}
            onClearFilter={() => setScheduleQuery("")}
            sections={matrixSections}
            today={today}
            totalTaskCount={activeMatrixTaskCount}
            visibleTaskCount={visibleMatrixTaskCount}
            onAddSection={openMatrixCreateDialog}
            onMoveTaskToSection={(task, sectionKey) => void moveTaskToMatrixSection(task, sectionKey)}
            onOpen={setViewTaskId}
            onReorderTasks={(activeTaskId, overTaskId) => void reorderTasksWithinDate(activeTaskId, overTaskId)}
            onToggle={(task) => void toggleTask(task)}
            showCategory={showTaskCategories}
          />
        )}

      </section>

      {viewTask && (
        <TaskReadModal
          duplicationPending={taskDuplicationPending}
          fallbackFocusRef={schedulePrimaryActionRef}
          inactive={deleteConfirmationTask !== null}
          task={viewTask}
          onClose={() => setViewTaskId(null)}
          onDelete={(trigger) => requestTaskDeletion(viewTask, trigger)}
          onDuplicate={() => void duplicateTask(viewTask)}
          onEdit={() => {
            setEditingTaskId(viewTask.id);
            setViewTaskId(null);
          }}
          onUpdateProgress={(percent) => updateTaskProgress(viewTask, percent)}
          onUpdateDetails={(updateDetails) => updateTaskDetails(viewTask, updateDetails, "일정 상세 내용을 저장하지 못했습니다.")}
          onToggleChecklist={(itemId) => toggleTaskChecklistItem(viewTask, itemId)}
          returnFocusRef={taskModalReturnFocusRef}
        />
      )}

      {editingTask && (
        <TaskDetailModal
          key={editingTask.id}
          fallbackFocusRef={schedulePrimaryActionRef}
          inactive={deleteConfirmationTask !== null}
          task={editingTask}
          onClose={() => setEditingTaskId(null)}
          onDelete={(trigger) => requestTaskDeletion(editingTask, trigger)}
          onSave={(draft, expectedUpdatedAt) => saveTask(editingTask, draft, expectedUpdatedAt)}
          returnFocusRef={taskModalReturnFocusRef}
        />
      )}

      {deleteConfirmationTask && (
        <TaskDeleteConfirmDialog
          error={taskDeletionError}
          fallbackFocusRef={schedulePrimaryActionRef}
          pending={taskDeletionPending}
          task={deleteConfirmationTask}
          onCancel={cancelTaskDeletion}
          onConfirm={() => void confirmTaskDeletion()}
          returnFocusRef={taskDeleteConfirmReturnFocusRef}
        />
      )}

      {createDialog && (
        <ScheduleCreateDialog
          allowPriority={createDialog.allowPriority}
          defaults={createDialog.defaults}
          fallbackFocusRef={schedulePrimaryActionRef}
          title={createDialog.title}
          onClose={() => setCreateDialog(null)}
          onCreate={createTask}
          returnFocusRef={createDialogReturnFocusRef}
        />
      )}

      {googleCalendarDialogOpen && (
        <GoogleCalendarSyncDialog
          backgroundSyncPendingCount={googleCalendarTaskSyncPendingCount}
          connection={googleCalendarConnection}
          eligibleExistingCount={eligibleGoogleCalendarTasks.length}
          error={googleCalendarError}
          loading={googleCalendarLoading}
          notice={googleCalendarTaskSyncPendingCount > 0
            ? `일정 변경사항 ${googleCalendarTaskSyncPendingCount}개를 Google Calendar에 동기화하는 중입니다.`
            : googleCalendarNotice}
          operation={googleCalendarOperation}
          progress={googleCalendarProgress}
          onCancelSync={cancelGoogleCalendarSync}
          onClose={closeGoogleCalendarDialog}
          onConnect={connectGoogleCalendar}
          onDisconnect={() => void removeGoogleCalendarConnection()}
          onRefresh={() => void refreshGoogleCalendarStatus(true, true).catch(() => undefined)}
          onSyncExisting={() => void syncExistingGoogleCalendarTasks()}
        />
      )}
    </AppShell>
  );
}

function ScheduleCreateForm({
  allowPriority = true,
  autoFocus = false,
  compact = false,
  defaults,
  label,
  onCreated,
  onCreate
}: {
  allowPriority?: boolean;
  autoFocus?: boolean;
  compact?: boolean;
  defaults: QuickDefaults;
  label: string;
  onCreated?: () => void;
  onCreate: (draft: CreateTaskDraft) => Promise<boolean>;
}) {
  const titleId = useId();
  const [draft, setDraft] = useState<CreateTaskDraft>(() => createDraftFromDefaults(defaults));
  const [checklistText, setChecklistText] = useState("");
  const [isChecklistComposing, setIsChecklistComposing] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const isCreatingRef = useRef(false);
  const checklistGroups = useMemo(() => checklistDisplayGroups(draft.checklist), [draft.checklist]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isCreatingRef.current) {
      return;
    }
    const submittedDraft = normalizeScheduleTimeDraft(draft);

    if (!submittedDraft.title.trim()) {
      setLocalError("일정 제목을 입력해주세요.");
      return;
    }

    if (submittedDraft.startDate && submittedDraft.endDate && submittedDraft.endDate < submittedDraft.startDate) {
      setLocalError("종료일은 시작일보다 빠를 수 없습니다.");
      return;
    }

    if (submittedDraft.startDate && !isSafeScheduleDateRange(
      submittedDraft.startDate,
      submittedDraft.endDate || submittedDraft.startDate
    )) {
      setLocalError(scheduleDateRangeValidationMessage);
      return;
    }

    if (submittedDraft.timeMode !== "none" && !submittedDraft.startTime) {
      setLocalError("시작 시간을 입력해주세요.");
      return;
    }

    if (submittedDraft.timeMode === "range" && !submittedDraft.endTime) {
      setLocalError("종료 시간을 입력해주세요.");
      return;
    }

    if (submittedDraft.timeMode === "range"
      && submittedDraft.startTime
      && submittedDraft.endTime
      && submittedDraft.endTime < submittedDraft.startTime) {
      setLocalError("종료 시간은 시작 시간보다 빠를 수 없습니다.");
      return;
    }

    setLocalError(null);
    isCreatingRef.current = true;
    setIsCreating(true);
    let created = false;

    try {
      created = await onCreate({
        ...submittedDraft,
        endDate: submittedDraft.endDate || submittedDraft.startDate
      });
    } finally {
      isCreatingRef.current = false;
      setIsCreating(false);
    }

    if (created) {
      setDraft(createDraftFromDefaults(defaults));
      setChecklistText("");
      onCreated?.();
    }
  }

  function addChecklistItem() {
    const text = checklistText.trim();

    if (!text) {
      return;
    }

    setDraft((current) => ({
      ...current,
      checklist: [...current.checklist, { id: crypto.randomUUID(), text, checked: false }]
    }));
    setChecklistText("");
  }

  return (
    <form className={`schedule-create-form ${compact ? "compact" : ""}`} onSubmit={submit}>
      <div className="schedule-create-grid">
        <label className="schedule-create-title" htmlFor={titleId}>
          <span>{label}</span>
          <input
            autoFocus={autoFocus}
            data-dialog-initial-focus={autoFocus || undefined}
            id={titleId}
            onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
            placeholder="일정 제목"
            value={draft.title}
          />
        </label>
        <label>
          <span>분류</span>
          <AppSelect
            aria-label="일정 분류"
            onChange={(event) => setDraft((current) => ({
              ...current,
              category: event.target.value as ScheduleTaskCategory
            }))}
            value={draft.category}
          >
            <option value="work">업무</option>
            <option value="personal">개인</option>
          </AppSelect>
        </label>
        <DatePickerField
          label="시작일"
          onChange={(dateString) =>
            setDraft((current) => ({
              ...current,
              startDate: dateString,
              endDate: dateString
            }))
          }
          value={draft.startDate}
        />
        {draft.timeMode !== "point" && (
          <DatePickerField
            label="종료일"
            min={draft.startDate || undefined}
            onChange={(dateString) => setDraft((current) => ({ ...current, endDate: dateString }))}
            value={draft.endDate}
          />
        )}
        <label>
          <span>시간</span>
          <AppSelect
            onChange={(event) => {
              const nextMode = event.target.value as CreateTaskDraft["timeMode"];
              setDraft((current) => applyScheduleTimeMode(current, nextMode));
            }}
            value={draft.timeMode}
          >
            <option value="none">시간 없음</option>
            <option value="point">시각</option>
            <option value="range">시간 범위</option>
          </AppSelect>
        </label>
        {draft.timeMode !== "none" && (
          <TimePickerField
            label="시작 시간"
            onChange={(timeString) =>
              setDraft((current) => ({
                ...current,
                startTime: timeString,
                endTime:
                  current.timeMode === "range" && current.endTime && current.endTime < timeString
                    ? addMinutesToTimeInput(timeString, 60)
                    : current.endTime
              }))
            }
            value={draft.startTime}
          />
        )}
        {draft.timeMode === "range" && (
          <TimePickerField
            label="종료 시간"
            min={draft.startTime || undefined}
            onChange={(timeString) => setDraft((current) => ({ ...current, endTime: timeString }))}
            value={draft.endTime}
          />
        )}
        <ScheduleColorPicker
          value={draft.color}
          onChange={(color) => setDraft((current) => ({ ...current, color }))}
        />
      </div>
      <label className="schedule-create-details">
        <span>내용</span>
        <textarea
          onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
          placeholder="일정 내용"
          rows={3}
          value={draft.description}
        />
      </label>
      <section className="schedule-create-checklist">
        <h3>체크리스트</h3>
        {checklistGroups.length > 0 && (
          <div className="checklist-groups">
            {checklistGroups.map((group) => (
              <section className={`checklist-group ${group.key}`} key={group.key} aria-label={`${group.label} ${group.countLabel}`}>
                <div className="checklist-group-header">
                  <strong>{group.label}</strong>
                  <span>{group.countLabel}</span>
                </div>
                <div className="schedule-checklist-group-list">
                  {group.items.map((item) => (
                    <label className="schedule-checklist-item" key={item.id}>
                      <input
                        checked={item.checked}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            checklist: current.checklist.map((checkItem) =>
                              checkItem.id === item.id ? { ...checkItem, checked: event.target.checked } : checkItem
                            )
                          }))
                        }
                        type="checkbox"
                      />
                      <input
                        aria-label="체크리스트 항목"
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            checklist: current.checklist.map((checkItem) =>
                              checkItem.id === item.id ? { ...checkItem, text: event.target.value } : checkItem
                            )
                          }))
                        }
                        value={item.text}
                      />
                      <button
                        className="icon-button"
                        type="button"
                        aria-label="항목 삭제"
                        onClick={() =>
                          setDraft((current) => ({
                            ...current,
                            checklist: current.checklist.filter((checkItem) => checkItem.id !== item.id)
                          }))
                        }
                      >
                        <X size={15} />
                      </button>
                    </label>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
        <div className="schedule-checklist-add">
          <input
            onCompositionEnd={() => setIsChecklistComposing(false)}
            onCompositionStart={() => setIsChecklistComposing(true)}
            onChange={(event) => setChecklistText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                if (isChecklistComposing || isComposingKeyboardEvent(event)) {
                  return;
                }

                event.preventDefault();
                addChecklistItem();
              }
            }}
            placeholder="체크리스트 항목"
            value={checklistText}
          />
          <button className="secondary-button" type="button" onClick={addChecklistItem}>
            <Plus size={16} />
            추가
          </button>
        </div>
      </section>
      {allowPriority && (
        <div className="schedule-create-options">
          <label>
            <input
              checked={draft.isImportant}
              onChange={(event) => setDraft((current) => ({ ...current, isImportant: event.target.checked }))}
              type="checkbox"
            />
            중요
          </label>
          <label>
            <input
              checked={draft.isUrgent}
              onChange={(event) => setDraft((current) => ({ ...current, isUrgent: event.target.checked }))}
              type="checkbox"
            />
            긴급
          </label>
        </div>
      )}
      {localError && <p className="form-error" role="alert">{localError}</p>}
      <div className="schedule-create-actions">
        <button disabled={isCreating} type="submit">
          <Plus size={18} />
          <span>{isCreating ? "추가 중" : "추가"}</span>
        </button>
      </div>
    </form>
  );
}

function ScheduleCreateDialog({
  allowPriority = true,
  defaults,
  fallbackFocusRef,
  onClose,
  onCreate,
  returnFocusRef,
  title
}: {
  allowPriority?: boolean;
  defaults: QuickDefaults;
  fallbackFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onCreate: (draft: CreateTaskDraft) => Promise<boolean>;
  returnFocusRef: RefObject<HTMLElement | null>;
  title: string;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);

  useModalFocus(dialogRef, { fallbackFocusRef, returnFocusRef });

	  useEffect(() => {
	    function handleKeyDown(event: KeyboardEvent) {
	      if (event.key === "Escape" && !event.defaultPrevented) {
	        onClose();
	      }
	    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop schedule-create-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="schedule-create-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={!allowPriority ? descriptionId : undefined}
        onMouseDown={(event) => event.stopPropagation()}
        ref={dialogRef}
        tabIndex={-1}
      >
        <header>
          <div>
            <p className="section-kicker">
              <CalendarDays size={15} />
              일정 추가
            </p>
            <h2 id={titleId}>{title}</h2>
            {!allowPriority && (
              <p className="schedule-create-context-note" id={descriptionId}>
                선택한 매트릭스 영역의 중요도와 긴급도를 적용합니다.
              </p>
            )}
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="닫기">
            <X size={18} />
          </button>
        </header>
        <ScheduleCreateForm
          allowPriority={allowPriority}
          autoFocus
          defaults={defaults}
          label="새 일정"
          onCreate={onCreate}
          onCreated={onClose}
        />
      </section>
    </div>
  );
}

function consumeNestedEscape(event: ReactKeyboardEvent<HTMLElement>) {
  event.preventDefault();
  event.stopPropagation();
  event.nativeEvent.stopImmediatePropagation();
}

function DatePickerField({
  allowClear = true,
  className = "",
  label,
  min,
  onChange,
  value
}: {
  allowClear?: boolean;
  className?: string;
  label: string;
  min?: string;
  onChange: (dateString: string) => void;
  value: string;
}) {
  const todayString = toLocalDateString(new Date());
  const fieldRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [modalFocusOwner, setModalFocusOwner] = useState<string | null>(null);
  const [cursor, setCursor] = useState(() => datePickerCursor(value || min || todayString));
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties | null>(null);
  const weeks = useMemo(() => buildCalendarMonth(cursor.getFullYear(), cursor.getMonth(), todayString), [cursor, todayString]);
  const dateStrings = useMemo(
    () => weeks.flatMap((week) => week.days.map((day) => day.dateString)),
    [weeks]
  );
  const holidayMap = useKoreanHolidayMap(dateStrings);

  useEffect(() => {
    if (value) {
      setCursor(datePickerCursor(value));
    }
  }, [value]);

  useLayoutEffect(() => {
    if (!open) {
      setPopoverStyle(null);
      return;
    }

    function updatePopoverPosition() {
      const field = fieldRef.current;

      if (!field) {
        return;
      }

      const rect = field.getBoundingClientRect();
      const viewportPadding = 16;
      const width = Math.min(320, window.innerWidth - viewportPadding * 2);
      const maxHeight = Math.min(390, window.innerHeight - viewportPadding * 2);
      const clampedLeft = Math.min(
        Math.max(viewportPadding, rect.left),
        window.innerWidth - width - viewportPadding
      );
      const belowTop = rect.bottom + 8;
      const aboveTop = rect.top - maxHeight - 8;
      const fitsBelow = belowTop + maxHeight <= window.innerHeight - viewportPadding;
      const top = fitsBelow ? belowTop : Math.max(viewportPadding, aboveTop);

      setPopoverStyle({
        left: clampedLeft,
        maxHeight,
        position: "fixed",
        top,
        width
      });
    }

    updatePopoverPosition();
    window.addEventListener("resize", updatePopoverPosition);
    window.addEventListener("scroll", updatePopoverPosition, true);

    return () => {
      window.removeEventListener("resize", updatePopoverPosition);
      window.removeEventListener("scroll", updatePopoverPosition, true);
    };
  }, [cursor, min, open, value]);

  function selectDate(dateString: string) {
    if (min && dateString < min) {
      return;
    }

    onChange(dateString);
    setOpen(false);
  }

  const popover = open ? (
    <div
      className="date-picker-popover"
      data-modal-focus-owner={modalFocusOwner ?? undefined}
      data-modal-focus-portal={modalFocusOwner ? "true" : undefined}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          consumeNestedEscape(event);
          setOpen(false);
        }
      }}
      ref={popoverRef}
      style={popoverStyle ?? undefined}
    >
      <header>
        <button className="icon-button" type="button" aria-label="이전 달" onClick={() => setCursor(monthOffset(cursor, -1))}>
          <ChevronLeft size={16} />
        </button>
        <strong>{calendarMonthLabel(cursor)}</strong>
        <button className="icon-button" type="button" aria-label="다음 달" onClick={() => setCursor(monthOffset(cursor, 1))}>
          <ChevronRight size={16} />
        </button>
      </header>
      <div className="date-picker-weekdays" aria-hidden="true">
        {["일", "월", "화", "수", "목", "금", "토"].map((weekday) => (
          <span key={weekday}>{weekday}</span>
        ))}
      </div>
      <div className="date-picker-grid">
        {weeks.flatMap((week) =>
          week.days.map((day) => {
            const holidays = holidayMap[day.dateString] ?? [];
            const disabled = Boolean(min && day.dateString < min);

            return (
              <button
                aria-label={`${formatDateLabel(day.dateString)} 선택`}
                className={[
                  "date-picker-day",
                  day.inCurrentMonth ? "" : "muted",
                  day.dateString === value ? "selected" : "",
                  day.isToday ? "today" : "",
                  day.date.getDay() === 0 || holidays.length ? "holiday" : "",
                  day.date.getDay() === 6 ? "saturday" : ""
                ]
                  .filter(Boolean)
                  .join(" ")}
                disabled={disabled}
                key={day.dateString}
                onClick={() => selectDate(day.dateString)}
                title={holidays[0]?.name}
                type="button"
              >
                <span>{day.dayNumber}</span>
                {holidays[0] && <small>{holidays[0].name}</small>}
              </button>
            );
          })
        )}
      </div>
    </div>
  ) : null;

  return (
    <div
      className={`date-picker-field ${className}`.trim()}
      onBlur={(event) => {
        const nextTarget = event.relatedTarget;

        if (
          !(nextTarget instanceof Node)
          || (
            !event.currentTarget.contains(nextTarget)
            && !popoverRef.current?.contains(nextTarget)
          )
        ) {
          setOpen(false);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          consumeNestedEscape(event);
          setOpen(false);
        }
      }}
      ref={fieldRef}
    >
      <span className="date-picker-label">{label}</span>
      <div className="date-picker-shell">
        <button
          aria-expanded={open}
          className={`date-picker-trigger ${value ? "" : "empty"}`}
          onClick={() => setOpen((current) => {
            if (!current) {
              setModalFocusOwner(
                fieldRef.current?.closest<HTMLElement>("[data-modal-focus-scope]")?.dataset.modalFocusScope ?? null
              );
            }
            return !current;
          })}
          type="button"
        >
          <CalendarDays size={16} />
          <span>{value ? formatDateLabel(value) : "날짜 선택"}</span>
        </button>
        {value && allowClear && (
          <button
            aria-label={`${label} 지우기`}
            className="icon-button date-picker-clear"
            onClick={() => {
              onChange("");
              setOpen(false);
            }}
            type="button"
          >
            <X size={15} />
          </button>
        )}
        {popover && createPortal(popover, document.body)}
      </div>
    </div>
  );
}

const timePickerHours = Array.from({ length: 24 }, (_, index) => index);
const timePickerMinutes = Array.from({ length: 12 }, (_, index) => index * 5);
const timePickerPresets = ["09:00", "12:00", "15:00", "18:00", "21:00"];

function TimePickerField({
  label,
  min,
  onChange,
  value
}: {
  label: string;
  min?: string;
  onChange: (timeString: string) => void;
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const valueMinutes = timeInputToMinutes(value);
  const minMinutes = timeInputToMinutes(min ?? "");
  const fallbackMinutes = minMinutes ?? 9 * 60;
  const selectedMinutes = valueMinutes ?? fallbackMinutes;
  const selectedHour = Math.floor(selectedMinutes / 60);
  const selectedMinute = selectedMinutes % 60;
  const minuteOptions = useMemo(
    () => [...new Set([...timePickerMinutes, selectedMinute, minMinutes == null ? 0 : minMinutes % 60])].sort((left, right) => left - right),
    [minMinutes, selectedMinute]
  );
  const displayValue = valueMinutes == null ? "" : formatTaskTime(valueMinutes);

  function choose(minutes: number) {
    const nextMinutes = minMinutes != null && minutes < minMinutes ? minMinutes : minutes;
    onChange(formatTaskTime(nextMinutes));
  }

  function chooseParts(hour: number, minute: number) {
    choose(hour * 60 + minute);
  }

  return (
    <div
      className="time-picker-field"
      onBlur={(event) => {
        const nextTarget = event.relatedTarget;

        if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
          setOpen(false);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          consumeNestedEscape(event);
          setOpen(false);
        }
      }}
    >
      <span className="time-picker-label">{label}</span>
      <button
        aria-expanded={open}
        className={`time-picker-trigger ${displayValue ? "" : "empty"}`}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <Clock size={16} />
        <span>{displayValue || "시간 선택"}</span>
      </button>
      {open && (
        <div className="time-picker-popover">
          <header>
            <span>{label}</span>
            <strong>{formatTaskTime(selectedMinutes)}</strong>
          </header>
          <div className="time-picker-presets">
            {timePickerPresets.map((preset) => {
              const presetMinutes = timeInputToMinutes(preset) ?? 0;
              const disabled = minMinutes != null && presetMinutes < minMinutes;

              return (
                <button
                  className={preset === displayValue ? "selected" : ""}
                  disabled={disabled}
                  key={preset}
                  onClick={() => {
                    choose(presetMinutes);
                    setOpen(false);
                  }}
                  type="button"
                >
                  {preset}
                </button>
              );
            })}
          </div>
          <div className="time-picker-columns">
            <section>
              <span>시</span>
              <div className="time-picker-hour-grid">
                {timePickerHours.map((hour) => {
                  const disabled = minMinutes != null && hour * 60 + selectedMinute < minMinutes;

                  return (
                    <button
                      className={hour === selectedHour ? "selected" : ""}
                      disabled={disabled}
                      key={hour}
                      onClick={() => chooseParts(hour, selectedMinute)}
                      type="button"
                    >
                      {`${hour}`.padStart(2, "0")}
                    </button>
                  );
                })}
              </div>
            </section>
            <section>
              <span>분</span>
              <div className="time-picker-minute-grid">
                {minuteOptions.map((minute) => {
                  const disabled = minMinutes != null && selectedHour * 60 + minute < minMinutes;

                  return (
                    <button
                      className={minute === selectedMinute ? "selected" : ""}
                      disabled={disabled}
                      key={minute}
                      onClick={() => chooseParts(selectedHour, minute)}
                      type="button"
                    >
                      {`${minute}`.padStart(2, "0")}
                    </button>
                  );
                })}
              </div>
            </section>
          </div>
          <footer>
            <button className="secondary-button" type="button" onClick={() => setOpen(false)}>
              확인
            </button>
          </footer>
        </div>
      )}
    </div>
  );
}

function ScheduleColorPicker({ onChange, value }: { onChange: (color: string) => void; value: string }) {
  const normalizedValue = normalizeScheduleTaskColor(value);

  return (
    <label className="schedule-color-picker">
      <span>색상</span>
      <input
        aria-label="일정 색상"
        onChange={(event) => onChange(event.target.value)}
        type="color"
        value={normalizedValue}
      />
    </label>
  );
}

function CalendarView({
  calendarTaskLayout,
  calendarTaskMap,
  holidayMap,
  monthLabel,
  onAddDate,
  onMoveMonth,
  onOpen,
  onSelectDate,
  onToday,
  onToggle,
  selectedDate,
  selectedDayTasks,
  showCategory,
  weeks
}: {
  calendarTaskLayout: ReturnType<typeof buildCalendarTaskLayout>;
  calendarTaskMap: Record<string, DecryptedScheduleTask[]>;
  holidayMap: Record<string, KoreanHoliday[]>;
  monthLabel: string;
  onAddDate: (dateString: string) => void;
  onMoveMonth: (offset: number) => void;
  onOpen: (taskId: string) => void;
  onSelectDate: (dateString: string) => void;
  onToday: () => void;
  onToggle: (task: DecryptedScheduleTask) => void;
  selectedDate: string;
  selectedDayTasks: DecryptedScheduleTask[];
  showCategory: boolean;
  weeks: ReturnType<typeof buildCalendarMonth>;
}) {
  const firstVisibleDate = weeks[0]?.days[0]?.dateString ?? selectedDate;
  const selectedHolidays = holidayMap[selectedDate] ?? [];

  return (
    <div className="calendar-layout">
      <section className="calendar-panel">
        <header className="calendar-toolbar">
          <h2>{monthLabel}</h2>
          <div>
            <button className="icon-button" type="button" aria-label="이전 달" onClick={() => onMoveMonth(-1)}>
              <ChevronLeft size={18} />
            </button>
            <button className="icon-button calendar-today-button" type="button" aria-label="오늘 날짜로 이동" title="오늘 날짜로 이동" onClick={onToday}>
              <CalendarDays size={16} />
            </button>
            <button className="icon-button" type="button" aria-label="다음 달" onClick={() => onMoveMonth(1)}>
              <ChevronRight size={18} />
            </button>
          </div>
        </header>
        <div className="calendar-weekdays" aria-hidden="true">
          {["일", "월", "화", "수", "목", "금", "토"].map((weekday) => (
            <span key={weekday}>{weekday}</span>
          ))}
        </div>
        <div className="calendar-grid">
          {weeks.flatMap((week) =>
            week.days.map((day) => {
              const dayTasks = calendarTaskMap[day.dateString] ?? [];
              const dayPlacements = calendarTaskLayout[day.dateString] ?? [];
              const visiblePlacements = dayPlacements.slice(0, 4);
              const visibleTaskCount = visiblePlacements.filter(Boolean).length;
              const holidays = holidayMap[day.dateString] ?? [];
              const isHoliday = holidays.length > 0;
              const isSaturday = day.date.getDay() === 6;
              const isSunday = day.date.getDay() === 0;
              const selected = selectedDate === day.dateString;

              return (
                <button
                  key={day.dateString}
                  className={[
                    "calendar-day",
                    day.inCurrentMonth ? "" : "muted",
                    day.isToday ? "today" : "",
                    selected ? "selected" : "",
                    isSunday ? "sunday" : "",
                    isSaturday ? "saturday" : "",
                    isHoliday ? "holiday" : ""
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  type="button"
                  onClick={() => onSelectDate(day.dateString)}
                  onDoubleClick={() => onAddDate(day.dateString)}
                  aria-label={calendarDayAriaLabel(day.dateString, dayTasks, showCategory, holidays)}
                >
                  <span className="calendar-day-head">
                    <strong>{day.dayNumber}</strong>
                    {holidays[0] && <span className="calendar-holiday-label">{holidays[0].name}</span>}
                  </span>
                  <span className="calendar-task-stack">
                    {visiblePlacements.map((placement, slotIndex) => {
                      if (!placement) {
                        return <span aria-hidden="true" className="calendar-task-spacer" key={`empty-${slotIndex}`} />;
                      }

                      const { color, task } = placement;
                      const rangePosition = calendarTaskRangePosition(task, day.dateString);
                      const showLabel = shouldShowCalendarTaskLabel(task, day.dateString, firstVisibleDate);
                      const timeLabel = formatScheduleTimeRange(task);

                      return (
                        <span
                          className={[
                            "calendar-task-pill",
                            showCategory && showLabel ? "show-category" : "",
                            task.status === "completed" ? "completed" : "",
                            rangePosition,
                            day.date.getDay() === 0 ? "week-start" : "",
                            day.date.getDay() === 6 ? "week-end" : ""
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          key={task.id}
                          style={{ "--schedule-task-color": color } as CSSProperties}
                          title={`${showCategory && showLabel ? `${scheduleCategoryLabel(task.details.category)} · ` : ""}${task.title}${timeLabel ? ` · ${timeLabel}` : ""}`}
                        >
                          {showCategory && showLabel && <ScheduleCategoryBadge category={task.details.category} compact />}
                          {showLabel && (
                            <>
                              <span className="calendar-task-title">{task.title}</span>
                              {timeLabel && <span className="calendar-task-time">{timeLabel}</span>}
                            </>
                          )}
                        </span>
                      );
                    })}
                    {dayTasks.length > visibleTaskCount && <span className="calendar-more">+{dayTasks.length - visibleTaskCount}</span>}
                    {dayTasks.length > 0 && (
                      <span aria-hidden="true" className="calendar-task-count">
                        {dayTasks.length}개
                      </span>
                    )}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </section>

      <section className="calendar-agenda">
        <header>
          <h2>{formatDateLabel(selectedDate)}</h2>
          <span>{selectedDayTasks.length}</span>
        </header>
        {selectedHolidays.length > 0 && (
          <div className="calendar-agenda-holidays" aria-label="선택한 날짜의 공휴일">
            {selectedHolidays.map((holiday) => (
              <span key={holiday.name}>
                <CalendarDays size={15} />
                {holiday.name}
              </span>
            ))}
          </div>
        )}
        <button className="secondary-button calendar-agenda-add" type="button" onClick={() => onAddDate(selectedDate)}>
          <Plus size={16} />
          일정 추가
        </button>
        <PagedTaskList
          emptyMessage={selectedHolidays.length ? "등록된 일정은 없습니다." : undefined}
          tasks={selectedDayTasks}
          onOpen={onOpen}
          onToggle={onToggle}
          showCategory={showCategory}
        />
      </section>
    </div>
  );
}

function MatrixView({
  filterQuery,
  onAddSection,
  onClearFilter,
  onMoveTaskToSection,
  onOpen,
  onReorderTasks,
  onToggle,
  sections,
  showCategory,
  today,
  totalTaskCount,
  visibleTaskCount
}: {
  filterQuery: string;
  onAddSection: (section: MatrixSection) => void;
  onClearFilter: () => void;
  onMoveTaskToSection: (task: DecryptedScheduleTask, sectionKey: MatrixQuadrantKey) => void;
  onOpen: (taskId: string) => void;
  onReorderTasks: (activeTaskId: string, overTaskId: string) => void;
  onToggle: (task: DecryptedScheduleTask) => void;
  sections: MatrixSection[];
  showCategory: boolean;
  today: string;
  totalTaskCount: number;
  visibleTaskCount: number;
}) {
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const activeTask = useMemo(
    () => sections.flatMap((section) => section.tasks).find((task) => task.id === activeTaskId) ?? null,
    [activeTaskId, sections]
  );
  const todaySection = sections.find((section) => section.key === "urgentImportant") ?? null;
  const prioritySections = sections.filter((section) => section.key !== "urgentImportant");

  function toggleGroup(sectionKey: MatrixQuadrantKey, groupKey: string) {
    const stateKey = matrixGroupStateKey(sectionKey, groupKey);
    setCollapsedGroups((current) => ({ ...current, [stateKey]: !current[stateKey] }));
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveTaskId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveTaskId(null);

    if (!event.over) {
      return;
    }

    const draggedTaskId = String(event.active.id);
    const draggedTask = sections.flatMap((section) => section.tasks).find((task) => task.id === draggedTaskId);
    const overTaskId = matrixTaskIdFromDragEvent(event);
    const targetSectionKey = matrixSectionKeyFromDragEvent(event);

    if (!draggedTask) {
      return;
    }

    if (targetSectionKey && targetSectionKey !== matrixSectionKeyForTask(draggedTask, today)) {
      onMoveTaskToSection(draggedTask, targetSectionKey);
      return;
    }

    if (overTaskId && overTaskId !== draggedTaskId) {
      onReorderTasks(draggedTaskId, overTaskId);
    }
  }

  return (
    <DndContext
      collisionDetection={matrixCollisionDetection}
      onDragCancel={() => setActiveTaskId(null)}
      onDragEnd={handleDragEnd}
      onDragStart={handleDragStart}
      sensors={sensors}
    >
      {filterQuery && (
        <div className="matrix-filter-notice" role="status">
          <Search size={16} aria-hidden="true" />
          <span>
            검색어 "{filterQuery}" 적용 중 · 매트릭스 업무 {visibleTaskCount}/{totalTaskCount}개 표시
          </span>
          <button className="secondary-button" type="button" onClick={onClearFilter}>
            검색 초기화
          </button>
        </div>
      )}
      <div className="matrix-layout">
        {todaySection && (
          <div className="matrix-today-rail">
            <MatrixSectionPanel
              collapsedGroups={collapsedGroups}
              onAddSection={onAddSection}
              onOpen={onOpen}
              onToggle={onToggle}
              onToggleGroup={toggleGroup}
              section={todaySection}
              showCategory={showCategory}
              today={today}
            />
          </div>
        )}
        <div className="matrix-grid">
          {prioritySections.map((section) => (
            <MatrixSectionPanel
              collapsedGroups={collapsedGroups}
              key={section.key}
              onAddSection={onAddSection}
              onOpen={onOpen}
              onToggle={onToggle}
              onToggleGroup={toggleGroup}
              section={section}
              showCategory={showCategory}
              today={today}
            />
          ))}
        </div>
      </div>
      <DragOverlay>
        {activeTask ? (
          <div className="task-row matrix-task-row matrix-drag-overlay" aria-hidden="true">
            <span className="task-drag-handle ghost">
              <GripVertical size={16} />
            </span>
            <MatrixTaskRowContent showCategory={showCategory} task={activeTask} today={today} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function MatrixSectionPanel({
  collapsedGroups,
  onAddSection,
  onOpen,
  onToggle,
  onToggleGroup,
  section,
  showCategory,
  today
}: {
  collapsedGroups: Record<string, boolean>;
  onAddSection: (section: MatrixSection) => void;
  onOpen: (taskId: string) => void;
  onToggle: (task: DecryptedScheduleTask) => void;
  onToggleGroup: (sectionKey: MatrixQuadrantKey, groupKey: string) => void;
  section: MatrixSection;
  showCategory: boolean;
  today: string;
}) {
  const { isOver, setNodeRef } = useDroppable({
    id: matrixSectionDropId(section.key),
    data: { sectionKey: section.key, type: "matrix-section" }
  });

  return (
    <section
      className={`matrix-section ${section.accent} ${isOver ? "drag-over" : ""}`}
      key={section.key}
      ref={setNodeRef}
    >
      <header>
        <div>
          <h2>{section.label}</h2>
          <span>{section.tasks.length}</span>
        </div>
        <button
          className="icon-button matrix-add-button"
          type="button"
          aria-label={`${section.label} 일정 추가`}
          onClick={() => onAddSection(section)}
        >
          <Plus size={18} />
        </button>
      </header>
      {section.key === "urgentImportant" ? (
        <MatrixSortableTaskList
          sectionKey={section.key}
          showCategory={showCategory}
          tasks={section.tasks}
          today={today}
          onOpen={onOpen}
          onToggle={onToggle}
        />
      ) : (
        <div className="matrix-date-groups">
          {section.dateGroups.map((group) => {
            const stateKey = matrixGroupStateKey(section.key, group.key);
            const collapsed = collapsedGroups[stateKey] === true;

            return (
              <section
                className={`matrix-date-group${group.tasks.length === 0 ? " empty" : ""}`}
                key={group.key}
              >
                <button
                  className="matrix-date-group-header"
                  type="button"
                  aria-expanded={!collapsed}
                  onClick={() => onToggleGroup(section.key, group.key)}
                >
                  <span>
                    <ChevronDown size={16} aria-hidden="true" className={collapsed ? "collapsed" : ""} />
                    {group.label}
                  </span>
                  <strong>{group.tasks.length}</strong>
                </button>
                {!collapsed && (
                  <MatrixSortableTaskList
                    emptyMessage="표시할 일정이 없습니다."
                    sectionKey={section.key}
                    showCategory={showCategory}
                    tasks={group.tasks}
                    today={today}
                    onOpen={onOpen}
                    onToggle={onToggle}
                  />
                )}
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}

function MatrixSortableTaskList({
  emptyMessage = "표시할 일정이 없습니다.",
  onOpen,
  onToggle,
  sectionKey,
  showCategory,
  tasks,
  today
}: {
  emptyMessage?: string;
  onOpen: (taskId: string) => void;
  onToggle: (task: DecryptedScheduleTask) => void;
  sectionKey: MatrixQuadrantKey;
  showCategory: boolean;
  tasks: DecryptedScheduleTask[];
  today: string;
}) {
  if (!tasks.length) {
    return <p className="schedule-empty">{emptyMessage}</p>;
  }

  return (
    <SortableContext items={tasks.map((task) => task.id)} strategy={verticalListSortingStrategy}>
      <div className="task-list matrix-task-list">
        {tasks.map((task) => (
          <SortableMatrixTaskRow
            key={task.id}
            sectionKey={sectionKey}
            showCategory={showCategory}
            task={task}
            today={today}
            onOpen={onOpen}
            onToggle={onToggle}
          />
        ))}
      </div>
    </SortableContext>
  );
}

function SortableMatrixTaskRow({
  onOpen,
  onToggle,
  sectionKey,
  showCategory,
  task,
  today
}: {
  onOpen: (taskId: string) => void;
  onToggle: (task: DecryptedScheduleTask) => void;
  sectionKey: MatrixQuadrantKey;
  showCategory: boolean;
  task: DecryptedScheduleTask;
  today: string;
}) {
  const {
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition
  } = useSortable({
    id: task.id,
    data: { sectionKey, taskId: task.id, type: "matrix-task" }
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition
  };

  return (
    <div
      className={`task-row matrix-task-row ${task.status === "completed" ? "completed" : ""} ${isDragging ? "dragging" : ""}`}
      ref={setNodeRef}
      style={style}
    >
      <button
        className="task-drag-handle"
        type="button"
        aria-label={`${task.title} 드래그 이동`}
        ref={setActivatorNodeRef}
        style={{ touchAction: "none" }}
        title="드래그 이동"
        {...attributes}
        {...listeners}
      >
        <GripVertical size={16} />
      </button>
      <MatrixTaskRowContent
        onOpen={onOpen}
        onToggle={onToggle}
        showCategory={showCategory}
        task={task}
        today={today}
      />
    </div>
  );
}

function MatrixTaskRowContent({
  onOpen,
  onToggle,
  showCategory = true,
  task,
  today
}: {
  onOpen?: (taskId: string) => void;
  onToggle?: (task: DecryptedScheduleTask) => void;
  showCategory?: boolean;
  task: DecryptedScheduleTask;
  today: string;
}) {
  const progressPercent = normalizeTaskProgressPercent(task.progressPercent);
  const progressStyle = {
    "--matrix-task-progress-color": taskProgressColor(progressPercent),
    "--matrix-task-progress-fill": `${progressPercent}%`
  } as CSSProperties;
  const isOverdue = isTaskScheduleOverdue(task, today);

  return (
    <>
      <button
        className="task-check"
        type="button"
        role="checkbox"
        aria-checked={task.status === "completed"}
        aria-label={task.status === "completed" ? "일정 완료 해제" : "일정 완료"}
        onClick={() => onToggle?.(task)}
      >
        {task.status === "completed" ? <CheckCircle2 size={18} /> : null}
      </button>
      <button className="task-main task-open-button" type="button" onClick={() => onOpen?.(task.id)}>
        <strong>{task.title}</strong>
        {showCategory && <ScheduleCategoryBadge category={task.details.category} />}
        <span className={isOverdue ? "task-meta overdue" : "task-meta"}>{formatTaskMeta(task)}</span>
        <span
          aria-label={`${task.title} 진행률 ${progressPercent}%`}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={progressPercent}
          className="matrix-task-progress-strip"
          role="progressbar"
          style={progressStyle}
        />
      </button>
      <span className="task-flags">
        {task.isImportant && <Flag size={15} aria-label="중요" />}
        {task.isUrgent && <Clock size={15} aria-label="긴급" />}
      </span>
    </>
  );
}

const matrixCollisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);

  if (pointerCollisions.length > 0) {
    const taskCollisions = pointerCollisions.filter((collision) => collisionType(collision) === "matrix-task");

    if (taskCollisions.length > 0) {
      return taskCollisions;
    }

    const sectionCollisions = pointerCollisions.filter((collision) => collisionType(collision) === "matrix-section");

    if (sectionCollisions.length > 0) {
      return sectionCollisions;
    }

    return pointerCollisions;
  }

  const rectangleCollisions = rectIntersection(args);
  const taskCollisions = rectangleCollisions.filter((collision) => collisionType(collision) === "matrix-task");

  if (taskCollisions.length > 0) {
    return taskCollisions;
  }

  const sectionCollisions = rectangleCollisions.filter((collision) => collisionType(collision) === "matrix-section");

  return sectionCollisions.length > 0 ? sectionCollisions : rectangleCollisions;
};

function collisionType(collision: ReturnType<CollisionDetection>[number]) {
  return collision.data?.droppableContainer.data.current?.type;
}

function matrixSectionDropId(sectionKey: MatrixQuadrantKey) {
  return `matrix-section:${sectionKey}`;
}

function matrixGroupStateKey(sectionKey: MatrixQuadrantKey, groupKey: string) {
  return `${sectionKey}:${groupKey}`;
}

function matrixSectionKeyFromDragEvent(event: DragEndEvent): MatrixQuadrantKey | null {
  const sectionKey = event.over?.data.current?.sectionKey;

  return isMatrixQuadrantKey(sectionKey) ? sectionKey : null;
}

function matrixTaskIdFromDragEvent(event: DragEndEvent) {
  return event.over?.data.current?.type === "matrix-task" ? String(event.over.id) : null;
}

function matrixSectionKeyForTask(
  task: Pick<DecryptedScheduleTask, "dueDate" | "endDate" | "isImportant" | "isUrgent" | "startDate">,
  today: string
): MatrixQuadrantKey {
  if (isTaskDateRangeOverdue(task, today)) {
    return "urgentImportant";
  }

  if (task.isImportant && task.isUrgent) {
    return taskDateRangeContains(task, today) ? "urgentImportant" : "firstPriority";
  }

  if (!task.isImportant && task.isUrgent) {
    return "urgentNotImportant";
  }

  if (task.isImportant && !task.isUrgent) {
    return "importantNotUrgent";
  }

  return "notUrgentNotImportant";
}

function taskDateRangeContains(
  task: Pick<DecryptedScheduleTask, "dueDate" | "endDate" | "startDate">,
  dateString: string
) {
  const startDate = taskStartDate(task);

  if (!isValidScheduleDateString(startDate)) {
    return false;
  }

  return startDate <= dateString && dateString <= taskSafeEndDate(task, startDate);
}

function isTaskDateRangeOverdue(
  task: Pick<DecryptedScheduleTask, "dueDate" | "endDate" | "startDate">,
  today: string
) {
  const startDate = taskStartDate(task);

  if (!isValidScheduleDateString(startDate)) {
    return false;
  }

  return taskSafeEndDate(task, startDate) < today;
}

function taskSafeEndDate(task: Pick<DecryptedScheduleTask, "dueDate" | "endDate" | "startDate">, startDate: string) {
  const endDate = taskEndDate(task);

  return isValidScheduleDateString(endDate) && endDate >= startDate ? endDate : startDate;
}

function isMatrixQuadrantKey(value: unknown): value is MatrixQuadrantKey {
  return (
    value === "urgentImportant"
    || value === "firstPriority"
    || value === "urgentNotImportant"
    || value === "importantNotUrgent"
    || value === "notUrgentNotImportant"
  );
}

function normalizeTaskProgressPercent(value: number | null | undefined) {
  const nextValue = Number(value);

  if (!Number.isFinite(nextValue)) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(nextValue / 10) * 10));
}

function taskProgressStatusLabel(percent: number) {
  if (percent >= 100) {
    return "완료";
  }

  if (percent >= 70) {
    return "마무리";
  }

  if (percent >= 40) {
    return "진행 중";
  }

  if (percent > 0) {
    return "시작";
  }

  return "대기";
}

function taskProgressColor(percent: number) {
  if (percent >= 100) {
    return "var(--teal)";
  }

  if (percent >= 70) {
    return "var(--blue)";
  }

  if (percent >= 40) {
    return "var(--gold)";
  }

  if (percent > 0) {
    return "var(--coral)";
  }

  return "#a7b0a9";
}

function PagedTaskList({
  emptyMessage,
  getMeta,
  onOpen,
  onToggle,
  pageSize = taskPageSize,
  showCategory = true,
  showProgress = false,
  strikeCompleted = true,
  today = toLocalDateString(new Date()),
  tasks
}: {
  emptyMessage?: string;
  getMeta?: (task: DecryptedScheduleTask) => string;
  onOpen: (taskId: string) => void;
  onToggle: (task: DecryptedScheduleTask) => void;
  pageSize?: number;
  showCategory?: boolean;
  showProgress?: boolean;
  strikeCompleted?: boolean;
  today?: string;
  tasks: DecryptedScheduleTask[];
}) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(tasks.length / pageSize));
  const taskPageKey = tasks.map((task) => task.id).join("|");

  useEffect(() => {
    setPage(0);
  }, [pageSize, taskPageKey]);

  useEffect(() => {
    setPage((current) => Math.min(current, pageCount - 1));
  }, [pageCount]);

  const visibleTasks = tasks.slice(page * pageSize, page * pageSize + pageSize);

  return (
    <div className="task-paged-list">
      <TaskList
        emptyMessage={emptyMessage}
        getMeta={getMeta}
        tasks={visibleTasks}
        onOpen={onOpen}
        onToggle={onToggle}
        showCategory={showCategory}
        showProgress={showProgress}
        strikeCompleted={strikeCompleted}
        today={today}
      />
      {tasks.length > pageSize && (
        <div className="task-pager" aria-label="일정 페이지 이동">
          <button
            className="icon-button"
            type="button"
            aria-label="이전 일정"
            disabled={page === 0}
            onClick={() => setPage((current) => Math.max(0, current - 1))}
          >
            <ChevronLeft size={16} />
          </button>
          <span>
            {page + 1} / {pageCount}
          </span>
          <button
            className="icon-button"
            type="button"
            aria-label="다음 일정"
            disabled={page >= pageCount - 1}
            onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

function TaskList({
  emptyMessage = "표시할 일정이 없습니다.",
  getMeta,
  tasks,
  onOpen,
  onToggle,
  showCategory = true,
  showProgress = false,
  strikeCompleted = true,
  today = toLocalDateString(new Date())
}: {
  emptyMessage?: string;
  getMeta?: (task: DecryptedScheduleTask) => string;
  tasks: DecryptedScheduleTask[];
  onOpen: (taskId: string) => void;
  onToggle: (task: DecryptedScheduleTask) => void;
  showCategory?: boolean;
  showProgress?: boolean;
  strikeCompleted?: boolean;
  today?: string;
}) {
  if (!tasks.length) {
    return <p className="schedule-empty">{emptyMessage}</p>;
  }

  return (
    <div className="task-list">
      {tasks.map((task) => (
        <TaskListRow
          getMeta={getMeta}
          key={task.id}
          onOpen={onOpen}
          onToggle={onToggle}
          showCategory={showCategory}
          showProgress={showProgress}
          strikeCompleted={strikeCompleted}
          task={task}
          today={today}
        />
      ))}
    </div>
  );
}

function TaskListRow({
  getMeta,
  onOpen,
  onToggle,
  showCategory,
  showProgress,
  strikeCompleted,
  task,
  today
}: {
  getMeta?: (task: DecryptedScheduleTask) => string;
  onOpen: (taskId: string) => void;
  onToggle: (task: DecryptedScheduleTask) => void;
  showCategory: boolean;
  showProgress: boolean;
  strikeCompleted: boolean;
  task: DecryptedScheduleTask;
  today: string;
}) {
  const progressPercent = normalizeTaskProgressPercent(task.progressPercent);

  return (
    <div className={`task-row ${strikeCompleted && task.status === "completed" ? "completed" : ""}`}>
      <button
        className="task-check"
        type="button"
        role="checkbox"
        aria-checked={task.status === "completed"}
        aria-label={task.status === "completed" ? "일정 완료 해제" : "일정 완료"}
        onClick={() => onToggle(task)}
      >
        {task.status === "completed" ? <CheckCircle2 size={18} /> : null}
      </button>
      <button className="task-main task-open-button" type="button" onClick={() => onOpen(task.id)}>
        <strong>{task.title}</strong>
        {showCategory && <ScheduleCategoryBadge category={task.details.category} />}
        <span className={isTaskScheduleOverdue(task, today) ? "task-meta overdue" : "task-meta"}>
          {getMeta ? getMeta(task) : formatTaskMeta(task)}
        </span>
        {showProgress && (
          <span
            aria-label={`${task.title} 진행률 ${progressPercent}%`}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={progressPercent}
            className="task-progress-strip"
            role="progressbar"
            style={
              {
                "--task-list-progress-color": taskProgressColor(progressPercent),
                "--task-list-progress-fill": `${progressPercent}%`
              } as CSSProperties
            }
          />
        )}
      </button>
      <span className="task-flags">
        {task.isImportant && <Flag size={15} aria-label="중요" />}
        {task.isUrgent && <Clock size={15} aria-label="긴급" />}
      </span>
    </div>
  );
}

function ScheduleCategoryBadge({
  category,
  compact = false
}: {
  category: ScheduleTaskCategory;
  compact?: boolean;
}) {
  const label = scheduleCategoryLabel(category);
  const Icon = category === "personal" ? UserRound : BriefcaseBusiness;

  return (
    <span
      aria-label={`분류 ${label}`}
      className={`schedule-category-badge ${category} ${compact ? "compact" : ""}`}
      title={label}
    >
      {!compact && <Icon aria-hidden="true" size={12} />}
      <span aria-hidden="true">{label}</span>
    </span>
  );
}

function TaskProgressControl({
  disabled = false,
  helperText,
  onChange,
  percent,
  title = "진행률"
}: {
  disabled?: boolean;
  helperText?: string;
  onChange: (percent: number) => void;
  percent: number;
  title?: string;
}) {
  const normalizedPercent = normalizeTaskProgressPercent(percent);
  const color = taskProgressColor(normalizedPercent);
  const statusLabel = helperText ?? taskProgressStatusLabel(normalizedPercent);

  return (
    <section
      className="task-progress"
      aria-label={`${title} ${normalizedPercent}%`}
      style={{ "--task-progress-color": color } as CSSProperties}
    >
      <div className="task-progress-header">
        <div>
          <span>{title}</span>
          <strong>{normalizedPercent}%</strong>
        </div>
        <span className="task-progress-note">{statusLabel}</span>
      </div>
      <label className="task-progress-slider">
        <span className="task-progress-slider-head">
          <span>0</span>
          <span>50</span>
          <span>100</span>
        </span>
        <span className="task-progress-range">
          <span className="sr-only">{title} 선택</span>
          <input
            aria-label={`${title} 선택`}
            disabled={disabled}
            max="100"
            min="0"
            onChange={(event) => onChange(Number(event.target.value))}
            step="10"
            style={{ "--task-progress-fill": `${normalizedPercent}%` } as CSSProperties}
            type="range"
            value={normalizedPercent}
          />
        </span>
      </label>
    </section>
  );
}

function TaskDeleteConfirmDialog({
  error,
  fallbackFocusRef,
  onCancel,
  onConfirm,
  pending,
  returnFocusRef,
  task
}: {
  error: string | null;
  fallbackFocusRef: RefObject<HTMLElement | null>;
  onCancel: () => void;
  onConfirm: () => void;
  pending: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
  task: DecryptedScheduleTask;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const targetId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const displayTitle = task.title.trim() || "제목 없는 일정";

  useModalFocus(dialogRef, { fallbackFocusRef, returnFocusRef });

  function handleKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();

      if (!pending) {
        onCancel();
      }
      return;
    }

  }

  return createPortal(
    <div
      className="modal-backdrop schedule-delete-confirm-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        event.stopPropagation();

        if (event.target === event.currentTarget && !pending) {
          onCancel();
        }
      }}
    >
      <section
        aria-busy={pending}
        aria-describedby={`${descriptionId} ${targetId}`}
        aria-labelledby={titleId}
        aria-modal="true"
        className="schedule-delete-confirm-modal"
        ref={dialogRef}
        role="alertdialog"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="schedule-delete-confirm-header">
          <span className="schedule-delete-confirm-icon" aria-hidden="true">
            <Trash2 size={21} strokeWidth={2.2} />
          </span>
          <div>
            <p className="schedule-delete-confirm-kicker">삭제 확인</p>
            <h2 id={titleId}>이 일정을 삭제할까요?</h2>
          </div>
          <button
            aria-label="삭제 확인 닫기"
            className="icon-button schedule-delete-confirm-close"
            disabled={pending}
            type="button"
            onClick={onCancel}
          >
            <X size={18} />
          </button>
        </header>

        <p className="schedule-delete-confirm-description" id={descriptionId}>
          삭제한 일정과 체크리스트는 복구할 수 없습니다.
        </p>

        <div className="schedule-delete-confirm-target" id={targetId}>
          <CalendarDays aria-hidden="true" size={18} />
          <div>
            <span>삭제할 일정</span>
            <strong>{displayTitle}</strong>
          </div>
        </div>

        {error && (
          <p className="schedule-delete-confirm-error" role="alert">
            {error}
          </p>
        )}

        <footer className="schedule-delete-confirm-actions">
          <button
            className="secondary-button"
            data-dialog-initial-focus
            disabled={pending}
            type="button"
            onClick={onCancel}
          >
            취소
          </button>
          <button
            className="schedule-delete-confirm-submit"
            disabled={pending}
            type="button"
            onClick={onConfirm}
          >
            {pending ? <LoaderCircle aria-hidden="true" className="spin" size={18} /> : <Trash2 aria-hidden="true" size={18} />}
            {pending ? "삭제하는 중" : "일정 삭제"}
          </button>
        </footer>
      </section>
    </div>,
    document.body
  );
}

function TaskReadModal({
  duplicationPending,
  fallbackFocusRef,
  inactive,
  onClose,
  onDelete,
  onDuplicate,
  onEdit,
  onToggleChecklist,
  onUpdateDetails,
  onUpdateProgress,
  returnFocusRef,
  task
}: {
  duplicationPending: boolean;
  fallbackFocusRef: RefObject<HTMLElement | null>;
  inactive: boolean;
  onClose: () => void;
  onDelete: (trigger: HTMLElement) => void;
  onDuplicate: () => void;
  onEdit: () => void;
  onToggleChecklist: (itemId: string) => void | Promise<void>;
  onUpdateDetails: (updateDetails: TaskDetailsUpdater) => boolean | Promise<boolean>;
  onUpdateProgress: (percent: number) => void | Promise<void>;
  returnFocusRef: RefObject<HTMLElement | null>;
  task: DecryptedScheduleTask;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const details = task.details ?? emptyScheduleDetails;
  const hasChecklist = details.checklist.length > 0;
  const checklistGroups = checklistDisplayGroups(details.checklist);
  const [isDescriptionEditing, setIsDescriptionEditing] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState(details.description);
  const [progressPercent, setProgressPercent] = useState(() => normalizeTaskProgressPercent(task.progressPercent));
  const [pendingProgress, setPendingProgress] = useState(false);
  const [pendingDetailsAction, setPendingDetailsAction] = useState<string | null>(null);
  const [isAddingChecklist, setIsAddingChecklist] = useState(false);
  const [newChecklistText, setNewChecklistText] = useState("");
  const [editingChecklistItemId, setEditingChecklistItemId] = useState<string | null>(null);
  const [checklistEditText, setChecklistEditText] = useState("");
  const [isChecklistComposing, setIsChecklistComposing] = useState(false);
  const [pendingChecklistItemId, setPendingChecklistItemId] = useState<string | null>(null);
  const detailsMutationPending = pendingDetailsAction !== null || pendingChecklistItemId !== null;

  useModalFocus(dialogRef, { enabled: !inactive, fallbackFocusRef, returnFocusRef });

  useEffect(() => {
    setProgressPercent(normalizeTaskProgressPercent(task.progressPercent));
  }, [task.id, task.progressPercent]);

  useEffect(() => {
    if (!isDescriptionEditing) {
      setDescriptionDraft(details.description);
    }
  }, [details.description, isDescriptionEditing, task.id]);

  useEffect(() => {
    setEditingChecklistItemId(null);
    setChecklistEditText("");
    setIsAddingChecklist(false);
    setNewChecklistText("");
  }, [task.id]);

  async function changeProgress(percent: number) {
    const nextPercent = normalizeTaskProgressPercent(percent);

    setProgressPercent(nextPercent);
    setPendingProgress(true);

    try {
      await onUpdateProgress(nextPercent);
    } finally {
      setPendingProgress(false);
    }
  }

  async function saveInlineDetails(updateDetails: TaskDetailsUpdater, actionId: string) {
    setPendingDetailsAction(actionId);

    try {
      return await onUpdateDetails(updateDetails);
    } finally {
      setPendingDetailsAction(null);
    }
  }

  async function saveDescription() {
    const didSave = await saveInlineDetails(
      (currentDetails) => ({
        category: currentDetails.category,
        description: descriptionDraft,
        checklist: currentDetails.checklist
      }),
      "description"
    );

    if (didSave) {
      setIsDescriptionEditing(false);
    }
  }

  async function addChecklistItem() {
    const text = newChecklistText.trim();

    if (!text) {
      return;
    }

    const didSave = await saveInlineDetails(
      (currentDetails) => ({
        category: currentDetails.category,
        description: currentDetails.description,
        checklist: [...currentDetails.checklist, { id: crypto.randomUUID(), text, checked: false }]
      }),
      "checklist:add"
    );

    if (didSave) {
      setNewChecklistText("");
      setIsAddingChecklist(false);
    }
  }

  function startEditingChecklistItem(item: ScheduleChecklistItem) {
    setEditingChecklistItemId(item.id);
    setChecklistEditText(item.text);
  }

  async function saveChecklistItemText(itemId: string) {
    const text = checklistEditText.trim();

    if (!text) {
      return;
    }

    const didSave = await saveInlineDetails(
      (currentDetails) => ({
        category: currentDetails.category,
        description: currentDetails.description,
        checklist: currentDetails.checklist.map((item) => (item.id === itemId ? { ...item, text } : item))
      }),
      `checklist:edit:${itemId}`
    );

    if (didSave) {
      setEditingChecklistItemId(null);
      setChecklistEditText("");
    }
  }

  async function deleteChecklistItem(itemId: string) {
    const didSave = await saveInlineDetails(
      (currentDetails) => ({
        category: currentDetails.category,
        description: currentDetails.description,
        checklist: currentDetails.checklist.filter((item) => item.id !== itemId)
      }),
      `checklist:delete:${itemId}`
    );

    if (didSave && editingChecklistItemId === itemId) {
      setEditingChecklistItemId(null);
      setChecklistEditText("");
    }
  }

  async function toggleChecklistItem(itemId: string) {
    setPendingChecklistItemId(itemId);

    try {
      await onToggleChecklist(itemId);
    } finally {
      setPendingChecklistItemId(null);
    }
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !inactive) {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [inactive, onClose]);

  return (
    <div
      aria-hidden={inactive || undefined}
      className="modal-backdrop schedule-detail-backdrop"
      inert={inactive}
      role="presentation"
      onMouseDown={inactive ? undefined : onClose}
    >
      <section
        className="schedule-read-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="schedule-read-title"
        onMouseDown={(event) => event.stopPropagation()}
        ref={dialogRef}
        tabIndex={-1}
      >
        <header>
          <div>
            <p className="section-kicker">
              <CalendarDays size={15} />
              일정
            </p>
            <h2 id="schedule-read-title">{task.title}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="닫기">
            <X size={18} />
          </button>
        </header>

        <div className="task-read-meta">
          <ScheduleCategoryBadge category={task.details.category} />
          <span>{formatTaskDateDisplay(task)}</span>
          {formatScheduleTimeRange(task) && <span>{formatScheduleTimeRange(task)}</span>}
          {task.status === "completed" && <span>완료</span>}
          {task.isImportant && <span>중요</span>}
          {task.isUrgent && <span>긴급</span>}
        </div>

        <TaskProgressControl
          helperText={pendingProgress ? "저장 중" : undefined}
          onChange={(percent) => void changeProgress(percent)}
          percent={progressPercent}
        />

        <section className="task-read-section">
          <div className="task-read-section-head">
            <h3>내용</h3>
            {isDescriptionEditing ? (
              <div className="task-read-inline-actions">
                <button
                  className="icon-button task-read-icon-button"
                  type="button"
                  aria-label="내용 저장"
                  disabled={detailsMutationPending}
                  onClick={() => void saveDescription()}
                >
                  <Save size={15} />
                </button>
                <button
                  className="icon-button task-read-icon-button"
                  type="button"
                  aria-label="내용 수정 취소"
                  disabled={detailsMutationPending}
                  onClick={() => {
                    setDescriptionDraft(details.description);
                    setIsDescriptionEditing(false);
                  }}
                >
                  <X size={15} />
                </button>
              </div>
            ) : (
              <button
                className="icon-button task-read-icon-button"
                type="button"
                aria-label="내용 수정"
                disabled={detailsMutationPending}
                onClick={() => setIsDescriptionEditing(true)}
              >
                <Pencil size={15} />
              </button>
            )}
          </div>
          {isDescriptionEditing ? (
            <textarea
              className="task-read-inline-textarea"
              onChange={(event) => setDescriptionDraft(event.target.value)}
              rows={5}
              value={descriptionDraft}
            />
          ) : (
            <p>{details.description.trim() || "내용이 없습니다."}</p>
          )}
        </section>

        <section className="task-read-section">
          <div className="task-read-section-head">
            <h3>체크리스트</h3>
            <button
              className="icon-button task-read-icon-button"
              type="button"
              aria-label="체크리스트 추가"
              disabled={detailsMutationPending}
              onClick={() => setIsAddingChecklist(true)}
            >
              <Plus size={15} />
            </button>
          </div>
          {isAddingChecklist && (
            <div className="task-read-checklist-add">
              <input
                autoFocus
                aria-label="새 체크리스트 항목"
                disabled={detailsMutationPending}
                onCompositionEnd={() => setIsChecklistComposing(false)}
                onCompositionStart={() => setIsChecklistComposing(true)}
                onChange={(event) => setNewChecklistText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") {
                    return;
                  }

                  if (isChecklistComposing || isComposingKeyboardEvent(event)) {
                    return;
                  }

                  event.preventDefault();
                  void addChecklistItem();
                }}
                value={newChecklistText}
              />
              <div className="task-read-inline-actions">
                <button
                  className="icon-button task-read-icon-button"
                  type="button"
                  aria-label="체크리스트 저장"
                  disabled={detailsMutationPending}
                  onClick={() => void addChecklistItem()}
                >
                  <Save size={15} />
                </button>
                <button
                  className="icon-button task-read-icon-button"
                  type="button"
                  aria-label="체크리스트 추가 취소"
                  disabled={detailsMutationPending}
                  onClick={() => {
                    setNewChecklistText("");
                    setIsAddingChecklist(false);
                  }}
                >
                  <X size={15} />
                </button>
              </div>
            </div>
          )}
          {hasChecklist ? (
            <div className="task-read-checklist-groups">
              {checklistGroups.map((group) => (
                <section className={`checklist-group ${group.key}`} key={group.key} aria-label={`${group.label} ${group.countLabel}`}>
                  <div className="checklist-group-header">
                    <strong>{group.label}</strong>
                    <span>{group.countLabel}</span>
                  </div>
                  <ul className="task-read-checklist">
                    {group.items.map((item) => (
                      <li key={item.id} className={item.checked ? "checked" : ""}>
                        <button
                          aria-checked={item.checked}
                          aria-label={item.checked ? `${item.text} 완료 해제` : `${item.text} 완료`}
                          className={`task-read-check-button ${item.checked ? "checked" : ""}`}
                          disabled={detailsMutationPending}
                          onClick={() => void toggleChecklistItem(item.id)}
                          role="checkbox"
                          type="button"
                        >
                          {item.checked ? <CheckCircle2 size={16} /> : null}
                        </button>
                        {editingChecklistItemId === item.id ? (
                          <>
                            <input
                              autoFocus
                              aria-label="체크리스트 항목 수정"
                              className="task-read-checklist-input"
                              disabled={detailsMutationPending}
                              onCompositionEnd={() => setIsChecklistComposing(false)}
                              onCompositionStart={() => setIsChecklistComposing(true)}
                              onChange={(event) => setChecklistEditText(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key !== "Enter") {
                                  return;
                                }

                                if (isChecklistComposing || isComposingKeyboardEvent(event)) {
                                  return;
                                }

                                event.preventDefault();
                                void saveChecklistItemText(item.id);
                              }}
                              value={checklistEditText}
                            />
                            <div className="task-read-inline-actions">
                              <button
                                className="icon-button task-read-icon-button"
                                type="button"
                                aria-label={`${item.text} 저장`}
                                disabled={detailsMutationPending}
                                onClick={() => void saveChecklistItemText(item.id)}
                              >
                                <Save size={15} />
                              </button>
                              <button
                                className="icon-button task-read-icon-button"
                                type="button"
                                aria-label={`${item.text} 수정 취소`}
                                disabled={detailsMutationPending}
                                onClick={() => {
                                  setEditingChecklistItemId(null);
                                  setChecklistEditText("");
                                }}
                              >
                                <X size={15} />
                              </button>
                            </div>
                          </>
                        ) : (
                          <>
                            <span>{item.text}</span>
                            <div className="task-read-inline-actions">
                              <button
                                className="icon-button task-read-icon-button"
                                type="button"
                                aria-label={`${item.text} 수정`}
                                disabled={detailsMutationPending}
                                onClick={() => startEditingChecklistItem(item)}
                              >
                                <Pencil size={15} />
                              </button>
                              <button
                                className="icon-button task-read-icon-button danger"
                                type="button"
                                aria-label={`${item.text} 삭제`}
                                disabled={detailsMutationPending}
                                onClick={() => void deleteChecklistItem(item.id)}
                              >
                                <Minus size={15} />
                              </button>
                            </div>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          ) : !isAddingChecklist ? (
            <p>체크리스트가 없습니다.</p>
          ) : null}
        </section>

        <footer className="task-read-actions">
          <button className="danger-button" type="button" onClick={(event) => onDelete(event.currentTarget)}>
            <Trash2 size={17} />
            삭제
          </button>
          <div>
            <button
              className="secondary-button"
              disabled={detailsMutationPending || duplicationPending}
              type="button"
              onClick={onDuplicate}
            >
              {duplicationPending ? <LoaderCircle aria-hidden="true" className="spin" size={17} /> : <Copy size={17} />}
              {duplicationPending ? "복사 중" : "복사"}
            </button>
            <button disabled={detailsMutationPending} type="button" onClick={onEdit}>
              <Pencil size={17} />
              수정
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function TaskDetailModal({
  fallbackFocusRef,
  inactive,
  onClose,
  onDelete,
  onSave,
  returnFocusRef,
  task
}: {
  fallbackFocusRef: RefObject<HTMLElement | null>;
  inactive: boolean;
  onClose: () => void;
  onDelete: (trigger: HTMLElement) => void;
  onSave: (
    draft: TaskDraft,
    expectedUpdatedAt: DecryptedScheduleTask["updatedAt"]
  ) => Promise<string | null>;
  returnFocusRef: RefObject<HTMLElement | null>;
  task: DecryptedScheduleTask;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const [draft, setDraft] = useState<TaskDraft>(() => draftFromTask(task));
  const draftBaselineUpdatedAtRef = useRef(task.updatedAt);
  const [checklistText, setChecklistText] = useState("");
  const [isChecklistComposing, setIsChecklistComposing] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const isSavingRef = useRef(false);
  const checklistGroups = useMemo(() => checklistDisplayGroups(draft.checklist), [draft.checklist]);

  useModalFocus(dialogRef, { enabled: !inactive, fallbackFocusRef, returnFocusRef });

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !inactive && !isSavingRef.current) {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [inactive, onClose]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSavingRef.current) {
      return;
    }
    const submittedDraft = normalizeScheduleTimeDraft(draft);

    if (submittedDraft.startDate && submittedDraft.endDate && submittedDraft.endDate < submittedDraft.startDate) {
      setLocalError("종료일은 시작일보다 빠를 수 없습니다.");
      return;
    }

    if (submittedDraft.startDate && !isSafeScheduleDateRange(
      submittedDraft.startDate,
      submittedDraft.endDate || submittedDraft.startDate
    )) {
      setLocalError(scheduleDateRangeValidationMessage);
      return;
    }

    if (submittedDraft.timeMode === "range"
      && submittedDraft.startTime
      && submittedDraft.endTime
      && submittedDraft.endTime < submittedDraft.startTime) {
      setLocalError("종료 시간은 시작 시간보다 빠를 수 없습니다.");
      return;
    }

    setLocalError(null);
    isSavingRef.current = true;
    setIsSaving(true);
    try {
      const saveError = await onSave(
        {
          ...submittedDraft,
          endDate: submittedDraft.endDate || submittedDraft.startDate
        },
        draftBaselineUpdatedAtRef.current
      );
      if (saveError) {
        setLocalError(saveError);
      }
    } finally {
      isSavingRef.current = false;
      setIsSaving(false);
    }
  }

  function addChecklistItem() {
    const text = checklistText.trim();

    if (!text) {
      return;
    }

    setDraft((current) => ({
      ...current,
      checklist: [...current.checklist, { id: crypto.randomUUID(), text, checked: false }]
    }));
    setChecklistText("");
  }

  return (
    <div
      aria-hidden={inactive || undefined}
      className="modal-backdrop schedule-detail-backdrop"
      inert={inactive}
      role="presentation"
      onMouseDown={inactive || isSaving ? undefined : onClose}
    >
      <section
        aria-label={`${task.title} 수정`}
        aria-busy={isSaving || undefined}
        className="schedule-detail-modal"
        role="dialog"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
        ref={dialogRef}
        tabIndex={-1}
      >
        <header>
          <button className="icon-button" disabled={isSaving} type="button" onClick={onClose} aria-label="닫기">
            <X size={18} />
          </button>
        </header>
        <form onSubmit={submit}>
          <label>
            제목
            <input
              autoFocus
              data-dialog-initial-focus
              onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
              required
              value={draft.title}
            />
          </label>
          <label>
            분류
            <AppSelect
              onChange={(event) => setDraft((current) => ({
                ...current,
                category: event.target.value as ScheduleTaskCategory
              }))}
              value={draft.category}
            >
              <option value="work">업무</option>
              <option value="personal">개인</option>
            </AppSelect>
          </label>
          <div className="schedule-detail-grid">
            <DatePickerField
              label="시작일"
              onChange={(dateString) =>
                setDraft((current) => ({
                  ...current,
                  startDate: dateString,
                  endDate: dateString
                }))
              }
              value={draft.startDate}
            />
            {draft.timeMode !== "point" && (
              <DatePickerField
                label="종료일"
                min={draft.startDate || undefined}
                onChange={(dateString) => setDraft((current) => ({ ...current, endDate: dateString }))}
                value={draft.endDate}
              />
            )}
          </div>
          <div className="schedule-time-grid">
            <label>
              시간 방식
              <AppSelect
                onChange={(event) => {
                  const nextMode = event.target.value as TaskDraft["timeMode"];
                  setDraft((current) => applyScheduleTimeMode(current, nextMode));
                }}
                value={draft.timeMode}
              >
                <option value="none">시간 없음</option>
                <option value="point">시각</option>
                <option value="range">시간 범위</option>
              </AppSelect>
            </label>
            {draft.timeMode !== "none" && (
              <TimePickerField
                label="시작 시간"
                onChange={(timeString) =>
                  setDraft((current) => ({
                    ...current,
                    startTime: timeString,
                    endTime:
                      current.timeMode === "range" && current.endTime && current.endTime < timeString
                        ? addMinutesToTimeInput(timeString, 60)
                        : current.endTime
                  }))
                }
                value={draft.startTime}
              />
            )}
            {draft.timeMode === "range" && (
              <TimePickerField
                label="종료 시간"
                min={draft.startTime || undefined}
                onChange={(timeString) => setDraft((current) => ({ ...current, endTime: timeString }))}
                value={draft.endTime}
              />
            )}
          </div>
          <div className="schedule-toggle-row">
            <label>
              <input
                checked={draft.status === "completed"}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, status: event.target.checked ? "completed" : "active" }))
                }
                type="checkbox"
              />
              완료
            </label>
            <label>
              <input
                checked={draft.isImportant}
                onChange={(event) => setDraft((current) => ({ ...current, isImportant: event.target.checked }))}
                type="checkbox"
              />
              중요
            </label>
            <label>
              <input
                checked={draft.isUrgent}
                onChange={(event) => setDraft((current) => ({ ...current, isUrgent: event.target.checked }))}
                type="checkbox"
              />
              긴급
            </label>
          </div>
          <ScheduleColorPicker
            value={draft.color}
            onChange={(color) => setDraft((current) => ({ ...current, color }))}
          />
          <TaskProgressControl
            onChange={(progressPercent) => setDraft((current) => ({ ...current, progressPercent }))}
            percent={draft.progressPercent}
          />
          <label>
            설명
            <textarea
              onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
              rows={5}
              value={draft.description}
            />
          </label>
          <section className="schedule-checklist">
            <h3>체크리스트</h3>
            {checklistGroups.length > 0 && (
              <div className="checklist-groups">
                {checklistGroups.map((group) => (
                  <section className={`checklist-group ${group.key}`} key={group.key} aria-label={`${group.label} ${group.countLabel}`}>
                    <div className="checklist-group-header">
                      <strong>{group.label}</strong>
                      <span>{group.countLabel}</span>
                    </div>
                    <div className="schedule-checklist-group-list">
                      {group.items.map((item) => (
                        <label className="schedule-checklist-item" key={item.id}>
                          <input
                            checked={item.checked}
                            onChange={(event) =>
                              setDraft((current) => ({
                                ...current,
                                checklist: current.checklist.map((checkItem) =>
                                  checkItem.id === item.id ? { ...checkItem, checked: event.target.checked } : checkItem
                                )
                              }))
                            }
                            type="checkbox"
                          />
                          <input
                            aria-label="체크리스트 항목"
                            onChange={(event) =>
                              setDraft((current) => ({
                                ...current,
                                checklist: current.checklist.map((checkItem) =>
                                  checkItem.id === item.id ? { ...checkItem, text: event.target.value } : checkItem
                                )
                              }))
                            }
                            value={item.text}
                          />
                          <button
                            className="icon-button"
                            type="button"
                            aria-label="항목 삭제"
                            onClick={() =>
                              setDraft((current) => ({
                                ...current,
                                checklist: current.checklist.filter((checkItem) => checkItem.id !== item.id)
                              }))
                            }
                          >
                            <X size={15} />
                          </button>
                        </label>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
            <div className="schedule-checklist-add">
              <input
                onCompositionEnd={() => setIsChecklistComposing(false)}
                onCompositionStart={() => setIsChecklistComposing(true)}
                onChange={(event) => setChecklistText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    if (isChecklistComposing || isComposingKeyboardEvent(event)) {
                      return;
                    }

                    event.preventDefault();
                    addChecklistItem();
                  }
                }}
                placeholder="체크리스트 항목"
                value={checklistText}
              />
              <button className="secondary-button" type="button" onClick={addChecklistItem}>
                <Plus size={16} />
                추가
              </button>
            </div>
          </section>
          {localError && <p className="form-error" role="alert">{localError}</p>}
          <footer>
            <button
              className="danger-button"
              disabled={isSaving}
              type="button"
              onClick={(event) => onDelete(event.currentTarget)}
            >
              <Trash2 size={17} />
              삭제
            </button>
            <button disabled={isSaving} type="submit">
              {isSaving ? <LoaderCircle aria-hidden="true" className="spin" size={17} /> : <Save size={17} />}
              {isSaving ? "저장 중" : "저장"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function draftFromTask(task: DecryptedScheduleTask): TaskDraft {
  const details = task.details ?? emptyScheduleDetails;
  const startTime = taskStartTime(task);
  const endTime = task.endTimeMinutes ?? null;

  return {
    category: task.details.category,
    title: task.title,
    description: details.description,
    checklist: details.checklist,
    startDate: taskStartDate(task) ?? "",
    endDate: task.endDate ?? task.startDate ?? task.dueDate ?? "",
    timeMode: startTime == null ? "none" : endTime == null ? "point" : "range",
    startTime: formatTaskTime(startTime),
    endTime: formatTaskTime(endTime),
    color: normalizeScheduleTaskColor(task.color),
    progressPercent: normalizeTaskProgressPercent(task.progressPercent),
    isImportant: task.isImportant,
    isUrgent: task.isUrgent,
    status: task.status
  };
}

function createDraftFromDefaults(defaults: QuickDefaults): CreateTaskDraft {
  const startDate = defaults.startDate ?? "";
  const endDate = defaults.endDate ?? startDate;
  const hasStartTime = defaults.startTimeMinutes != null;

  return {
    category: defaults.category ?? defaultScheduleTaskCategory,
    title: "",
    description: "",
    checklist: [],
    startDate,
    endDate,
    timeMode: hasStartTime ? (defaults.endTimeMinutes == null ? "point" : "range") : "none",
    startTime: formatTaskTime(defaults.startTimeMinutes ?? null),
    endTime: formatTaskTime(defaults.endTimeMinutes ?? null),
    color: normalizeScheduleTaskColor(defaults.color),
    isImportant: defaults.isImportant ?? false,
    isUrgent: defaults.isUrgent ?? false
  };
}

function normalizeScheduleTimeDraft<TDraft extends ScheduleTimeModeDraft>(draft: TDraft): TDraft {
  if (draft.timeMode !== "point") {
    return draft;
  }

  const pointDate = draft.startDate || draft.endDate;

  return {
    ...draft,
    endDate: pointDate,
    endTime: "",
    startDate: pointDate
  };
}

function applyScheduleTimeMode<TDraft extends ScheduleTimeModeDraft>(
  draft: TDraft,
  nextMode: ScheduleTimeModeDraft["timeMode"]
): TDraft {
  const pointDate = draft.startDate || draft.endDate;
  const startTime = nextMode === "none" ? "" : draft.startTime || "09:00";

  return {
    ...draft,
    endDate: nextMode === "point" ? pointDate : draft.endDate,
    endTime: nextMode === "range" ? draft.endTime || addMinutesToTimeInput(draft.startTime || "09:00", 60) : "",
    startDate: nextMode === "point" ? pointDate : draft.startDate,
    startTime,
    timeMode: nextMode
  };
}

function addMinutesToTimeInput(value: string, minutes: number) {
  const current = timeInputToMinutes(value) ?? 0;
  const next = Math.min(23 * 60 + 59, current + minutes);
  return formatTaskTime(next);
}

function datePickerCursor(dateString: string) {
  const [yearText, monthText] = dateString.split("-");
  const year = Number(yearText);
  const month = Number(monthText);

  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    const today = new Date();
    return new Date(today.getFullYear(), today.getMonth(), 1);
  }

  return new Date(year, month - 1, 1);
}

function monthOffset(date: Date, offset: number) {
  return new Date(date.getFullYear(), date.getMonth() + offset, 1);
}

function isComposingKeyboardEvent(event: ReactKeyboardEvent<HTMLInputElement>) {
  const nativeEvent = event.nativeEvent as KeyboardEvent & { isComposing?: boolean; keyCode?: number };
  return Boolean(nativeEvent.isComposing || nativeEvent.keyCode === 229 || event.key === "Process");
}

function normalizedScheduleSearch(value: string) {
  return value.trim().toLocaleLowerCase("ko");
}

function scheduleTaskMatchesQuery(task: DecryptedScheduleTask, query: string) {
  const term = normalizedScheduleSearch(query);

  if (!term) {
    return true;
  }

  return [
    task.title,
    task.details.description,
    task.details.checklist.map((item) => item.text).join(" "),
    scheduleCategoryLabel(task.details.category),
    formatTaskDateDisplay(task),
    task.isImportant ? "중요" : "",
    task.isUrgent ? "긴급" : "",
    task.status === "completed" ? "완료" : "진행"
  ]
    .join(" ")
    .toLocaleLowerCase("ko")
    .includes(term);
}

export function scheduleActionError(caught: unknown, fallback: string) {
  const error = typeof caught === "object" && caught !== null
    ? caught as { code?: unknown; reason?: unknown }
    : {};
  const code = typeof error.code === "string" ? error.code : "";

  if (code === "schedule-task/revision-conflict") {
    const conflictMessage = error.reason === "revision-mismatch"
      ? "일정이 다른 곳에서 변경되었습니다. 최신 내용을 확인한 뒤 다시 저장해주세요."
      : "일정이 삭제되었거나 접근 권한이 변경되었습니다. 목록을 새로고침한 뒤 다시 시도해주세요.";
    return `${fallback} ${conflictMessage}`;
  }

  if (code.includes("permission-denied")) {
    return `${fallback} Firestore 권한이 거부되었습니다. 규칙 배포 상태와 사용자 활성 상태를 확인해주세요.`;
  }

  if (code.includes("failed-precondition")) {
    return `${fallback} Firestore 인덱스 또는 쿼리 조건을 확인해주세요.`;
  }

  return fallback;
}

function calendarMonthLabel(date: Date) {
  return new Intl.DateTimeFormat("ko-KR", { month: "long", year: "numeric" }).format(date);
}

function formatDateLabel(dateString: string) {
  if (!isValidScheduleDateString(dateString)) {
    return "날짜 오류";
  }

  return new Intl.DateTimeFormat("ko-KR", { day: "numeric", month: "long", weekday: "short" }).format(
    new Date(`${dateString}T00:00:00`)
  );
}

function formatTaskDateDisplay(task: DecryptedScheduleTask) {
  const startDate = taskStartDate(task);
  const endDate = task.endDate ?? task.startDate ?? task.dueDate ?? null;

  if (!startDate) {
    return "날짜 없음";
  }

  if (!endDate || endDate === startDate) {
    return formatDateLabel(startDate);
  }

  return formatScheduleDateRange(task);
}

function formatTaskMeta(task: DecryptedScheduleTask) {
  return `${formatTaskDateDisplay(task)}${formatScheduleTimeRange(task) ? ` · ${formatScheduleTimeRange(task)}` : ""}`;
}

function isTaskScheduleOverdue(task: DecryptedScheduleTask, today: string) {
  const endDate = taskEndDate(task);

  return Boolean(task.status === "active" && isValidScheduleDateString(endDate) && endDate < today);
}

function calendarTaskRangePosition(task: DecryptedScheduleTask, dateString: string) {
  const startDate = taskStartDate(task);
  const endDate = taskEndDate(task);

  if (!startDate || !endDate || startDate === endDate) {
    return "single";
  }

  if (dateString === startDate) {
    return "range-start";
  }

  if (dateString === endDate) {
    return "range-end";
  }

  return "range-middle";
}

function shouldShowCalendarTaskLabel(task: DecryptedScheduleTask, dateString: string, firstVisibleDate: string) {
  if (calendarTaskRangePosition(task, dateString) === "single") {
    return true;
  }

  return dateString === firstVisibleDate || !taskCoversDate(task, addDays(dateString, -1));
}

function calendarDayAriaLabel(
  dateString: string,
  tasks: DecryptedScheduleTask[],
  showCategory = true,
  holidays: KoreanHoliday[] = []
) {
  const dateLabel = formatDateLabel(dateString);
  const holidayLabel = holidays.length > 0
    ? ` 공휴일 ${holidays.map((holiday) => holiday.name).join(", ")}.`
    : "";

  if (tasks.length === 0) {
    return `${dateLabel} 선택.${holidayLabel} 일정 없음`;
  }

  const visibleTaskLabels = tasks.slice(0, 3).map(
    (task) => `${showCategory ? `${scheduleCategoryLabel(task.details.category)} ` : ""}${task.title}`
  );
  const remainingCount = tasks.length - visibleTaskLabels.length;
  const remainingLabel = remainingCount > 0 ? ` 외 ${remainingCount}개` : "";

  return `${dateLabel} 선택.${holidayLabel} 일정 ${tasks.length}개: ${visibleTaskLabels.join(", ")}${remainingLabel}`;
}

function taskCoversDate(task: DecryptedScheduleTask, dateString: string) {
  const startDate = taskStartDate(task);
  const endDate = taskEndDate(task);

  return Boolean(startDate && startDate <= dateString && (!endDate || endDate >= dateString));
}
