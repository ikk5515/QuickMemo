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
  BookOpen,
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
  Dumbbell,
  Flag,
  Flame,
  GripVertical,
  Grid2X2,
  GraduationCap,
  HeartPulse,
  LayoutGrid,
  ListTodo,
  LoaderCircle,
  Minus,
  MoreHorizontal,
  Pencil,
  Percent,
  Plus,
  Repeat2,
  Save,
  Search,
  Sparkles,
  Trash2,
  Zap,
  X
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { FormEvent, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import { serverTimestamp } from "firebase/firestore";
import { useLocation, useNavigate } from "react-router-dom";
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
import {
  normalizePrimaryScheduleView,
  scheduleViewFromSearch,
  scheduleViewHref,
  type PrimaryScheduleView
} from "../lib/scheduleNavigation";
import {
  buildRecurringDateStrip,
  buildRecurringHabitOrderUpdates,
  buildRecurringMonthCalendar,
  buildRecurringMonthlySummaries,
  calculateHabitMonthStats,
  calculateHabitStats,
  calculateRecurringDateProgress,
  groupRecurringHabitsBySlot,
  isHabitCheckedOn,
  normalizeMonthString,
  normalizeRecurringHabitDetails,
  recurringHabitChecklistItemMaxLength,
  recurringHabitChecklistMaxItems,
  recurringCheckInId,
  recurringHabitDescriptionMaxLength,
  recurringHabitDetailsValidationError,
  recurringHabitDayCheckedItemIds,
  recurringHabitDayProgressPercent,
  recurringHabitIconLabels,
  recurringHabitIconValues,
  recurringHabitSlots,
  recurringHabitTitleMaxLength,
  recurringHabitTitleValidationError
} from "../lib/recurringHabitHelpers";
import {
  addDays,
  buildScheduleTaskOrderUpdates,
  buildCalendarMonth,
  buildCalendarTaskLayout,
  compareCalendarAgendaTasks,
  compareCompletedTasks,
  compareTaskSchedule,
  emptyScheduleDetails,
  formatScheduleDateRange,
  formatScheduleTimeRange,
  formatTaskTime,
  groupTasksByMatrix,
  groupTasksByTodoDate,
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
  reportGoogleCalendarSync,
  renewGoogleCalendarDeletionWorkflow,
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
  createRecurringHabit,
  deleteRecurringHabit,
  setRecurringHabitCheckIn,
  subscribeRecurringHabitCheckIns,
  subscribeRecurringHabits,
  updateRecurringHabitDayState,
  updateRecurringHabitFromLatest,
  updateRecurringHabitOrderBatch,
  type RecurringHabitCheckInSnapshot,
  type RecurringHabitSnapshot,
  type UpdateRecurringHabitDayStateInput
} from "../services/recurringHabits";
import {
  defaultUserPreferences,
  getCachedUserPreferences,
  getUserPreferences,
  subscribeUserPreferences
} from "../services/userPreferences";
import type {
  DecryptedRecurringHabit,
  DecryptedScheduleTask,
  MatrixLabels,
  RecurringHabitDetails,
  RecurringHabitIcon,
  RecurringHabitSlot,
  ScheduleChecklistItem,
  ScheduleTaskDetails,
  ScheduleView
} from "../types";

const scheduleTabs: Array<{ view: PrimaryScheduleView; label: string; shortLabel: string; Icon: LucideIcon }> = [
  { view: "todo", label: "할 일", shortLabel: "할 일", Icon: ListTodo },
  { view: "calendar", label: "달력", shortLabel: "달력", Icon: CalendarDays },
  { view: "matrix", label: "매트릭스", shortLabel: "매트릭스", Icon: Grid2X2 },
  { view: "recurring", label: "반복 업무", shortLabel: "반복업무", Icon: Repeat2 }
];

const scheduleViewTitles: Record<ScheduleView, string> = {
  calendar: "달력",
  completed: "완료 내역",
  matrix: "매트릭스",
  recurring: "반복 업무",
  todo: "할 일"
};

const taskPageSize = 5;
const completedPageSize = 10;
const scheduleDateRangeValidationMessage = `일정 날짜는 실제 날짜여야 하고 같은 연도 안에서 최대 ${maxScheduleTaskRangeDays}일까지 선택할 수 있습니다.`;
const recurringHabitIconMeta: Record<RecurringHabitIcon, { Icon: LucideIcon; color: string; label: string }> = {
  work: { Icon: BriefcaseBusiness, color: "#2563eb", label: recurringHabitIconLabels.work },
  study: { Icon: GraduationCap, color: "#7c3aed", label: recurringHabitIconLabels.study },
  reading: { Icon: BookOpen, color: "#0891b2", label: recurringHabitIconLabels.reading },
  exercise: { Icon: Dumbbell, color: "#ea580c", label: recurringHabitIconLabels.exercise },
  health: { Icon: HeartPulse, color: "#e11d48", label: recurringHabitIconLabels.health },
  cleanup: { Icon: Sparkles, color: "#16a34a", label: recurringHabitIconLabels.cleanup },
  review: { Icon: CheckCircle2, color: "#ca8a04", label: recurringHabitIconLabels.review },
  other: { Icon: Repeat2, color: "#64748b", label: recurringHabitIconLabels.other }
};

type DecryptedTaskCache = Map<string, {
  details: ScheduleTaskDetails;
  encryptedDetails: ScheduleTaskSnapshot["encryptedDetails"];
  encryptedTitle: ScheduleTaskSnapshot["encryptedTitle"];
  title: string;
  wrappedKey: ScheduleTaskSnapshot["wrappedKeys"][string];
}>;
type DecryptedHabitCache = Map<string, {
  details: RecurringHabitDetails;
  encryptedDetails: RecurringHabitSnapshot["encryptedDetails"];
  encryptedTitle: RecurringHabitSnapshot["encryptedTitle"];
  title: string;
  wrappedKey: RecurringHabitSnapshot["wrappedKeys"][string];
}>;

const scheduleDecryptConcurrency = 6;

async function mapWithConcurrency<TItem, TResult>(
  items: TItem[],
  concurrency: number,
  mapper: (item: TItem, index: number) => Promise<TResult>
) {
  const results = new Array<TResult>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, () => worker())
  );
  return results;
}

function sameEncryptedPayload(
  left: ScheduleTaskSnapshot["encryptedTitle"],
  right: ScheduleTaskSnapshot["encryptedTitle"]
) {
  return left.version === right.version
    && left.algorithm === right.algorithm
    && left.iv === right.iv
    && left.cipherText === right.cipherText;
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

function replaceRecurringCheckInSnapshot(
  checkIns: RecurringHabitCheckInSnapshot[],
  habitId: string,
  date: string,
  nextCheckIn: RecurringHabitCheckInSnapshot | null
) {
  const existingIndex = checkIns.findIndex((checkIn) => checkIn.habitId === habitId && checkIn.date === date);

  if (!nextCheckIn) {
    return existingIndex < 0 ? checkIns : checkIns.filter((_, index) => index !== existingIndex);
  }

  if (existingIndex < 0) {
    return [...checkIns, nextCheckIn];
  }

  return checkIns.map((checkIn, index) => index === existingIndex ? nextCheckIn : checkIn);
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

type CompletedContentFilter = "all" | "hasDescription" | "hasChecklist";
type CompletedMonthsFilter = "1" | "3" | "6" | "12" | "all";
type CompletedPriorityFilter = "all" | "important" | "urgent" | "importantUrgent";
type TaskDetailsUpdater = (details: ScheduleTaskDetails) => ScheduleTaskDetails;
type RecurringHabitDetailsUpdater = (details: RecurringHabitDetails) => RecurringHabitDetails;

interface QuickDefaults {
  startDate?: string | null;
  endDate?: string | null;
  startTimeMinutes?: number | null;
  endTimeMinutes?: number | null;
  color?: string | null;
  isImportant?: boolean;
  isUrgent?: boolean;
}

interface TaskDraft {
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

function isEligibleExistingGoogleCalendarTask(task: DecryptedScheduleTask, today: string) {
  const startDate = taskStartDate(task);
  const endDate = taskEndDate(task) ?? startDate;

  return task.status === "active"
    && isValidScheduleDateString(startDate)
    && isValidScheduleDateString(endDate)
    && endDate >= today;
}

type ScheduleTimeModeDraft = Pick<CreateTaskDraft, "endDate" | "endTime" | "startDate" | "startTime" | "timeMode">;

interface CreateDialogState {
  allowPriority?: boolean;
  defaults: QuickDefaults;
  title: string;
}

interface RecurringHabitDraft {
  title: string;
  description: string;
  slot: RecurringHabitSlot;
  icon: RecurringHabitIcon;
  color: string;
}

interface RecurringHabitDialogState {
  habitId?: string;
  mode: "create" | "edit";
}

interface TodayWorkSummary {
  overdueTasks: DecryptedScheduleTask[];
  recurringHabits: DecryptedRecurringHabit[];
  todayTasks: DecryptedScheduleTask[];
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
const googleCalendarForegroundSyncs = new Set<string>();
const googleCalendarBatchBlockingErrorCodes = new Set([
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
  onFailure: (caught: unknown) => void | Promise<void>;
  onSuccess: (syncedCount: number) => void;
  ownerUid: string;
  paused: boolean;
  scheduleTasksLoaded: boolean;
  tasks: DecryptedScheduleTask[];
}

function GoogleCalendarRecoveryWorker({
  connection,
  onFailure,
  onSuccess,
  ownerUid,
  paused,
  scheduleTasksLoaded,
  tasks
}: GoogleCalendarRecoveryWorkerProps) {
  const [retryTick, setRetryTick] = useState(0);
  const attemptsRef = useRef(new Map<string, number>());
  const callbackRef = useRef({ onFailure, onSuccess });
  const tasksRef = useRef(tasks);
  const recoverySignature = useMemo(
    () => tasks.map(googleCalendarTaskRecoverySignature).sort().join("|"),
    [tasks]
  );

  useEffect(() => {
    callbackRef.current = { onFailure, onSuccess };
  }, [onFailure, onSuccess]);

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

    const requestRetry = (key: string, baseDelayMs = 2_000) => {
      const attempt = (attemptsRef.current.get(key) ?? 0) + 1;

      attemptsRef.current.set(key, attempt);
      if (attempt > googleCalendarRecoveryMaxAttempts) {
        retryDelayMs = retryDelayMs === null
          ? googleCalendarRecoveryBackgroundRetryMs
          : Math.min(retryDelayMs, googleCalendarRecoveryBackgroundRetryMs);
        return;
      }
      const delay = Math.min(30_000, baseDelayMs * (2 ** Math.max(0, attempt - 1)));

      retryDelayMs = retryDelayMs === null ? delay : Math.min(retryDelayMs, delay);
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
        requestRetry(key, 1_000);
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
        retryTimer = window.setTimeout(resolve, 250);
      });
      retryTimer = null;
      if (!active || controller.signal.aborted) {
        return;
      }
      const currentTasks = tasksRef.current;
      const decryptedById = new Map(currentTasks.map((task) => [task.id, task]));

      let tombstones: GoogleCalendarTaskTombstone[] = [];
      let receipts = new Map<string, Awaited<ReturnType<typeof listGoogleCalendarTaskSyncReceipts>>[number]>();
      let receiptsAvailable = true;

      try {
        receipts = new Map(
          (await listGoogleCalendarTaskSyncReceipts(ownerUid)).map((receipt) => [receipt.taskId, receipt])
        );
        attemptsRef.current.delete(`receipt-list:${generation}`);
      } catch (caught) {
        receiptsAvailable = false;
        firstFailure = caught;
        requestRetry(`receipt-list:${generation}`);
      }

      try {
        tombstones = await listGoogleCalendarTaskTombstones(ownerUid);
        attemptsRef.current.delete(`tombstone-list:${generation}`);
      } catch (caught) {
        firstFailure = caught;
        requestRetry(`tombstone-list:${generation}`);
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
        } catch (caught) {
          firstFailure ??= caught;
          requestRetry(key, googleCalendarBatchRetryDelay(caught));
          if (googleCalendarBatchShouldStop(caught)) {
            batchBlocked = true;
            break;
          }
        }
      }

      for (const task of !batchBlocked && receiptsAvailable ? currentTasks : []) {
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
          }
        } catch (caught) {
          firstFailure ??= caught;
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
      if (succeeded > 0) {
        callbackRef.current.onSuccess(succeeded);
      }
      if (firstFailure) {
        await callbackRef.current.onFailure(firstFailure);
      }
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

export default function SchedulePage({ routeView }: { routeView?: Extract<ScheduleView, "recurring"> }) {
  const { privateKey, profile } = useAuth();
  const googleCalendarProfileUid = profile?.uid ?? null;
  const location = useLocation();
  const navigate = useNavigate();
  const isRecurringPage = routeView === "recurring";
  const [activeView, setActiveView] = useState<ScheduleView | null>(() =>
    routeView
      ?? scheduleViewFromSearch(location.search)
      ?? (profile ? normalizePrimaryScheduleView(getCachedUserPreferences(profile.uid)?.scheduleDefaultView) : null)
  );
  const [matrixLabels, setMatrixLabels] = useState<MatrixLabels>(() =>
    profile ? getCachedUserPreferences(profile.uid)?.matrixLabels ?? defaultMatrixLabels : defaultMatrixLabels
  );
  const [tasks, setTasks] = useState<ScheduleTaskSnapshot[]>([]);
  const [scheduleTasksLoaded, setScheduleTasksLoaded] = useState(false);
  const [decryptedTasks, setDecryptedTasks] = useState<DecryptedScheduleTask[]>([]);
  const [recurringHabits, setRecurringHabits] = useState<RecurringHabitSnapshot[]>([]);
  const [decryptedRecurringHabits, setDecryptedRecurringHabits] = useState<DecryptedRecurringHabit[]>([]);
  const [recurringCheckIns, setRecurringCheckIns] = useState<RecurringHabitCheckInSnapshot[]>([]);
  const [viewTaskId, setViewTaskId] = useState<string | null>(null);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [deleteConfirmationTask, setDeleteConfirmationTask] = useState<DecryptedScheduleTask | null>(null);
  const [taskDeletionPending, setTaskDeletionPending] = useState(false);
  const [taskDeletionError, setTaskDeletionError] = useState<string | null>(null);
  const [taskDuplicationPending, setTaskDuplicationPending] = useState(false);
  const [viewRecurringHabitId, setViewRecurringHabitId] = useState<string | null>(null);
  const [readRecurringHabitId, setReadRecurringHabitId] = useState<string | null>(null);
  const [recurringHabitDialog, setRecurringHabitDialog] = useState<RecurringHabitDialogState | null>(null);
  const [recurringOverviewOpen, setRecurringOverviewOpen] = useState(false);
  const [todayPanelOpen, setTodayPanelOpen] = useState(false);
  const [scheduleToolsOpen, setScheduleToolsOpen] = useState(false);
  const [selectedRecurringDate, setSelectedRecurringDate] = useState(() => toLocalDateString(new Date()));
  const [recurringMonth, setRecurringMonth] = useState(() => toLocalDateString(new Date()).slice(0, 7));
  const [pendingRecurringCheckIn, setPendingRecurringCheckIn] = useState<Record<string, boolean>>({});
  const [pendingRecurringDeletion, setPendingRecurringDeletion] = useState<Record<string, boolean>>({});
  const [selectedCalendarDate, setSelectedCalendarDate] = useState(() => toLocalDateString(new Date()));
  const [calendarCursor, setCalendarCursor] = useState(() => new Date());
  const [createDialog, setCreateDialog] = useState<CreateDialogState | null>(null);
  const [scheduleQuery, setScheduleQuery] = useState("");
  const [completedQuery, setCompletedQuery] = useState("");
  const [completedDate, setCompletedDate] = useState("");
  const [completedMonth, setCompletedMonth] = useState(() => toLocalDateString(new Date()).slice(0, 7));
  const [completedMonths, setCompletedMonths] = useState<CompletedMonthsFilter>("1");
  const [completedPriority, setCompletedPriority] = useState<CompletedPriorityFilter>("all");
  const [completedContent, setCompletedContent] = useState<CompletedContentFilter>("all");
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
  const decryptedTasksRef = useRef<DecryptedScheduleTask[]>([]);
  const decryptedRecurringHabitsRef = useRef<DecryptedRecurringHabit[]>([]);
  const decryptedTaskCacheRef = useRef<DecryptedTaskCache>(new Map());
  const decryptedHabitCacheRef = useRef<DecryptedHabitCache>(new Map());
  const decryptCacheIdentityRef = useRef<{ privateKey: CryptoKey | null; uid: string | null }>({
    privateKey: null,
    uid: null
  });
  const taskDetailsUpdateQueueRef = useRef<Partial<Record<string, Promise<ScheduleTaskDetails>>>>({});
  const recurringDetailsUpdateQueueRef = useRef<Partial<Record<string, Promise<RecurringHabitDetails>>>>({});
  const recurringCheckInSnapshotRevisionRef = useRef(0);
  const recurringCheckInOperationRef = useRef(new Map<string, symbol>());
  const recurringCheckInWriteQueueRef = useRef(new Map<string, Promise<unknown>>());
  const seenRecurringHabitIdsRef = useRef(new Set<string>());
  const scheduleToolsRef = useRef<HTMLDivElement>(null);
  const scheduleToolsTriggerRef = useRef<HTMLButtonElement>(null);
  const scheduleToolsPopoverId = useId();
  const todayPanelId = useId();
  const todayPanelRef = useRef<HTMLElement | null>(null);
  const todayWorkTriggerRef = useRef<HTMLButtonElement>(null);
  const googleCalendarPopupRef = useRef<Window | null>(null);
  const googleCalendarAttemptRef = useRef(0);
  const googleCalendarStatusRequestRef = useRef(0);
  const googleCalendarOperationRef = useRef<GoogleCalendarDialogOperation>(null);
  const googleCalendarUiEpochRef = useRef(0);
  const googleCalendarSyncAbortRef = useRef<AbortController | null>(null);
  const taskDuplicationPendingRef = useRef(false);
  const needsScheduleData = Boolean(privateKey)
    && !isRecurringPage
    && activeView !== null
    && activeView !== "recurring";
  const needsFullRecurringHistory = isRecurringPage
    || Boolean(viewRecurringHabitId || readRecurringHabitId || recurringHabitDialog || recurringOverviewOpen);
  const needsRecurringData = Boolean(privateKey) && (needsFullRecurringHistory || todayPanelOpen);

  const refreshGoogleCalendarStatus = useCallback(async (
    showLoading = true,
    surfaceError = true,
    signal?: AbortSignal
  ) => {
    if (!googleCalendarProfileUid || !privateKey) {
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
        setGoogleCalendarConnection(nextStatus);
        if (surfaceError) {
          setGoogleCalendarError(null);
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
    googleCalendarUiEpochRef.current += 1;
    googleCalendarAttemptRef.current += 1;
    googleCalendarStatusRequestRef.current += 1;
    googleCalendarSyncAbortRef.current?.abort();
    googleCalendarSyncAbortRef.current = null;
    googleCalendarPopupRef.current?.close();
    googleCalendarPopupRef.current = null;
    clearGoogleCalendarSession();
    setGoogleCalendarConnection(disconnectedGoogleCalendarStatus);
    setGoogleCalendarError(null);
    setGoogleCalendarNotice(null);
    setGoogleCalendarDialogOpen(false);
    setGoogleCalendarOperation(null);
    googleCalendarOperationRef.current = null;
    setGoogleCalendarProgress(null);

    if (googleCalendarProfileUid && privateKey && !isRecurringPage) {
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
      clearGoogleCalendarSession();
    };
  }, [googleCalendarProfileUid, isRecurringPage, privateKey, refreshGoogleCalendarStatus]);

  useEffect(() => {
    if (!googleCalendarDialogOpen || !googleCalendarProfileUid || !privateKey || isRecurringPage) {
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
  }, [googleCalendarDialogOpen, googleCalendarProfileUid, isRecurringPage, privateKey, refreshGoogleCalendarStatus]);

  const closeScheduleToolsMenu = useCallback((restoreFocus = false) => {
    setScheduleToolsOpen(false);

    if (restoreFocus) {
      window.setTimeout(() => scheduleToolsTriggerRef.current?.focus({ preventScroll: true }), 0);
    }
  }, []);

  const closeTodayWorkPanel = useCallback((restoreFocus = true) => {
    setTodayPanelOpen(false);

    if (restoreFocus) {
      window.setTimeout(() => todayWorkTriggerRef.current?.focus({ preventScroll: true }), 0);
    }
  }, []);

  useEffect(() => {
    if (routeView) {
      setActiveView(routeView);
      return undefined;
    }

    const requestedView = scheduleViewFromSearch(location.search);

    if (requestedView) {
      if (requestedView === "recurring") {
        navigate(scheduleViewHref("recurring"), { replace: true });
        return undefined;
      }

      setActiveView(requestedView);
      return undefined;
    }

    if (!profile) {
      setActiveView(null);
      return undefined;
    }

    let active = true;
    const cachedPreferences = getCachedUserPreferences(profile.uid);

    const cachedView = normalizePrimaryScheduleView(cachedPreferences?.scheduleDefaultView);

    if (cachedView === "recurring") {
      navigate(scheduleViewHref(cachedView), { replace: true });
    } else {
      setActiveView(cachedView);
    }

    void getUserPreferences(profile.uid)
      .then((preferences) => {
        if (active) {
          const nextView = normalizePrimaryScheduleView(preferences.scheduleDefaultView);

          if (nextView === "recurring") {
            navigate(scheduleViewHref(nextView), { replace: true });
          } else {
            setActiveView(nextView);
          }
        }
      })
      .catch(() => {
        if (active) {
          const fallbackView = normalizePrimaryScheduleView(
            cachedPreferences?.scheduleDefaultView ?? defaultUserPreferences.scheduleDefaultView
          );

          if (fallbackView === "recurring") {
            navigate(scheduleViewHref(fallbackView), { replace: true });
          } else {
            setActiveView(fallbackView);
          }
        }
      });

    return () => {
      active = false;
    };
  }, [location.search, navigate, profile, routeView]);

  useEffect(() => {
    if (!scheduleToolsOpen) {
      return undefined;
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;

      if (target instanceof Node && scheduleToolsRef.current?.contains(target)) {
        return;
      }

      closeScheduleToolsMenu();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeScheduleToolsMenu(true);
      }
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeScheduleToolsMenu, scheduleToolsOpen]);

  useEffect(() => {
    if (!todayPanelOpen) {
      return undefined;
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;

      if (
        target instanceof Node &&
        (todayPanelRef.current?.contains(target) || todayWorkTriggerRef.current?.contains(target))
      ) {
        return;
      }

      setTodayPanelOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeTodayWorkPanel();
      }
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeTodayWorkPanel, todayPanelOpen]);

  useEffect(() => {
    if (!profile || isRecurringPage) {
      setMatrixLabels(defaultMatrixLabels);
      return undefined;
    }

    const cachedPreferences = getCachedUserPreferences(profile.uid);

    setMatrixLabels(cachedPreferences?.matrixLabels ?? defaultMatrixLabels);

    return subscribeUserPreferences(
      profile.uid,
      (preferences) => setMatrixLabels(preferences.matrixLabels),
      () => setMatrixLabels(cachedPreferences?.matrixLabels ?? defaultMatrixLabels)
    );
  }, [isRecurringPage, profile]);

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
    setSelectedRecurringDate((current) => (current < today ? today : current));
    setRecurringMonth((current) => current || today.slice(0, 7));
  }, [today]);

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
    if (!profile || !needsRecurringData) {
      recurringCheckInSnapshotRevisionRef.current += 1;
      recurringCheckInOperationRef.current.clear();
      seenRecurringHabitIdsRef.current.clear();
      setRecurringHabits([]);
      setRecurringCheckIns([]);
      setPendingRecurringCheckIn({});
      return undefined;
    }

    const unsubscribeHabits = subscribeRecurringHabits(
      profile.uid,
      (nextHabits) => {
        nextHabits.forEach((habit) => seenRecurringHabitIdsRef.current.add(habit.id));
        setRecurringHabits(nextHabits);
        setError(null);
      },
      (caught) => setError(scheduleActionError(caught, "반복 업무를 불러오지 못했습니다."))
    );
    const unsubscribeCheckIns = subscribeRecurringHabitCheckIns(
      profile.uid,
      (nextCheckIns) => {
        recurringCheckInSnapshotRevisionRef.current += 1;
        setRecurringCheckIns(nextCheckIns);
        setError(null);
      },
      (caught) => setError(scheduleActionError(caught, "반복 체크인을 불러오지 못했습니다.")),
      needsFullRecurringHistory ? undefined : { date: today }
    );

    return () => {
      unsubscribeHabits();
      unsubscribeCheckIns();
    };
  }, [needsRecurringData, needsFullRecurringHistory, profile, today]);

  useEffect(() => {
    const uid = profile?.uid ?? null;
    const currentIdentity = decryptCacheIdentityRef.current;

    if (currentIdentity.privateKey !== privateKey || currentIdentity.uid !== uid) {
      decryptedTaskCacheRef.current.clear();
      decryptedHabitCacheRef.current.clear();
      setDecryptedTasks([]);
      setDecryptedRecurringHabits([]);
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
            && sameEncryptedPayload(cached.encryptedDetails, task.encryptedDetails)
            && sameWrappedKey(cached.wrappedKey, wrappedKey)
          ) {
            decryptedTaskCacheRef.current.set(task.id, {
              ...cached,
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
            const [title, detailsJson] = await Promise.all([
              decryptText(task.encryptedTitle, taskKey),
              decryptText(task.encryptedDetails, taskKey)
            ]);
            const parsedDetails = JSON.parse(detailsJson) as unknown;

            const decryptedTask = {
              ...task,
              title,
              details: normalizeScheduleDetails(parsedDetails)
            } satisfies DecryptedScheduleTask;

            if (!ownsCurrentCache()) {
              return null;
            }

            decryptedTaskCacheRef.current.set(task.id, {
              details: decryptedTask.details,
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
    if (!profile || !privateKey) {
      decryptedHabitCacheRef.current.clear();
      setDecryptedRecurringHabits([]);
      return undefined;
    }

    const safeProfile = profile;
    const safePrivateKey = privateKey;
    let active = true;

    const ownsCurrentCache = () => active
      && decryptCacheIdentityRef.current.privateKey === safePrivateKey
      && decryptCacheIdentityRef.current.uid === safeProfile.uid;

    async function decryptHabits() {
      if (!ownsCurrentCache()) {
        return;
      }

      pruneScheduleDecryptCache(decryptedHabitCacheRef.current, recurringHabits);
      const nextHabits = await mapWithConcurrency(
        recurringHabits,
        scheduleDecryptConcurrency,
        async (habit) => {
          if (!ownsCurrentCache()) {
            return null;
          }

          const wrappedKey = habit.wrappedKeys[safeProfile.uid];

          if (!wrappedKey) {
            decryptedHabitCacheRef.current.delete(habit.id);
            return null;
          }

          const cached = decryptedHabitCacheRef.current.get(habit.id);

          if (
            cached
            && sameEncryptedPayload(cached.encryptedTitle, habit.encryptedTitle)
            && sameEncryptedPayload(cached.encryptedDetails, habit.encryptedDetails)
            && sameWrappedKey(cached.wrappedKey, wrappedKey)
          ) {
            decryptedHabitCacheRef.current.set(habit.id, {
              ...cached,
              encryptedDetails: habit.encryptedDetails,
              encryptedTitle: habit.encryptedTitle,
              wrappedKey
            });

            return {
              ...habit,
              title: cached.title,
              details: cached.details
            } satisfies DecryptedRecurringHabit;
          }

          try {
            const habitKey = await unwrapNoteKey(wrappedKey, safePrivateKey);
            const [title, detailsJson] = await Promise.all([
              decryptText(habit.encryptedTitle, habitKey),
              decryptText(habit.encryptedDetails, habitKey)
            ]);

            const decryptedHabit = {
              ...habit,
              title,
              details: normalizeRecurringHabitDetails(JSON.parse(detailsJson) as unknown)
            } satisfies DecryptedRecurringHabit;

            if (!ownsCurrentCache()) {
              return null;
            }

            decryptedHabitCacheRef.current.set(habit.id, {
              details: decryptedHabit.details,
              encryptedDetails: habit.encryptedDetails,
              encryptedTitle: habit.encryptedTitle,
              title: decryptedHabit.title,
              wrappedKey
            });
            return decryptedHabit;
          } catch {
            if (ownsCurrentCache()) {
              decryptedHabitCacheRef.current.delete(habit.id);
            }
            return null;
          }
        }
      );

      if (ownsCurrentCache()) {
        setDecryptedRecurringHabits(nextHabits.filter((habit): habit is DecryptedRecurringHabit => Boolean(habit)));
      }
    }

    void decryptHabits();

    return () => {
      active = false;
    };
  }, [privateKey, profile, recurringHabits]);

  useEffect(() => {
    decryptedTasksRef.current = decryptedTasks;
  }, [decryptedTasks]);

  useEffect(() => {
    decryptedRecurringHabitsRef.current = decryptedRecurringHabits;
  }, [decryptedRecurringHabits]);

  const sortedTasks = useMemo(() => [...decryptedTasks].sort(compareTaskSchedule), [decryptedTasks]);
  const eligibleGoogleCalendarTasks = useMemo(
    () => sortedTasks.filter((task) => isEligibleExistingGoogleCalendarTask(task, today)),
    [sortedTasks, today]
  );
  const displayedTasks = useMemo(
    () => sortedTasks.filter((task) => scheduleTaskMatchesQuery(task, scheduleQuery)),
    [scheduleQuery, sortedTasks]
  );
  const displayedRecurringHabits = useMemo(
    () => decryptedRecurringHabits.filter(
      (habit) => habit.status === "active" && recurringHabitMatchesQuery(habit, scheduleQuery)
    ),
    [decryptedRecurringHabits, scheduleQuery]
  );
  const pendingDeletionHabits = useMemo(
    () => decryptedRecurringHabits.filter((habit) => habit.status === "archived"),
    [decryptedRecurringHabits]
  );
  const scheduleStats = useMemo(
    () => isRecurringPage
      ? { active: 0, completed: 0, overdue: 0, recurring: 0, today: 0 }
      : scheduleDashboardStats(sortedTasks, decryptedRecurringHabits, today),
    [decryptedRecurringHabits, isRecurringPage, sortedTasks, today]
  );
  const viewTask = useMemo(
    () => sortedTasks.find((task) => task.id === viewTaskId) ?? null,
    [viewTaskId, sortedTasks]
  );
  const editingTask = useMemo(
    () => sortedTasks.find((task) => task.id === editingTaskId) ?? null,
    [editingTaskId, sortedTasks]
  );
  const selectedRecurringHabit = useMemo(
    () => decryptedRecurringHabits.find(
      (habit) => habit.id === viewRecurringHabitId && habit.status === "active"
    ) ?? null,
    [decryptedRecurringHabits, viewRecurringHabitId]
  );
  const readRecurringHabit = useMemo(
    () => decryptedRecurringHabits.find(
      (habit) => habit.id === readRecurringHabitId && habit.status === "active"
    ) ?? null,
    [decryptedRecurringHabits, readRecurringHabitId]
  );
  const editingRecurringHabit = useMemo(
    () => decryptedRecurringHabits.find(
      (habit) => habit.id === recurringHabitDialog?.habitId && habit.status === "active"
    ) ?? null,
    [decryptedRecurringHabits, recurringHabitDialog?.habitId]
  );
  const completedTasks = useMemo(
    () => activeView === "completed"
      ? displayedTasks.filter((task) => task.status === "completed").sort(compareCompletedTasks)
      : [],
    [activeView, displayedTasks]
  );
  const todoGroups = useMemo(
    () => activeView === "todo" ? groupTasksByTodoDate(displayedTasks, today) : [],
    [activeView, displayedTasks, today]
  );
  const matrixSections = useMemo(
    () => activeView === "matrix" ? groupTasksByMatrix(displayedTasks, today, matrixLabels) : [],
    [activeView, displayedTasks, matrixLabels, today]
  );
  const activeMatrixTaskCount = useMemo(
    () => activeView === "matrix" ? sortedTasks.filter((task) => task.status !== "completed").length : 0,
    [activeView, sortedTasks]
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
  const todayWorkSummary = useMemo<TodayWorkSummary>(() => {
    if (isRecurringPage) {
      return { overdueTasks: [], recurringHabits: [], todayTasks: [] };
    }

    const activeTasks = sortedTasks.filter((task) => task.status !== "completed");
    const overdueTasks = activeTasks.filter((task) => isTaskScheduleOverdue(task, today));
    const todayTasks = activeTasks.filter((task) => taskCoversDate(task, today) && !isTaskScheduleOverdue(task, today));
    const recurringHabitsForToday = decryptedRecurringHabits.filter((habit) => habit.status === "active");

    return { overdueTasks, recurringHabits: recurringHabitsForToday, todayTasks };
  }, [decryptedRecurringHabits, isRecurringPage, sortedTasks, today]);

  useEffect(() => {
    const habitIsUnavailable = (habitId: string) => {
      const rawHabit = recurringHabits.find((habit) => habit.id === habitId);

      return rawHabit?.status === "archived"
        || (!rawHabit && seenRecurringHabitIdsRef.current.has(habitId));
    };

    if (viewRecurringHabitId && !selectedRecurringHabit && habitIsUnavailable(viewRecurringHabitId)) {
      setViewRecurringHabitId(null);
    }
    if (readRecurringHabitId && !readRecurringHabit && habitIsUnavailable(readRecurringHabitId)) {
      setReadRecurringHabitId(null);
    }

    if (
      recurringHabitDialog?.mode === "edit"
      && recurringHabitDialog.habitId
      && !editingRecurringHabit
      && habitIsUnavailable(recurringHabitDialog.habitId)
    ) {
      setRecurringHabitDialog(null);
    }
  }, [
    editingRecurringHabit,
    readRecurringHabit,
    readRecurringHabitId,
    recurringHabits,
    recurringHabitDialog?.habitId,
    recurringHabitDialog?.mode,
    selectedRecurringHabit,
    viewRecurringHabitId
  ]);

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

  async function authoritativeGoogleCalendarTask(taskId: string): Promise<GoogleCalendarTaskInput | null> {
    const latestTask = await getScheduleTask(taskId);

    if (!latestTask || latestTask.ownerUid !== unlockedProfile.uid) {
      return null;
    }
    const wrappedKey = latestTask.wrappedKeys[unlockedProfile.uid];
    if (!wrappedKey) {
      throw new Error("일정 암호화 키를 찾지 못했습니다.");
    }
    const taskKey = await unwrapNoteKey(wrappedKey, unlockedPrivateKey);
    const title = await decryptText(latestTask.encryptedTitle, taskKey);
    const startDate = latestTask.startDate ?? latestTask.dueDate ?? null;
    const calendarRevisionTimestamp = googleCalendarTaskRevisionTimestamp(latestTask);

    return {
      id: latestTask.id,
      ownerUid: latestTask.ownerUid,
      title: title.trim() || "제목 없음",
      startDate,
      endDate: startDate ? latestTask.endDate ?? startDate : null,
      startTimeMinutes: latestTask.startTimeMinutes ?? latestTask.dueTimeMinutes ?? null,
      endTimeMinutes: latestTask.endTimeMinutes ?? null,
      revision: googleCalendarTaskRevision(calendarRevisionTimestamp)
    };
  }

  function updateGoogleCalendarSyncSuccess(syncedCount: number, report = true) {
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

    if (report) {
      void reportGoogleCalendarSync({ status: "synced", syncedCount }).catch(() => undefined);
    }
  }

  async function updateGoogleCalendarSyncFailure(caught: unknown, syncedCount = 0, report = true) {
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

    const persistReconnectFailure = code === "permission_denied" || code === "reauthorization_required";

    if (report && (!needsReconnect || persistReconnectFailure)) {
      await reportGoogleCalendarSync({
        failureCode: code,
        status: "failed",
        syncedCount
      }).catch(() => undefined);
    }
  }

  async function recordGoogleCalendarTaskSyncReceipt(
    task: GoogleCalendarTaskInput,
    connection: GoogleCalendarConnectionStatus
  ) {
    if (!connection.connectionGeneration || !task.revision) {
      throw new GoogleCalendarError(
        "connection_changed",
        "Google Calendar 연결 또는 일정 수정본이 변경되었습니다. 다시 동기화해주세요."
      );
    }
    const latestTask = await getScheduleTask(task.id);
    const latestRevisionTimestamp = latestTask
      ? googleCalendarTaskRevisionTimestamp(latestTask)
      : null;

    if (!latestTask
      || latestTask.ownerUid !== task.ownerUid
      || !latestRevisionTimestamp
      || googleCalendarTaskRevision(latestRevisionTimestamp) !== task.revision) {
      throw new GoogleCalendarError(
        "event_conflict",
        "일정이 다른 창에서 변경되었습니다. 최신 내용을 다시 동기화합니다.",
        true
      );
    }

    try {
      await markScheduleTaskGoogleCalendarSynced(
        task.id,
        task.ownerUid,
        connection.connectionGeneration,
        latestRevisionTimestamp
      );
    } catch (caught) {
      throw new GoogleCalendarError(
        "sync_receipt_failed",
        `Google 일정은 반영했지만 동기화 상태를 저장하지 못했습니다. ${scheduleActionError(caught, "잠시 후 자동으로 다시 확인합니다.")}`,
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
    deletionWorkflow?: GoogleCalendarDeletionWorkflow
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
        deletionWorkflow
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
          deletionWorkflow
        );
      }
      return upsertGoogleCalendarTaskWithRetry(
        latestTask,
        maxRetries,
        timeZone,
        signal,
        authorityReconciliations + 1,
        deletionWorkflow
      );
    }

    let attempt = 0;

    while (true) {
      if (signal?.aborted) {
        throw new GoogleCalendarError("sync_cancelled", "기존 일정 동기화를 취소했습니다.");
      }

      try {
        const result = deletionWorkflow
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
            deletionWorkflow
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
              deletionWorkflow
            );
          }
          return upsertGoogleCalendarTaskWithRetry(
            latestTask,
            maxRetries,
            timeZone,
            undefined,
            authorityReconciliations + 1,
            deletionWorkflow
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
    deletionWorkflow?: GoogleCalendarDeletionWorkflow
  ): Promise<GoogleCalendarSyncResult> {
    const deleteInput = { id: task.id, ownerUid: task.ownerUid };
    const result = deletionWorkflow
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
          if (deletionWorkflow) {
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
      if (deletionWorkflow) {
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
      deletionWorkflow
    );
  }

  async function syncGoogleCalendarTaskAfterSave(
    taskId: string,
    previouslyDated = false
  ) {
    const foregroundSyncKey = `${unlockedProfile.uid}:${taskId}`;

    googleCalendarForegroundSyncs.add(foregroundSyncKey);
    try {
      let currentConnection: GoogleCalendarConnectionStatus;

      try {
        currentConnection = await refreshGoogleCalendarStatus(false, false);
      } catch (caught) {
        return `일정은 QuickMemo에 저장했지만 Google Calendar 연결 상태를 확인하지 못했습니다. ${googleCalendarErrorMessage(caught)}`;
      }

      if (currentConnection.needsReconnect) {
        return "일정은 QuickMemo에 저장했지만 Google Calendar 계정을 다시 연결해야 동기화됩니다.";
      }

      if (!currentConnection.connected) {
        return null;
      }

      let task: GoogleCalendarTaskInput | null;

      try {
        task = await authoritativeGoogleCalendarTask(taskId);
      } catch (caught) {
        return `일정은 QuickMemo에 저장했지만 최신 내용을 확인하지 못해 Google Calendar에는 반영하지 않았습니다. ${scheduleActionError(caught, "최신 일정을 확인하지 못했습니다.")}`;
      }
      if (!task) {
        return null;
      }

      if (!task.startDate && !previouslyDated) {
        return null;
      }

      try {
        const result = await upsertGoogleCalendarTaskWithRetry(
          task,
          0,
          currentConnection.timeZone || detectedGoogleCalendarTimeZone()
        );
        await recordGoogleCalendarTaskSyncReceipt(task, currentConnection);
        updateGoogleCalendarSyncSuccess(result.outcome === "skipped" ? 0 : 1);
        return null;
      } catch (caught) {
        await updateGoogleCalendarSyncFailure(caught);
        return `일정은 QuickMemo에 저장했지만 Google Calendar에는 반영하지 못했습니다. ${googleCalendarErrorMessage(caught)}`;
      }
    } finally {
      googleCalendarForegroundSyncs.delete(foregroundSyncKey);
    }
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
    setTodayPanelOpen(false);
    setScheduleToolsOpen(false);
    setGoogleCalendarDialogOpen(true);
    setGoogleCalendarError(null);
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

  async function syncExistingGoogleCalendarTasks() {
    if (googleCalendarOperationRef.current) {
      return;
    }

    const eligibleTasks = decryptedTasksRef.current.filter((task) =>
      isEligibleExistingGoogleCalendarTask(task, toLocalDateString(new Date()))
    );

    if (!eligibleTasks.length) {
      setGoogleCalendarError(null);
      setGoogleCalendarNotice("동기화할 오늘 이후 미완료 일정이 없습니다.");
      setStatus("동기화할 오늘 이후 미완료 일정이 없습니다.");
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

    let syncTimeZone = googleCalendarConnection.timeZone || detectedGoogleCalendarTimeZone();
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    let firstFailure: unknown = null;
    let cancelled = false;
    const progressInterval = Math.max(1, Math.ceil(eligibleTasks.length / 20));
    const updateBulkProgress = (completed: number) => {
      if (completed === eligibleTasks.length || completed % progressInterval === 0) {
        setGoogleCalendarProgress({ completed, total: eligibleTasks.length });
      }
    };

    try {
      const currentConnection = await refreshGoogleCalendarStatus(false, false, abortController.signal);

      if (googleCalendarUiEpochRef.current !== uiEpoch || abortController.signal.aborted) {
        return;
      }
      if (!currentConnection.connected || currentConnection.needsReconnect) {
        throw new GoogleCalendarError("not_connected", "Google Calendar 계정을 먼저 연결해주세요.");
      }
      syncTimeZone = currentConnection.timeZone || syncTimeZone;

      for (let index = 0; index < eligibleTasks.length; index += 1) {
        const task = eligibleTasks[index];

        if (googleCalendarUiEpochRef.current !== uiEpoch || abortController.signal.aborted) {
          cancelled = true;
          break;
        }

        try {
          if (!await scheduleTaskRevisionIsCurrent(task)) {
            skipped += 1;
            updateBulkProgress(index + 1);
            continue;
          }

          const result = await upsertGoogleCalendarTaskWithRetry(
            googleCalendarTaskFromDecrypted(task),
            2,
            syncTimeZone,
            abortController.signal
          );
          await recordGoogleCalendarTaskSyncReceipt(
            googleCalendarTaskFromDecrypted(task),
            currentConnection
          );
          if (result.outcome === "skipped") {
            skipped += 1;
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
          firstFailure ??= caught;

          if (googleCalendarBatchShouldStop(caught)) {
            failed += eligibleTasks.length - index - 1;
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
          const failureMessage = `${succeeded}개는 반영했고 ${failed}개는 반영하지 못한 상태에서 동기화를 중단했습니다.${skipped ? ` 변경된 ${skipped}개는 건너뛰었습니다.` : ""} ${googleCalendarErrorMessage(failure)}`;

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
            ? `${succeeded}개 일정을 반영한 뒤 기존 일정 동기화를 중단했습니다.${skipped ? ` 변경된 ${skipped}개는 건너뛰었습니다.` : ""}`
            : `기존 일정 동기화를 중단했습니다.${skipped ? ` 변경된 ${skipped}개는 건너뛰었습니다.` : ""}`;

          if (succeeded > 0) {
            updateGoogleCalendarSyncSuccess(succeeded, false);
            void reportGoogleCalendarSync({ status: "synced", syncedCount: succeeded }).catch(() => undefined);
          } else {
            setGoogleCalendarError(null);
          }
          setGoogleCalendarNotice(cancellationMessage);
          setStatus(cancellationMessage);
          setError(null);
        }
      } else if (failed === 0) {
        updateGoogleCalendarSyncSuccess(succeeded, false);
        void reportGoogleCalendarSync({ status: "synced", syncedCount: succeeded }).catch(() => undefined);
        setGoogleCalendarNotice(null);
        setStatus(skipped
          ? `${succeeded}개 일정을 동기화하고, 실행 중 변경된 ${skipped}개는 안전하게 건너뛰었습니다.`
          : `${succeeded}개 일정을 Google Calendar에 동기화했습니다.`);
        setError(null);
      } else {
        const failure = firstFailure ?? new GoogleCalendarError("unknown_error", "일부 일정을 동기화하지 못했습니다.");

        await updateGoogleCalendarSyncFailure(failure, succeeded, false);
        await reportGoogleCalendarSync({
          failureCode: googleCalendarErrorCode(failure),
          status: "failed",
          syncedCount: succeeded
        }).catch(() => undefined);
        const failureMessage = `${succeeded}개는 반영했고 ${failed}개는 반영하지 못했습니다.${skipped ? ` 변경된 ${skipped}개는 건너뛰었습니다.` : ""} ${googleCalendarErrorMessage(failure)}`;

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
            setGoogleCalendarConnection(nextStatus);
            googleCalendarOperationRef.current = null;
            setGoogleCalendarOperation(null);
            setGoogleCalendarError(null);

            if (syncExisting) {
              await syncExistingGoogleCalendarTasks();
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

  function enqueueRecurringCheckInWrite<TResult>(queueKey: string, write: () => Promise<TResult>) {
    const previousWrite = recurringCheckInWriteQueueRef.current.get(queueKey) ?? Promise.resolve();
    const queuedWrite = previousWrite.catch(() => undefined).then(write);

    recurringCheckInWriteQueueRef.current.set(queueKey, queuedWrite);
    void queuedWrite.then(
      () => {
        if (recurringCheckInWriteQueueRef.current.get(queueKey) === queuedWrite) {
          recurringCheckInWriteQueueRef.current.delete(queueKey);
        }
      },
      () => {
        if (recurringCheckInWriteQueueRef.current.get(queueKey) === queuedWrite) {
          recurringCheckInWriteQueueRef.current.delete(queueKey);
        }
      }
    );
    return queuedWrite;
  }

  async function encryptTaskFields(title: string, details: ScheduleTaskDetails, taskKey: CryptoKey) {
    return Promise.all([
      encryptText(title.trim() || "제목 없음", taskKey),
      encryptText(JSON.stringify(details), taskKey)
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
        description: draft.description,
        checklist: draft.checklist
          .map((item) => ({ ...item, text: item.text.trim() }))
          .filter((item) => item.text)
      };
      const [encryptedTitle, encryptedDetails] = await encryptTaskFields(trimmedTitle, details, taskKey);
      const wrappedKey = await wrapNoteKey(taskKey, unlockedProfile.publicKeyJwk);

      const createdTask = await createScheduleTask({
        ownerUid: unlockedProfile.uid,
        title: encryptedTitle,
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
      const calendarWarning = createdTask?.id
        ? await syncGoogleCalendarTaskAfterSave(
          createdTask.id
        )
        : null;

      if (calendarWarning) {
        setStatus(null);
        setError(calendarWarning);
      } else {
        setStatus("일정을 추가했습니다.");
        setError(null);
      }
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

  async function saveTask(task: DecryptedScheduleTask, draft: TaskDraft) {
    const wrappedKey = task.wrappedKeys[unlockedProfile.uid];

    if (!wrappedKey) {
      setError("일정 암호화 키를 찾지 못했습니다.");
      return;
    }

    try {
      const taskKey = await unwrapNoteKey(wrappedKey, unlockedPrivateKey);
      const normalizedTitle = draft.title.trim() || "제목 없음";
      const titleChanged = normalizedTitle !== task.title;
      const details: ScheduleTaskDetails = {
        description: draft.description,
        checklist: draft.checklist
          .map((item) => ({ ...item, text: item.text.trim() }))
          .filter((item) => item.text)
      };
      const [encryptedTitle, encryptedDetails] = await Promise.all([
        titleChanged ? encryptText(normalizedTitle, taskKey) : Promise.resolve(task.encryptedTitle),
        encryptText(JSON.stringify(details), taskKey)
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
        return;
      }

      await updateScheduleTask(task.id, unlockedProfile.uid, {
        ...(titleChanged ? { encryptedTitle } : {}),
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
      }, { googleCalendarChanged });
      setEditingTaskId(null);
      setViewTaskId(null);
      const calendarWarning = googleCalendarChanged
        ? await syncGoogleCalendarTaskAfterSave(
          task.id,
          Boolean(taskStartDate(task))
        )
        : null;

      if (calendarWarning) {
        setStatus(null);
        setError(calendarWarning);
      } else {
        setStatus("일정을 저장했습니다.");
        setError(null);
      }
    } catch (caught) {
      setError(scheduleActionError(caught, "일정을 저장하지 못했습니다."));
    }
  }

  function currentTaskDetails(task: DecryptedScheduleTask) {
    return decryptedTasksRef.current.find((currentTask) => currentTask.id === task.id)?.details ?? task.details ?? emptyScheduleDetails;
  }

  async function scheduleTaskRevisionIsCurrent(task: DecryptedScheduleTask) {
    try {
      const latestTask = await getScheduleTask(task.id);
      const previousRevision = googleCalendarTaskRevisionTimestamp(task);
      const latestRevision = latestTask ? googleCalendarTaskRevisionTimestamp(latestTask) : null;

      return Boolean(
        latestTask
        && latestTask.id === task.id
        && latestTask.ownerUid === unlockedProfile.uid
        && latestTask.status === task.status
        && previousRevision
        && latestRevision
        && previousRevision.seconds === latestRevision.seconds
        && previousRevision.nanoseconds === latestRevision.nanoseconds
      );
    } catch {
      return false;
    }
  }

  async function latestTaskDetails(task: DecryptedScheduleTask, taskKey: CryptoKey, fallback: ScheduleTaskDetails) {
    try {
      const latestTask = await getScheduleTask(task.id);

      if (!latestTask || latestTask.ownerUid !== unlockedProfile.uid) {
        return fallback;
      }

      const latestDetailsJson = await decryptText(latestTask.encryptedDetails, taskKey);
      return normalizeScheduleDetails(JSON.parse(latestDetailsJson) as unknown);
    } catch {
      return fallback;
    }
  }

  function normalizeMutableTaskDetails(details: ScheduleTaskDetails): ScheduleTaskDetails {
    const normalizedDetails = normalizeScheduleDetails(details);

    return {
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

    const queuedUpdate = taskDetailsUpdateQueueRef.current[task.id];
    const previousUpdate = queuedUpdate ?? Promise.resolve(currentTaskDetails(task));
    const nextUpdate = previousUpdate
      .catch(() => currentTaskDetails(task))
      .then(async (queuedDetails) => {
        const taskKey = await unwrapNoteKey(wrappedKey, unlockedPrivateKey);
        const baseDetails = queuedUpdate ? queuedDetails : await latestTaskDetails(task, taskKey, queuedDetails);
        const nextDetails = normalizeMutableTaskDetails(updateDetails(baseDetails));
        const encryptedDetails = await encryptText(JSON.stringify(nextDetails), taskKey);

        await updateScheduleTask(task.id, unlockedProfile.uid, { encryptedDetails });
        return nextDetails;
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
      const [encryptedTitle, encryptedDetails] = await encryptTaskFields(task.title, copiedDetails, taskKey);
      const wrappedKey = await wrapNoteKey(taskKey, unlockedProfile.publicKeyJwk);

      const copiedTask = await createScheduleTask({
        ownerUid: unlockedProfile.uid,
        title: encryptedTitle,
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
      const calendarWarning = copiedTask?.id
        ? await syncGoogleCalendarTaskAfterSave(copiedTask.id)
        : null;

      if (calendarWarning) {
        setStatus(null);
        setError(calendarWarning);
      } else {
        setStatus("일정을 복사했습니다.");
        setError(null);
      }
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

    try {
      await updateScheduleTask(task.id, unlockedProfile.uid, updateInput);
      const movedDate = moveToToday ? today : moveToFirstPriority ? firstPriorityDate : null;
      const calendarWarning = movedDate
        ? await syncGoogleCalendarTaskAfterSave(task.id, Boolean(taskStartDate(task)))
        : null;

      if (calendarWarning) {
        setStatus(null);
        setError(calendarWarning);
      } else {
        setStatus("업무 위치를 변경했습니다.");
        setError(null);
      }
    } catch (caught) {
      setError(scheduleActionError(caught, "업무 위치를 변경하지 못했습니다."));
    }
  }

  async function reorderTasksWithinDate(activeTaskId: string, overTaskId: string) {
    const updates = buildScheduleTaskOrderUpdates(sortedTasks, activeTaskId, overTaskId);

    if (updates == null) {
      setError("동일한 날짜 내에서만 순서를 변경할 수 있습니다.");
      return;
    }

    if (!updates.length) {
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

  function requestTaskDeletion(task: DecryptedScheduleTask) {
    if (taskDeletionPending) {
      return;
    }

    setTaskDeletionError(null);
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
            currentConnection.connectionGeneration
          );
          deletionTimeZone = currentConnection.timeZone || deletionTimeZone;
          await deleteGoogleCalendarTaskWithAuthorityReconciliation(
            googleCalendarTaskFromDecrypted(task),
            0,
            deletionTimeZone,
            undefined,
            0,
            (remoteWasPresent) => {
              deletedGoogleEvent = remoteWasPresent;
            },
            deletionWorkflow
          );
        } catch (caught) {
          let tombstoneCleared = false;
          let googleRestoreFailed = false;
          const remoteDeletionIsAmbiguous = caught instanceof GoogleCalendarError
            && caught.mutationMayHaveApplied;

          if (deletedGoogleEvent) {
            try {
              const latestTask = await authoritativeGoogleCalendarTask(task.id);

              if (latestTask) {
                await upsertGoogleCalendarTask(
                  latestTask,
                  deletionTimeZone,
                  undefined,
                  deletionWorkflow ?? undefined
                );
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

      if (deletionWorkflow) {
        // Revalidate the account-bound workflow immediately before the local
        // delete. If the browser slept or the lease expired, keep the task and
        // restore its Google event instead of crossing account generations.
        await renewGoogleCalendarDeletionWorkflow(deletionWorkflow);
      }
      await deleteScheduleTask(task.id);
      localTaskDeleted = true;
      let googleCleanupWarning: string | null = null;

      if (shouldDeleteFromGoogle) {
        try {
          await deleteGoogleCalendarTaskWithAuthorityReconciliation(
            googleCalendarTaskFromDecrypted(task),
            0,
            deletionTimeZone,
            undefined,
            0,
            undefined,
            deletionWorkflow ?? undefined
          );
          updateGoogleCalendarSyncSuccess(1);
        } catch (caught) {
          await updateGoogleCalendarSyncFailure(caught);
          googleCleanupWarning = `QuickMemo 일정은 삭제했지만 Google Calendar의 삭제 상태를 다시 확인하지 못했습니다. 삭제 보호 상태를 유지하고 연결이 복구되면 다시 확인합니다. ${googleCalendarErrorMessage(caught)}`;
        }
      }
      if (deletionTombstone && !googleCleanupWarning) {
        try {
          const tombstoneCleared = await cancelGoogleCalendarTaskDeletion(
            deletionTombstone.ownerUid,
            deletionTombstone.taskId,
            deletionTombstone.deletionAttemptId
          );

          if (tombstoneCleared) {
            deletionTombstone = null;
          } else {
            googleCleanupWarning = googleCleanupWarning
              ?? "일정은 삭제했지만 삭제 보호 상태를 정리하지 못했습니다.";
          }
        } catch {
          googleCleanupWarning = googleCleanupWarning
            ?? "일정은 삭제했지만 삭제 보호 상태를 정리하지 못했습니다.";
        }
      }
      setDeleteConfirmationTask(null);
      setEditingTaskId(null);
      setViewTaskId(null);
      setStatus(googleCleanupWarning ? null : "일정을 삭제했습니다.");
      setError(googleCleanupWarning);
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

              if (latestGoogleTask) {
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

  async function encryptRecurringHabitFields(title: string, details: RecurringHabitDetails, habitKey: CryptoKey) {
    const normalizedDetails = normalizeMutableRecurringHabitDetails(details);
    const validationError = recurringHabitTitleValidationError(title)
      ?? recurringHabitDetailsValidationError(normalizedDetails);

    if (validationError) {
      throw new Error(validationError);
    }

    return Promise.all([
      encryptText(title.trim() || "반복 업무", habitKey),
      encryptText(JSON.stringify(normalizedDetails), habitKey)
    ]);
  }

  function currentRecurringHabitDetails(habit: DecryptedRecurringHabit) {
    return decryptedRecurringHabitsRef.current.find((currentHabit) => currentHabit.id === habit.id)?.details
      ?? habit.details
      ?? { description: "", checklist: [] };
  }

  function normalizeMutableRecurringHabitDetails(details: unknown): RecurringHabitDetails {
    const normalizedDetails = normalizeRecurringHabitDetails(details);

    return {
      description: normalizedDetails.description,
      checklist: normalizedDetails.checklist
        .map((item) => ({ ...item, text: item.text.trim(), checked: false }))
        .filter((item) => item.text)
    };
  }

  async function updateRecurringHabitDetails(
    habit: DecryptedRecurringHabit,
    updateDetails: RecurringHabitDetailsUpdater,
    fallback: string
  ) {
    const wrappedKey = habit.wrappedKeys[unlockedProfile.uid];

    if (!wrappedKey) {
      setError("반복 업무 암호화 키를 찾지 못했습니다.");
      return false;
    }

    const queuedUpdate = recurringDetailsUpdateQueueRef.current[habit.id];
    const previousUpdate = queuedUpdate ?? Promise.resolve(currentRecurringHabitDetails(habit));
    const nextUpdate = previousUpdate
      .catch(() => currentRecurringHabitDetails(habit))
      .then(() => updateRecurringHabitFromLatest(
        habit.id,
        unlockedProfile.uid,
        async (latestHabit) => {
          const latestWrappedKey = latestHabit.wrappedKeys[unlockedProfile.uid];

          if (!latestWrappedKey) {
            throw new Error("반복 업무 암호화 키를 찾지 못했습니다.");
          }

          const habitKey = await unwrapNoteKey(latestWrappedKey, unlockedPrivateKey);
          const latestDetailsJson = await decryptText(latestHabit.encryptedDetails, habitKey);
          const latestDetails = normalizeMutableRecurringHabitDetails(JSON.parse(latestDetailsJson) as unknown);
          const nextDetails = normalizeMutableRecurringHabitDetails(updateDetails(latestDetails));
          const validationError = recurringHabitDetailsValidationError(nextDetails);

          if (validationError) {
            throw new Error(validationError);
          }

          const encryptedDetails = await encryptText(JSON.stringify(nextDetails), habitKey);

          return {
            input: { encryptedDetails },
            result: nextDetails
          };
        }
      ));

    recurringDetailsUpdateQueueRef.current[habit.id] = nextUpdate;

    try {
      await nextUpdate;
      setError(null);
      return true;
    } catch (caught) {
      setError(scheduleActionError(caught, fallback));
      return false;
    } finally {
      if (recurringDetailsUpdateQueueRef.current[habit.id] === nextUpdate) {
        delete recurringDetailsUpdateQueueRef.current[habit.id];
      }
    }
  }

  async function createRecurringHabitFromDraft(draft: RecurringHabitDraft) {
    const trimmedTitle = draft.title.trim();
    const validationError = recurringHabitTitleValidationError(trimmedTitle)
      ?? recurringHabitDetailsValidationError({ description: draft.description, checklist: [] });

    if (validationError) {
      setError(validationError);
      return false;
    }

    try {
      const habitKey = await generateNoteKey();
      const [encryptedTitle, encryptedDetails] = await encryptRecurringHabitFields(
        trimmedTitle,
        { description: draft.description, checklist: [] },
        habitKey
      );
      const wrappedKey = await wrapNoteKey(habitKey, unlockedProfile.publicKeyJwk);
      const createdHabit = await createRecurringHabit({
        ownerUid: unlockedProfile.uid,
        title: encryptedTitle,
        details: encryptedDetails,
        wrappedKey,
        slot: draft.slot,
        icon: draft.icon,
        color: normalizeScheduleTaskColor(draft.color),
        sortOrder: nextRecurringHabitSortOrder(decryptedRecurringHabits, draft.slot)
      });

      setViewRecurringHabitId(createdHabit.id);
      setStatus("반복 업무를 추가했습니다.");
      setError(null);
      return true;
    } catch (caught) {
      setError(scheduleActionError(caught, "반복 업무를 추가하지 못했습니다."));
      return false;
    }
  }

  async function saveRecurringHabit(habit: DecryptedRecurringHabit, draft: RecurringHabitDraft) {
    const wrappedKey = habit.wrappedKeys[unlockedProfile.uid];

    if (!wrappedKey) {
      setError("반복 업무 암호화 키를 찾지 못했습니다.");
      return false;
    }

    const validationError = recurringHabitTitleValidationError(draft.title)
      ?? recurringHabitDetailsValidationError({
        description: draft.description,
        checklist: currentRecurringHabitDetails(habit).checklist
      });

    if (validationError) {
      setError(validationError);
      return false;
    }

    try {
      await updateRecurringHabitFromLatest(
        habit.id,
        unlockedProfile.uid,
        async (latestHabit) => {
          const latestWrappedKey = latestHabit.wrappedKeys[unlockedProfile.uid];

          if (!latestWrappedKey) {
            throw new Error("반복 업무 암호화 키를 찾지 못했습니다.");
          }

          const habitKey = await unwrapNoteKey(latestWrappedKey, unlockedPrivateKey);
          const latestDetailsJson = await decryptText(latestHabit.encryptedDetails, habitKey);
          const currentDetails = normalizeMutableRecurringHabitDetails(JSON.parse(latestDetailsJson) as unknown);
          const [encryptedTitle, encryptedDetails] = await encryptRecurringHabitFields(
            draft.title,
            { description: draft.description, checklist: currentDetails.checklist },
            habitKey
          );

          return {
            input: {
              encryptedTitle,
              encryptedDetails,
              slot: draft.slot,
              icon: draft.icon,
              color: normalizeScheduleTaskColor(draft.color)
            },
            result: null
          };
        }
      );
      setRecurringHabitDialog(null);
      setStatus("반복 업무를 저장했습니다.");
      setError(null);
      return true;
    } catch (caught) {
      setError(scheduleActionError(caught, "반복 업무를 저장하지 못했습니다."));
      return false;
    }
  }

  async function removeRecurringHabit(habit: DecryptedRecurringHabit) {
    setPendingRecurringDeletion((current) => ({ ...current, [habit.id]: true }));

    try {
      await deleteRecurringHabit(habit.id, unlockedProfile.uid);
      setRecurringHabitDialog(null);
      setViewRecurringHabitId(null);
      setReadRecurringHabitId(null);
      setStatus("반복 업무를 삭제했습니다.");
      setError(null);
    } catch (caught) {
      setError(scheduleActionError(caught, "반복 업무를 삭제하지 못했습니다."));
    } finally {
      setPendingRecurringDeletion((current) => {
        const next = { ...current };
        delete next[habit.id];
        return next;
      });
    }
  }

  async function moveRecurringHabit(activeHabitId: string, targetSlot: RecurringHabitSlot, overHabitId: string | null) {
    const updates = buildRecurringHabitOrderUpdates(decryptedRecurringHabits, activeHabitId, targetSlot, overHabitId);

    if (!updates.length) {
      return;
    }

    try {
      await updateRecurringHabitOrderBatch(unlockedProfile.uid, updates);
      setStatus("반복 업무 위치를 저장했습니다.");
      setError(null);
    } catch (caught) {
      setError(scheduleActionError(caught, "반복 업무 위치를 저장하지 못했습니다."));
    }
  }

  async function toggleRecurringHabitCheckIn(habit: DecryptedRecurringHabit, date: string) {
    if (!isValidScheduleDateString(date) || date > today) {
      setError("오늘 또는 지난 날짜만 체크할 수 있습니다.");
      return;
    }

    const checkInId = recurringCheckInId(habit.id, date);
    const checked = isHabitCheckedOn(recurringCheckIns, habit.id, date);
    const nextChecked = !checked;
    const previousCheckIn = recurringCheckIns.find(
      (checkIn) => checkIn.habitId === habit.id && checkIn.date === date
    ) ?? null;
    const operation = Symbol(checkInId);
    const startingSnapshotRevision = recurringCheckInSnapshotRevisionRef.current;

    recurringCheckInOperationRef.current.set(checkInId, operation);
    setPendingRecurringCheckIn((current) => ({ ...current, [checkInId]: true }));
    setRecurringCheckIns((current) => {
      if (!nextChecked) {
        return replaceRecurringCheckInSnapshot(current, habit.id, date, null);
      }

      const existing = current.find((checkIn) => checkIn.habitId === habit.id && checkIn.date === date);
      return replaceRecurringCheckInSnapshot(
        current,
        habit.id,
        date,
        {
          ...(existing ?? {}),
          id: checkInId,
          ownerUid: unlockedProfile.uid,
          habitId: habit.id,
          date,
          completed: true,
          progressPercent: 100,
          checkedItemIds: existing?.checkedItemIds ?? []
        }
      );
    });

    try {
      await enqueueRecurringCheckInWrite(
        `${unlockedProfile.uid}:${checkInId}`,
        () => setRecurringHabitCheckIn(unlockedProfile.uid, habit.id, date, nextChecked)
      );

      if (recurringCheckInOperationRef.current.get(checkInId) === operation) {
        setError(null);
      }
    } catch (caught) {
      if (recurringCheckInOperationRef.current.get(checkInId) === operation) {
        if (recurringCheckInSnapshotRevisionRef.current === startingSnapshotRevision) {
          setRecurringCheckIns((current) => replaceRecurringCheckInSnapshot(
            current,
            habit.id,
            date,
            previousCheckIn
          ));
        }
        setError(scheduleActionError(caught, "반복 체크인을 저장하지 못했습니다."));
      }
    } finally {
      if (recurringCheckInOperationRef.current.get(checkInId) === operation) {
        recurringCheckInOperationRef.current.delete(checkInId);
        setPendingRecurringCheckIn((current) => {
          const next = { ...current };
          delete next[checkInId];
          return next;
        });
      }
    }
  }

  async function updateRecurringHabitDailyState(
    habit: DecryptedRecurringHabit,
    date: string,
    input: UpdateRecurringHabitDayStateInput
  ) {
    if (!isValidScheduleDateString(date) || date > today) {
      setError("오늘 또는 지난 날짜만 수정할 수 있습니다.");
      return false;
    }

    const checkInId = recurringCheckInId(habit.id, date);
    const previousCheckIn = recurringCheckIns.find(
      (checkIn) => checkIn.habitId === habit.id && checkIn.date === date
    ) ?? null;
    const operation = Symbol(checkInId);
    const startingSnapshotRevision = recurringCheckInSnapshotRevisionRef.current;

    recurringCheckInOperationRef.current.set(checkInId, operation);
    setPendingRecurringCheckIn((current) => ({ ...current, [checkInId]: true }));
    setRecurringCheckIns((current) => {
      const existing = current.find((checkIn) => checkIn.habitId === habit.id && checkIn.date === date);
      const nextState: RecurringHabitCheckInSnapshot = {
        ...(existing ?? {}),
        id: checkInId,
        ownerUid: unlockedProfile.uid,
        habitId: habit.id,
        date,
        ...(input.checkedItemIds !== undefined ? { checkedItemIds: input.checkedItemIds } : {}),
        ...(input.completed !== undefined ? { completed: input.completed } : {}),
        ...(input.progressPercent !== undefined ? { progressPercent: input.progressPercent } : {})
      };

      if (existing) {
        return current.map((checkIn) =>
          checkIn.habitId === habit.id && checkIn.date === date ? nextState : checkIn
        );
      }

      return [...current, nextState];
    });

    try {
      const committedState = await enqueueRecurringCheckInWrite(
        `${unlockedProfile.uid}:${checkInId}`,
        () => updateRecurringHabitDayState(unlockedProfile.uid, habit.id, date, input)
      );

      if (
        recurringCheckInOperationRef.current.get(checkInId) === operation
        && recurringCheckInSnapshotRevisionRef.current === startingSnapshotRevision
      ) {
        setRecurringCheckIns((current) => {
          const existing = current.find((checkIn) => checkIn.habitId === habit.id && checkIn.date === date);

          return replaceRecurringCheckInSnapshot(current, habit.id, date, {
            ...(existing ?? {}),
            id: checkInId,
            ownerUid: unlockedProfile.uid,
            habitId: habit.id,
            date,
            ...committedState
          });
        });
      }
      if (recurringCheckInOperationRef.current.get(checkInId) === operation) {
        setError(null);
      }
      return true;
    } catch (caught) {
      if (recurringCheckInOperationRef.current.get(checkInId) === operation) {
        if (recurringCheckInSnapshotRevisionRef.current === startingSnapshotRevision) {
          setRecurringCheckIns((current) => replaceRecurringCheckInSnapshot(
            current,
            habit.id,
            date,
            previousCheckIn
          ));
        }
        setError(scheduleActionError(caught, "반복 업무 진행 상태를 저장하지 못했습니다."));
      }
      return false;
    } finally {
      if (recurringCheckInOperationRef.current.get(checkInId) === operation) {
        recurringCheckInOperationRef.current.delete(checkInId);
        setPendingRecurringCheckIn((current) => {
          const next = { ...current };
          delete next[checkInId];
          return next;
        });
      }
    }
  }

  async function updateRecurringHabitProgress(habit: DecryptedRecurringHabit, date: string, percent: number) {
    const progressPercent = normalizeTaskProgressPercent(percent);

    await updateRecurringHabitDailyState(habit, date, {
      completed: progressPercent >= 100,
      progressPercent
    });
  }

  async function toggleRecurringHabitChecklistItem(habit: DecryptedRecurringHabit, date: string, itemId: string) {
    const checklist = habit.details.checklist;
    const currentCheckedIds = recurringHabitDayCheckedItemIds(recurringCheckIns, habit.id, date);
    const nextCheckedIds = new Set(currentCheckedIds);

    if (nextCheckedIds.has(itemId)) {
      nextCheckedIds.delete(itemId);
    } else {
      nextCheckedIds.add(itemId);
    }

    const checkedItemIds = checklist
      .filter((item) => nextCheckedIds.has(item.id))
      .map((item) => item.id);
    const progressPercent = checklist.length ? Math.round((checkedItemIds.length / checklist.length) * 100) : 0;

    await updateRecurringHabitDailyState(habit, date, {
      checkedItemIds,
      completed: checklist.length > 0 && progressPercent >= 100,
      progressPercent,
      toggleCheckedItem: {
        allowedItemIds: checklist.map((item) => item.id),
        itemId
      }
    });
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

  function toggleTodayWorkPanel() {
    if (todayPanelOpen) {
      closeTodayWorkPanel(false);
      return;
    }

    const nextToday = refreshToday();
    const nextDate = new Date(`${nextToday}T00:00:00`);

    setScheduleToolsOpen(false);
    setCalendarCursor(new Date(nextDate.getFullYear(), nextDate.getMonth(), 1));
    setSelectedCalendarDate(nextToday);
    setSelectedRecurringDate(nextToday);
    setRecurringMonth(nextToday.slice(0, 7));
    setTodayPanelOpen(true);
  }

  function openQuickTaskDialog() {
    const currentToday = refreshToday();

    setScheduleToolsOpen(false);

    if (activeView === "matrix") {
      setCreateDialog({
        defaults: { startDate: currentToday, endDate: currentToday, color: nextScheduleTaskColor(decryptedTasks), isImportant: true, isUrgent: true },
        title: "매트릭스 일정 추가"
      });
      return;
    }

    if (activeView === "calendar") {
      openCalendarCreateDialog(selectedCalendarDate);
      return;
    }

    setCreateDialog({
      defaults: { startDate: currentToday, endDate: currentToday, color: nextScheduleTaskColor(decryptedTasks) },
      title: "새 일정 추가"
    });
  }

  function openScheduleTab(view: PrimaryScheduleView) {
    setScheduleToolsOpen(false);
    setTodayPanelOpen(false);
    navigate(scheduleViewHref(view));
  }

  function openScheduleUtilityView(view: Extract<ScheduleView, "completed">) {
    setScheduleToolsOpen(false);
    navigate(scheduleViewHref(view));
  }

  function openCalendarCreateDialog(dateString: string) {
    setSelectedCalendarDate(dateString);
    setCreateDialog({
      defaults: { startDate: dateString, endDate: dateString, color: nextScheduleTaskColor(decryptedTasks) },
      title: `${formatDateLabel(dateString)} 일정 추가`
    });
  }

  function openMatrixCreateDialog(section: MatrixSection) {
    const currentToday = refreshToday();
    const defaultDate = section.key === "firstPriority" ? addDays(currentToday, 1) : currentToday;

    setCreateDialog({
      allowPriority: false,
      defaults: {
        startDate: defaultDate,
        endDate: defaultDate,
        color: nextScheduleTaskColor(decryptedTasks),
        isImportant: section.isImportant,
        isUrgent: section.isUrgent
      },
      title: `${section.label} 일정 추가`
    });
  }

  const todayPanelToggleLabel = `${todayPanelOpen ? "빠른 업무 패널 닫기" : "빠른 업무 패널 열기"}. 오늘 일정 ${scheduleStats.today}개, 지연 ${scheduleStats.overdue}개`;
  const utilityViewActive = activeView === "completed";
  const scheduleToolsLabel = scheduleToolsOpen ? "일정관리 도구 닫기" : "일정관리 도구 열기";
  const googleCalendarStateLabel = googleCalendarConnection.lastSyncStatus === "synced"
    ? "동기화 완료"
    : googleCalendarConnection.lastSyncStatus === "failed"
      ? "동기화 실패"
      : "미동기화";
  const searchResultCount = isRecurringPage
    ? displayedRecurringHabits.length
    : activeView === "completed"
      ? completedTasks.length
      : displayedTasks.length;

  return (
    <AppShell>
      {!isRecurringPage && (
        <GoogleCalendarRecoveryWorker
          connection={googleCalendarConnection}
          onFailure={(caught) => updateGoogleCalendarSyncFailure(caught)}
          onSuccess={(syncedCount) => updateGoogleCalendarSyncSuccess(syncedCount)}
          ownerUid={unlockedProfile.uid}
          paused={Boolean(googleCalendarOperation)}
          scheduleTasksLoaded={scheduleTasksLoaded}
          tasks={decryptedTasks}
        />
      )}
      <section className="schedule-workspace">
        <header className="schedule-header">
          <div>
            <p className="section-kicker">
              <CalendarDays size={16} />
              일정관리
            </p>
            <h1>{activeView ? scheduleViewTitles[activeView] : "일정관리"}</h1>
          </div>
          <label className="schedule-search-control">
            <Search size={17} aria-hidden="true" />
            <span className="sr-only">{isRecurringPage ? "반복 업무 검색" : "일정 검색"}</span>
            <input
              aria-label={isRecurringPage ? "반복 업무 검색" : "일정 검색"}
              onChange={(event) => setScheduleQuery(event.target.value)}
              placeholder={isRecurringPage ? "반복 업무, 설명, 체크리스트 검색" : "일정, 설명, 체크리스트 검색"}
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
            {!isRecurringPage && (
              <button
                aria-haspopup="dialog"
                aria-label={`Google Calendar 동기화: ${googleCalendarStateLabel}`}
                className="icon-button google-calendar-trigger"
                data-sync-state={googleCalendarConnection.lastSyncStatus}
                onClick={openGoogleCalendarDialog}
                title={`Google Calendar · ${googleCalendarStateLabel}`}
                type="button"
              >
                <CalendarSync size={17} aria-hidden="true" />
                <span className="google-calendar-trigger-status" aria-hidden="true" />
              </button>
            )}
            {!isRecurringPage && (
              <button
                ref={todayWorkTriggerRef}
                className={`icon-button today-work-trigger ${todayPanelOpen ? "active" : ""}`}
                type="button"
                aria-controls={todayPanelId}
                aria-expanded={todayPanelOpen}
                aria-label={todayPanelToggleLabel}
                title="오늘 업무"
                onClick={toggleTodayWorkPanel}
              >
                <Zap size={16} />
              </button>
            )}
            <button
              className="schedule-primary-action"
              type="button"
              onClick={isRecurringPage ? () => setRecurringHabitDialog({ mode: "create" }) : openQuickTaskDialog}
            >
              <Plus size={16} />
              {isRecurringPage ? "새 반복 업무" : "새 일정"}
            </button>
            <div className="schedule-tool-menu" ref={scheduleToolsRef}>
              <button
                ref={scheduleToolsTriggerRef}
                className={`icon-button schedule-tool-menu-trigger ${scheduleToolsOpen || utilityViewActive ? "active" : ""}`}
                type="button"
                aria-controls={scheduleToolsPopoverId}
                aria-current={utilityViewActive && !scheduleToolsOpen ? "page" : undefined}
                aria-expanded={scheduleToolsOpen}
                aria-label={scheduleToolsLabel}
                title={utilityViewActive ? scheduleViewTitles[activeView] : "일정관리 도구"}
                onClick={() => setScheduleToolsOpen((current) => !current)}
              >
                <MoreHorizontal size={18} />
              </button>
              {scheduleToolsOpen && (
                <div id={scheduleToolsPopoverId} className="schedule-tool-menu-popover" role="group" aria-label="일정관리 도구">
                  <button className="schedule-quick-menu-item" type="button" onClick={() => openScheduleUtilityView("completed")}>
                    <CheckCircle2 size={16} />
                    <span>
                      <strong>완료 내역</strong>
                      <em>완료한 일정과 필터 확인</em>
                    </span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        {!isRecurringPage && todayPanelOpen && (
          <TodayWorkPanel
            checkIns={recurringCheckIns}
            id={todayPanelId}
            panelRef={todayPanelRef}
            pendingCheckIns={pendingRecurringCheckIn}
            summary={todayWorkSummary}
            today={today}
            onAddTask={() => {
              setTodayPanelOpen(false);
              setCreateDialog({
                defaults: { startDate: today, endDate: today, color: nextScheduleTaskColor(decryptedTasks) },
                title: "오늘 일정 추가"
              });
            }}
            onClose={() => closeTodayWorkPanel()}
            onOpenHabit={(habitId) => {
              setReadRecurringHabitId(habitId);
              setTodayPanelOpen(false);
            }}
            onOpenTask={(taskId) => {
              setViewTaskId(taskId);
              setTodayPanelOpen(false);
            }}
            onToggleHabit={(habit) => void toggleRecurringHabitCheckIn(habit, today)}
            onToggleTask={(task) => void toggleTask(task)}
          />
        )}

        {(error || status) && (
          <div className={`schedule-feedback ${error ? "error" : ""}`} role="status">
            {error || status}
          </div>
        )}

        {!activeView && <p className="schedule-empty">설정한 일정 화면을 여는 중입니다.</p>}

        {activeView === "todo" && (
          <TodoView groups={todoGroups} today={today} onOpen={setViewTaskId} onToggle={(task) => void toggleTask(task)} />
        )}

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
          />
        )}

        {activeView === "recurring" && (
          <RecurringView
            checkIns={recurringCheckIns}
            habits={displayedRecurringHabits}
            month={recurringMonth}
            pendingDeletions={pendingRecurringDeletion}
            pendingDeletionHabits={pendingDeletionHabits}
            pendingCheckIns={pendingRecurringCheckIn}
            selectedDate={selectedRecurringDate}
            selectedHabit={selectedRecurringHabit}
            today={today}
            onAdd={() => setRecurringHabitDialog({ mode: "create" })}
            onCloseHabit={() => setViewRecurringHabitId(null)}
            onDeleteHabit={(habit) => void removeRecurringHabit(habit)}
            onEditHabit={(habit) => setRecurringHabitDialog({ habitId: habit.id, mode: "edit" })}
            onMonthChange={setRecurringMonth}
            onMoveHabit={(habitId, targetSlot, overHabitId) => void moveRecurringHabit(habitId, targetSlot, overHabitId)}
            onOpenHabit={setViewRecurringHabitId}
            onReadHabit={setReadRecurringHabitId}
            onOpenOverview={() => setRecurringOverviewOpen(true)}
            onRetryDelete={(habit) => void removeRecurringHabit(habit)}
            onSelectDate={(date) => {
              setSelectedRecurringDate(date);
              setRecurringMonth(date.slice(0, 7));
            }}
            onToggleCheckIn={(habit, date) => void toggleRecurringHabitCheckIn(habit, date)}
          />
        )}

        {activeView === "completed" && (
          <CompletedView
            contentFilter={completedContent}
            dateFilter={completedDate}
            month={completedMonth}
            months={completedMonths}
            priorityFilter={completedPriority}
            query={completedQuery}
            tasks={completedTasks}
            onContentFilterChange={setCompletedContent}
            onDateFilterChange={setCompletedDate}
            onMonthChange={setCompletedMonth}
            onMonthsChange={setCompletedMonths}
            onOpen={setViewTaskId}
            onPriorityFilterChange={setCompletedPriority}
            onQueryChange={setCompletedQuery}
            onToggle={(task) => void toggleTask(task)}
          />
        )}
      </section>

      {viewTask && (
        <TaskReadModal
          duplicationPending={taskDuplicationPending}
          inactive={deleteConfirmationTask !== null}
          task={viewTask}
          onClose={() => setViewTaskId(null)}
          onDelete={() => requestTaskDeletion(viewTask)}
          onDuplicate={() => void duplicateTask(viewTask)}
          onEdit={() => {
            setEditingTaskId(viewTask.id);
            setViewTaskId(null);
          }}
          onUpdateProgress={(percent) => updateTaskProgress(viewTask, percent)}
          onUpdateDetails={(updateDetails) => updateTaskDetails(viewTask, updateDetails, "일정 상세 내용을 저장하지 못했습니다.")}
          onToggleChecklist={(itemId) => toggleTaskChecklistItem(viewTask, itemId)}
        />
      )}

      {editingTask && (
        <TaskDetailModal
          inactive={deleteConfirmationTask !== null}
          task={editingTask}
          onClose={() => setEditingTaskId(null)}
          onDelete={() => requestTaskDeletion(editingTask)}
          onSave={(draft) => void saveTask(editingTask, draft)}
        />
      )}

      {deleteConfirmationTask && (
        <TaskDeleteConfirmDialog
          error={taskDeletionError}
          pending={taskDeletionPending}
          task={deleteConfirmationTask}
          onCancel={cancelTaskDeletion}
          onConfirm={() => void confirmTaskDeletion()}
        />
      )}

      {readRecurringHabit && (
        <RecurringHabitReadModal
          checkIns={recurringCheckIns}
          dayStatePending={pendingRecurringCheckIn[
            recurringCheckInId(readRecurringHabit.id, selectedRecurringDate)
          ] === true}
          habit={readRecurringHabit}
          selectedDate={selectedRecurringDate}
          today={today}
          onClose={() => setReadRecurringHabitId(null)}
          onDelete={() => void removeRecurringHabit(readRecurringHabit)}
          onEdit={() => {
            setRecurringHabitDialog({ habitId: readRecurringHabit.id, mode: "edit" });
            setReadRecurringHabitId(null);
          }}
          onToggleChecklist={(itemId) => toggleRecurringHabitChecklistItem(readRecurringHabit, selectedRecurringDate, itemId)}
          onUpdateDetails={(updateDetails) =>
            updateRecurringHabitDetails(readRecurringHabit, updateDetails, "반복 업무 상세 내용을 저장하지 못했습니다.")
          }
          onUpdateProgress={(percent) => updateRecurringHabitProgress(readRecurringHabit, selectedRecurringDate, percent)}
        />
      )}

      {createDialog && (
        <ScheduleCreateDialog
          allowPriority={createDialog.allowPriority}
          defaults={createDialog.defaults}
          title={createDialog.title}
          onClose={() => setCreateDialog(null)}
          onCreate={createTask}
        />
      )}

      {recurringHabitDialog && (recurringHabitDialog.mode === "create" || editingRecurringHabit) && (
        <RecurringHabitModal
          habit={recurringHabitDialog.mode === "edit" ? editingRecurringHabit : null}
          onClose={() => setRecurringHabitDialog(null)}
          onCreate={createRecurringHabitFromDraft}
          onDelete={(habit) => void removeRecurringHabit(habit)}
          onSave={(habit, draft) => saveRecurringHabit(habit, draft)}
        />
      )}

      {recurringOverviewOpen && (
        <RecurringOverviewModal
          checkIns={recurringCheckIns}
          habits={decryptedRecurringHabits}
          month={recurringMonth}
          today={today}
          onClose={() => setRecurringOverviewOpen(false)}
          onMonthChange={setRecurringMonth}
          onOpenHabit={(habitId) => {
            setViewRecurringHabitId(habitId);
            setRecurringOverviewOpen(false);
          }}
        />
      )}

      {googleCalendarDialogOpen && (
        <GoogleCalendarSyncDialog
          connection={googleCalendarConnection}
          eligibleExistingCount={eligibleGoogleCalendarTasks.length}
          error={googleCalendarError}
          loading={googleCalendarLoading}
          notice={googleCalendarNotice}
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
  const checklistGroups = useMemo(() => checklistDisplayGroups(draft.checklist), [draft.checklist]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
    setIsCreating(true);
    const created = await onCreate({
      ...submittedDraft,
      endDate: submittedDraft.endDate || submittedDraft.startDate
    }).finally(() => setIsCreating(false));

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
            id={titleId}
            onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
            placeholder="일정 제목"
            value={draft.title}
          />
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
          <select
            onChange={(event) => {
              const nextMode = event.target.value as CreateTaskDraft["timeMode"];
              setDraft((current) => applyScheduleTimeMode(current, nextMode));
            }}
            value={draft.timeMode}
          >
            <option value="none">시간 없음</option>
            <option value="point">시각</option>
            <option value="range">시간 범위</option>
          </select>
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
      {localError && <p className="form-error">{localError}</p>}
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
  onClose,
  onCreate,
  title
}: {
  allowPriority?: boolean;
  defaults: QuickDefaults;
  onClose: () => void;
  onCreate: (draft: CreateTaskDraft) => Promise<boolean>;
  title: string;
}) {
  const titleId = useId();
  const descriptionId = useId();

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

function TodayWorkPanel({
  checkIns,
  id,
  onAddTask,
  onClose,
  onOpenHabit,
  onOpenTask,
  panelRef,
  onToggleHabit,
  onToggleTask,
  pendingCheckIns,
  summary,
  today
}: {
  checkIns: RecurringHabitCheckInSnapshot[];
  id: string;
  onAddTask: () => void;
  onClose: () => void;
  onOpenHabit: (habitId: string) => void;
  onOpenTask: (taskId: string) => void;
  panelRef: RefObject<HTMLElement | null>;
  onToggleHabit: (habit: DecryptedRecurringHabit) => void;
  onToggleTask: (task: DecryptedScheduleTask) => void;
  pendingCheckIns: Record<string, boolean>;
  summary: TodayWorkSummary;
  today: string;
}) {
  const titleId = useId();
  const totalCount = summary.overdueTasks.length + summary.todayTasks.length + summary.recurringHabits.length;

  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, [panelRef]);

  return (
    <aside
      id={id}
      className="today-work-panel"
      ref={panelRef}
      role="region"
      aria-labelledby={titleId}
      tabIndex={-1}
    >
      <header>
        <div>
          <p className="section-kicker">
            <Zap size={15} />
            오늘 업무
          </p>
          <h2 id={titleId}>{formatDateLabel(today)}</h2>
          <span>{totalCount ? `${totalCount}개 항목` : "오늘 예정된 업무가 없습니다."}</span>
        </div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="오늘 업무 닫기">
          <X size={18} />
        </button>
      </header>
      <div className="today-work-content">
        <section className="today-work-section overdue">
          <div>
            <h3>지연 업무</h3>
            <span>{summary.overdueTasks.length}</span>
          </div>
          <TaskList
            emptyMessage="지연된 업무가 없습니다."
            tasks={summary.overdueTasks}
            today={today}
            onOpen={onOpenTask}
            onToggle={onToggleTask}
          />
        </section>
        <section className="today-work-section">
          <div>
            <h3>오늘 일정</h3>
            <span>{summary.todayTasks.length}</span>
          </div>
          <TaskList
            emptyMessage="오늘 예정된 일정이 없습니다."
            tasks={summary.todayTasks}
            today={today}
            onOpen={onOpenTask}
            onToggle={onToggleTask}
          />
        </section>
        <section className="today-work-section">
          <div>
            <h3>반복 업무</h3>
            <span>{summary.recurringHabits.length}</span>
          </div>
          {summary.recurringHabits.length ? (
            <div className="today-recurring-list">
              {summary.recurringHabits.map((habit) => {
                const checked = isHabitCheckedOn(checkIns, habit.id, today);
                const pending = pendingCheckIns[recurringCheckInId(habit.id, today)] === true;

                return (
                  <article className={`today-recurring-item ${checked ? "checked" : ""}`} key={habit.id}>
                    <button
                      className={`recurring-check-button ${checked ? "checked" : ""}`}
                      disabled={pending}
                      type="button"
                      aria-label={checked ? `${habit.title} 체크 해제` : `${habit.title} 체크`}
                      onClick={() => onToggleHabit(habit)}
                    >
                      {checked ? <Check size={16} /> : null}
                    </button>
                    <button className="today-recurring-open" type="button" onClick={() => onOpenHabit(habit.id)}>
                      <strong>{habit.title}</strong>
                      <span>{slotLabel(habit.slot)} · {recurringHabitIconLabels[habit.icon]}</span>
                    </button>
                  </article>
                );
              })}
            </div>
          ) : (
            <p className="schedule-empty">오늘 체크할 반복 업무가 없습니다.</p>
          )}
        </section>
      </div>
      <footer>
        <button className="secondary-button" type="button" onClick={onAddTask}>
          <Plus size={16} />
          오늘 일정 추가
        </button>
      </footer>
    </aside>
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
          onClick={() => setOpen((current) => !current)}
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

function TodoView({
  groups,
  onOpen,
  onToggle,
  today
}: {
  groups: ReturnType<typeof groupTasksByTodoDate>;
  onOpen: (taskId: string) => void;
  onToggle: (task: DecryptedScheduleTask) => void;
  today: string;
}) {
  return (
    <div className="todo-groups">
      {groups.map((group) => (
        <section className="schedule-section" key={group.key}>
          <header>
            <h2>{group.label}</h2>
            <span>{group.tasks.length}</span>
          </header>
          <PagedTaskList tasks={group.tasks} today={today} showProgress onOpen={onOpen} onToggle={onToggle} />
        </section>
      ))}
    </div>
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
                  aria-label={`${formatDateLabel(day.dateString)} 선택`}
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
                            task.status === "completed" ? "completed" : "",
                            rangePosition,
                            day.date.getDay() === 0 ? "week-start" : "",
                            day.date.getDay() === 6 ? "week-end" : ""
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          key={task.id}
                          style={{ "--schedule-task-color": color } as CSSProperties}
                          title={`${task.title}${timeLabel ? ` · ${timeLabel}` : ""}`}
                        >
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
            <MatrixTaskRowContent task={activeTask} today={today} />
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
  today
}: {
  collapsedGroups: Record<string, boolean>;
  onAddSection: (section: MatrixSection) => void;
  onOpen: (taskId: string) => void;
  onToggle: (task: DecryptedScheduleTask) => void;
  onToggleGroup: (sectionKey: MatrixQuadrantKey, groupKey: string) => void;
  section: MatrixSection;
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
              <section className="matrix-date-group" key={group.key}>
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
  tasks,
  today
}: {
  emptyMessage?: string;
  onOpen: (taskId: string) => void;
  onToggle: (task: DecryptedScheduleTask) => void;
  sectionKey: MatrixQuadrantKey;
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
  task,
  today
}: {
  onOpen: (taskId: string) => void;
  onToggle: (task: DecryptedScheduleTask) => void;
  sectionKey: MatrixQuadrantKey;
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
      {...listeners}
    >
      <button
        className="task-drag-handle"
        type="button"
        aria-label={`${task.title} 드래그 이동`}
        ref={setActivatorNodeRef}
        style={{ touchAction: "none" }}
        title="드래그 이동"
        {...attributes}
      >
        <GripVertical size={16} />
      </button>
      <MatrixTaskRowContent task={task} today={today} onOpen={onOpen} onToggle={onToggle} />
    </div>
  );
}

function MatrixTaskRowContent({
  onOpen,
  onToggle,
  task,
  today
}: {
  onOpen?: (taskId: string) => void;
  onToggle?: (task: DecryptedScheduleTask) => void;
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

const recurringCollisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);

  if (pointerCollisions.length > 0) {
    const habitCollisions = pointerCollisions.filter((collision) => collisionType(collision) === "recurring-habit");

    if (habitCollisions.length > 0) {
      return habitCollisions;
    }

    const slotCollisions = pointerCollisions.filter((collision) => collisionType(collision) === "recurring-slot");

    if (slotCollisions.length > 0) {
      return slotCollisions;
    }

    return pointerCollisions;
  }

  const rectangleCollisions = rectIntersection(args);
  const habitCollisions = rectangleCollisions.filter((collision) => collisionType(collision) === "recurring-habit");

  if (habitCollisions.length > 0) {
    return habitCollisions;
  }

  const slotCollisions = rectangleCollisions.filter((collision) => collisionType(collision) === "recurring-slot");

  return slotCollisions.length > 0 ? slotCollisions : rectangleCollisions;
};

function collisionType(collision: ReturnType<CollisionDetection>[number]) {
  return collision.data?.droppableContainer.data.current?.type;
}

function matrixSectionDropId(sectionKey: MatrixQuadrantKey) {
  return `matrix-section:${sectionKey}`;
}

function recurringSlotDropId(slot: RecurringHabitSlot) {
  return `recurring-slot:${slot}`;
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

function recurringSlotFromDragEvent(event: DragEndEvent): RecurringHabitSlot | null {
  const slot = event.over?.data.current?.slot;

  if (isRecurringHabitSlot(slot)) {
    return slot;
  }

  return recurringSlotFromDropId(event.over?.id);
}

function recurringSlotFromDropId(value: unknown): RecurringHabitSlot | null {
  if (typeof value !== "string" || !value.startsWith("recurring-slot:")) {
    return null;
  }

  const slot = value.slice("recurring-slot:".length);

  return isRecurringHabitSlot(slot) ? slot : null;
}

function recurringHabitIdFromDragEvent(event: DragEndEvent) {
  return event.over?.data.current?.type === "recurring-habit" ? String(event.over.id) : null;
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

function isRecurringHabitSlot(value: unknown): value is RecurringHabitSlot {
  return value === "morning" || value === "afternoon" || value === "other";
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

function CompletedView({
  contentFilter,
  dateFilter,
  month,
  months,
  onContentFilterChange,
  onDateFilterChange,
  onMonthChange,
  onMonthsChange,
  onOpen,
  onPriorityFilterChange,
  onQueryChange,
  onToggle,
  priorityFilter,
  query,
  tasks
}: {
  contentFilter: CompletedContentFilter;
  dateFilter: string;
  month: string;
  months: CompletedMonthsFilter;
  onContentFilterChange: (filter: CompletedContentFilter) => void;
  onDateFilterChange: (date: string) => void;
  onMonthChange: (month: string) => void;
  onMonthsChange: (months: CompletedMonthsFilter) => void;
  onOpen: (taskId: string) => void;
  onPriorityFilterChange: (filter: CompletedPriorityFilter) => void;
  onQueryChange: (query: string) => void;
  onToggle: (task: DecryptedScheduleTask) => void;
  priorityFilter: CompletedPriorityFilter;
  query: string;
  tasks: DecryptedScheduleTask[];
}) {
  const normalizedQuery = query.trim().toLowerCase();
  const filteredTasks = useMemo(() => {
    return tasks.filter((task) => {
      const details = task.details ?? emptyScheduleDetails;
      const completedDate = taskCompletedDate(task);

      if (!completedDate) {
        return false;
      }

      if (dateFilter) {
        if (completedDate !== dateFilter) {
          return false;
        }
      } else if (!completedTaskInMonthWindow(completedDate, month, months)) {
        return false;
      }

      if (priorityFilter === "important" && !task.isImportant) {
        return false;
      }

      if (priorityFilter === "urgent" && !task.isUrgent) {
        return false;
      }

      if (priorityFilter === "importantUrgent" && (!task.isImportant || !task.isUrgent)) {
        return false;
      }

      if (contentFilter === "hasDescription" && !details.description.trim()) {
        return false;
      }

      if (contentFilter === "hasChecklist" && details.checklist.length === 0) {
        return false;
      }

      if (!normalizedQuery) {
        return true;
      }

      const searchable = [task.title, details.description, ...details.checklist.map((item) => item.text)]
        .join(" ")
        .toLowerCase();

      return searchable.includes(normalizedQuery);
    });
  }, [contentFilter, dateFilter, month, months, normalizedQuery, priorityFilter, tasks]);
  const rangeLabel = dateFilter ? `${dateFilter} 완료` : completedMonthRangeLabel(month, months);

  return (
    <section className="completed-panel">
      <header>
        <div>
          <h2>완료 내역</h2>
          <span>
            {rangeLabel} · {filteredTasks.length}
          </span>
        </div>
      </header>
      <div className="completed-filter-grid" aria-label="완료 내역 필터">
        <label className="completed-filter-control search">
          <span>검색</span>
          <span className="completed-search">
            <Search size={16} />
            <input
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="제목, 내용, 체크리스트 검색"
              type="search"
              value={query}
            />
          </span>
        </label>
        <label className="completed-filter-control">
          <span>기준 월</span>
          <input onChange={(event) => onMonthChange(event.target.value)} type="month" value={month} />
        </label>
        <label className="completed-filter-control">
          <span>조회 기간</span>
          <select onChange={(event) => onMonthsChange(event.target.value as CompletedMonthsFilter)} value={months}>
            <option value="1">1개월</option>
            <option value="3">3개월</option>
            <option value="6">6개월</option>
            <option value="12">12개월</option>
            <option value="all">전체</option>
          </select>
        </label>
        <DatePickerField
          className="completed-filter-control"
          label="특정 완료일"
          onChange={onDateFilterChange}
          value={dateFilter}
        />
        <label className="completed-filter-control">
          <span>중요/긴급</span>
          <select
            onChange={(event) => onPriorityFilterChange(event.target.value as CompletedPriorityFilter)}
            value={priorityFilter}
          >
            <option value="all">전체</option>
            <option value="important">중요</option>
            <option value="urgent">긴급</option>
            <option value="importantUrgent">중요 + 긴급</option>
          </select>
        </label>
        <label className="completed-filter-control">
          <span>내용 필터</span>
          <select onChange={(event) => onContentFilterChange(event.target.value as CompletedContentFilter)} value={contentFilter}>
            <option value="all">전체</option>
            <option value="hasDescription">내용 있음</option>
            <option value="hasChecklist">체크리스트 있음</option>
          </select>
        </label>
      </div>
      <PagedTaskList
        getMeta={formatCompletedTaskMeta}
        pageSize={completedPageSize}
        tasks={filteredTasks}
        onOpen={onOpen}
        onToggle={onToggle}
        strikeCompleted={false}
      />
    </section>
  );
}

function TaskList({
  emptyMessage = "표시할 일정이 없습니다.",
  getMeta,
  tasks,
  onOpen,
  onToggle,
  showProgress = false,
  strikeCompleted = true,
  today = toLocalDateString(new Date())
}: {
  emptyMessage?: string;
  getMeta?: (task: DecryptedScheduleTask) => string;
  tasks: DecryptedScheduleTask[];
  onOpen: (taskId: string) => void;
  onToggle: (task: DecryptedScheduleTask) => void;
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
  showProgress,
  strikeCompleted,
  task,
  today
}: {
  getMeta?: (task: DecryptedScheduleTask) => string;
  onOpen: (taskId: string) => void;
  onToggle: (task: DecryptedScheduleTask) => void;
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

function RecurringView({
  checkIns,
  habits,
  month,
  onAdd,
  onCloseHabit,
  onDeleteHabit,
  onEditHabit,
  onMonthChange,
  onMoveHabit,
  onOpenHabit,
  onOpenOverview,
  onReadHabit,
  onRetryDelete,
  onSelectDate,
  onToggleCheckIn,
  pendingCheckIns,
  pendingDeletionHabits,
  pendingDeletions,
  selectedDate,
  selectedHabit,
  today
}: {
  checkIns: RecurringHabitCheckInSnapshot[];
  habits: DecryptedRecurringHabit[];
  month: string;
  onAdd: () => void;
  onCloseHabit: () => void;
  onDeleteHabit: (habit: DecryptedRecurringHabit) => void;
  onEditHabit: (habit: DecryptedRecurringHabit) => void;
  onMonthChange: (month: string) => void;
  onMoveHabit: (habitId: string, targetSlot: RecurringHabitSlot, overHabitId: string | null) => void;
  onOpenHabit: (habitId: string) => void;
  onOpenOverview: () => void;
  onReadHabit: (habitId: string) => void;
  onRetryDelete: (habit: DecryptedRecurringHabit) => void;
  onSelectDate: (date: string) => void;
  onToggleCheckIn: (habit: DecryptedRecurringHabit, date: string) => void;
  pendingCheckIns: Record<string, boolean>;
  pendingDeletionHabits: DecryptedRecurringHabit[];
  pendingDeletions: Record<string, boolean>;
  selectedDate: string;
  selectedHabit: DecryptedRecurringHabit | null;
  today: string;
}) {
  const [activeHabitId, setActiveHabitId] = useState<string | null>(null);
  const dateStrip = useMemo(() => buildRecurringDateStrip(today), [today]);
  const groups = useMemo(() => groupRecurringHabitsBySlot(habits), [habits]);
  const activeHabitCount = habits.filter((habit) => habit.status === "active").length;
  const activeHabit = useMemo(
    () => habits.find((habit) => habit.id === activeHabitId) ?? null,
    [activeHabitId, habits]
  );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  function handleDragStart(event: DragStartEvent) {
    setActiveHabitId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveHabitId(null);

    if (!event.over) {
      return;
    }

    const activeId = String(event.active.id);
    const targetSlot = recurringSlotFromDragEvent(event);
    const overHabitId = recurringHabitIdFromDragEvent(event);

    if (targetSlot) {
      onMoveHabit(activeId, targetSlot, overHabitId === activeId ? null : overHabitId);
    }
  }

  return (
    <DndContext
      collisionDetection={recurringCollisionDetection}
      onDragEnd={handleDragEnd}
      onDragStart={handleDragStart}
      sensors={sensors}
    >
      <div className="recurring-page-content">
        {pendingDeletionHabits.length > 0 && (
          <section className="recurring-cleanup-notice" role="status" aria-live="polite">
            <div>
              <strong>삭제 정리를 다시 시작해야 합니다.</strong>
              <p>중단된 반복 업무는 완료될 때까지 삭제 대기 상태로 안전하게 유지됩니다.</p>
            </div>
            <div className="recurring-cleanup-actions">
              {pendingDeletionHabits.map((habit) => (
                <button
                  className="secondary-button"
                  disabled={pendingDeletions[habit.id] === true}
                  key={habit.id}
                  onClick={() => onRetryDelete(habit)}
                  type="button"
                >
                  <Trash2 size={15} />
                  {pendingDeletions[habit.id] ? "정리 중" : `${habit.title} 삭제 재시도`}
                </button>
              ))}
            </div>
          </section>
        )}

        <div className="recurring-layout">
          <section className="recurring-main-panel">
          <header className="recurring-toolbar">
            <div>
              <h2>반복 업무</h2>
              <span>{formatDateLabel(selectedDate)} · {activeHabitCount}</span>
            </div>
            <div className="recurring-toolbar-actions">
              <button className="secondary-button" type="button" onClick={onAdd}>
                <Plus size={16} />
                추가
              </button>
              <button className="icon-button" type="button" aria-label="월별 반복 조회" title="월별 반복 조회" onClick={onOpenOverview}>
                <LayoutGrid size={18} />
              </button>
            </div>
          </header>

          <div className="recurring-date-strip" aria-label="반복 업무 날짜 선택">
            {dateStrip.map((day) => {
              const progress = calculateRecurringDateProgress(habits, checkIns, day.dateString);
              const selected = selectedDate === day.dateString;

              return (
                <button
                  aria-label={`${formatDateLabel(day.dateString)} 반복 업무 ${progress.percent}% 완료`}
                  className={selected ? "selected" : ""}
                  key={day.dateString}
                  onClick={() => onSelectDate(day.dateString)}
                  type="button"
                >
                  <span>{day.weekday}</span>
                  <strong>{day.dayNumber}</strong>
                  <RecurringProgressRing percent={progress.percent} total={progress.total} />
                </button>
              );
            })}
          </div>

          <div className="recurring-slot-groups">
            {groups.map((group) => (
              <RecurringSlotSection
                checkIns={checkIns}
                group={group}
                key={group.key}
                pendingCheckIns={pendingCheckIns}
                selectedDate={selectedDate}
                onOpenHabit={onOpenHabit}
                onReadHabit={onReadHabit}
                onToggleCheckIn={onToggleCheckIn}
              />
            ))}
          </div>
          </section>

          <RecurringHabitDetailPanel
            checkIns={checkIns}
            habit={selectedHabit}
            month={month}
            pendingCheckIns={pendingCheckIns}
            selectedDate={selectedDate}
            today={today}
            onClose={onCloseHabit}
            onDelete={onDeleteHabit}
            onEdit={onEditHabit}
            onMonthChange={onMonthChange}
            onSelectDate={onSelectDate}
            onToggleCheckIn={onToggleCheckIn}
          />
        </div>
      </div>
      <DragOverlay>
        {activeHabit ? (
          <div className={`recurring-habit-row recurring-drag-overlay ${isHabitCheckedOn(checkIns, activeHabit.id, selectedDate) ? "checked" : ""}`} aria-hidden="true">
            <span className="recurring-drag-handle ghost">
              <GripVertical size={16} />
            </span>
            <span className="recurring-habit-main overlay">
              <RecurringHabitRowContent checkIns={checkIns} habit={activeHabit} selectedDate={selectedDate} />
            </span>
            <span className="recurring-check-button ghost" />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function RecurringSlotSection({
  checkIns,
  group,
  onOpenHabit,
  onReadHabit,
  onToggleCheckIn,
  pendingCheckIns,
  selectedDate
}: {
  checkIns: RecurringHabitCheckInSnapshot[];
  group: ReturnType<typeof groupRecurringHabitsBySlot>[number];
  onOpenHabit: (habitId: string) => void;
  onReadHabit: (habitId: string) => void;
  onToggleCheckIn: (habit: DecryptedRecurringHabit, date: string) => void;
  pendingCheckIns: Record<string, boolean>;
  selectedDate: string;
}) {
  const { isOver, setNodeRef } = useDroppable({
    id: recurringSlotDropId(group.key),
    data: { slot: group.key, type: "recurring-slot" }
  });

  return (
    <section className={`recurring-slot-section ${isOver ? "drag-over" : ""}`} ref={setNodeRef}>
      <header>
        <h3>{group.label}</h3>
        <span>{group.habits.length}</span>
      </header>
      {group.habits.length ? (
        <SortableContext items={group.habits.map((habit) => habit.id)} strategy={verticalListSortingStrategy}>
          <div className="recurring-habit-list">
            {group.habits.map((habit) => (
              <SortableRecurringHabitRow
                checkIns={checkIns}
                habit={habit}
                key={habit.id}
                pending={pendingCheckIns[recurringCheckInId(habit.id, selectedDate)] === true}
                selectedDate={selectedDate}
                slot={group.key}
                onOpen={() => onOpenHabit(habit.id)}
                onRead={() => onReadHabit(habit.id)}
                onToggle={() => onToggleCheckIn(habit, selectedDate)}
              />
            ))}
          </div>
        </SortableContext>
      ) : (
        <p className="schedule-empty">등록된 반복 업무가 없습니다.</p>
      )}
    </section>
  );
}

function SortableRecurringHabitRow({
  checkIns,
  habit,
  onOpen,
  onRead,
  onToggle,
  pending,
  selectedDate,
  slot
}: {
  checkIns: RecurringHabitCheckInSnapshot[];
  habit: DecryptedRecurringHabit;
  onOpen: () => void;
  onRead: () => void;
  onToggle: () => void;
  pending: boolean;
  selectedDate: string;
  slot: RecurringHabitSlot;
}) {
  const checked = isHabitCheckedOn(checkIns, habit.id, selectedDate);
  const progressPercent = recurringHabitDayProgressPercent(habit, checkIns, selectedDate);
  const {
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition
  } = useSortable({
    id: habit.id,
    data: { habitId: habit.id, slot, type: "recurring-habit" }
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition
  };

  return (
    <div
      className={`recurring-habit-row ${checked ? "checked" : ""} ${isDragging ? "dragging" : ""}`}
      onDoubleClick={onRead}
      ref={setNodeRef}
      style={style}
      title="더블클릭하여 상세 보기"
    >
      <button
        aria-label={`${habit.title} 위치 이동`}
        className="recurring-drag-handle"
        ref={setActivatorNodeRef}
        style={{ touchAction: "none" }}
        type="button"
        {...attributes}
        {...listeners}
      >
        <GripVertical size={16} />
      </button>
      <div className="recurring-habit-main">
        <button className="recurring-habit-content" type="button" onClick={onOpen} onDoubleClick={onRead}>
          <RecurringHabitRowContent checkIns={checkIns} habit={habit} selectedDate={selectedDate} />
        </button>
        <span
          aria-label={`${habit.title} 진행률 ${progressPercent}%`}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={progressPercent}
          className="recurring-habit-progress-strip"
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          role="progressbar"
          style={
            {
              "--recurring-habit-progress-color": taskProgressColor(progressPercent),
              "--recurring-habit-progress-fill": `${progressPercent}%`
            } as CSSProperties
          }
          title={`${progressPercent}%`}
        />
      </div>
      <button
        aria-checked={checked}
        aria-label={checked ? `${habit.title} 체크 해제` : `${habit.title} 체크`}
        className={`recurring-check-button ${checked ? "checked" : ""}`}
        disabled={pending}
        onClick={onToggle}
        onDoubleClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        role="checkbox"
        type="button"
      >
        {checked ? <Check size={17} /> : null}
      </button>
    </div>
  );
}

function RecurringHabitRowContent({
  checkIns,
  habit,
  selectedDate
}: {
  checkIns: RecurringHabitCheckInSnapshot[];
  habit: DecryptedRecurringHabit;
  selectedDate: string;
}) {
  const stats = calculateHabitStats(habit.id, checkIns, selectedDate);

  return (
    <>
      <HabitIconBadge color={habit.color} icon={habit.icon} />
      <span>
        <strong>{habit.title}</strong>
        <small className="recurring-habit-metrics">
          <span className="metric-total">
            <Zap size={12} />
            {stats.totalCheckIns}일
          </span>
          <span className="metric-streak">
            <Flame size={12} />
            {stats.streakDays}일 (연속)
          </span>
        </small>
      </span>
    </>
  );
}

function RecurringHabitDetailPanel({
  checkIns,
  habit,
  month,
  onClose,
  onDelete,
  onEdit,
  onMonthChange,
  onSelectDate,
  onToggleCheckIn,
  pendingCheckIns,
  selectedDate,
  today
}: {
  checkIns: RecurringHabitCheckInSnapshot[];
  habit: DecryptedRecurringHabit | null;
  month: string;
  onClose: () => void;
  onDelete: (habit: DecryptedRecurringHabit) => void;
  onEdit: (habit: DecryptedRecurringHabit) => void;
  onMonthChange: (month: string) => void;
  onSelectDate: (date: string) => void;
  onToggleCheckIn: (habit: DecryptedRecurringHabit, date: string) => void;
  pendingCheckIns: Record<string, boolean>;
  selectedDate: string;
  today: string;
}) {
  if (!habit) {
    return (
      <aside className="recurring-detail-panel empty">
        <Repeat2 size={22} />
        <strong>반복 업무를 선택하세요.</strong>
        <span>월간 출석체크, 총 체크인 수, 월별 비율과 연속 기록이 여기에 표시됩니다.</span>
      </aside>
    );
  }

  const safeMonth = normalizeMonthString(month, today.slice(0, 7));
  const stats = calculateHabitStats(habit.id, checkIns, selectedDate);
  const monthStats = calculateHabitMonthStats(habit.id, checkIns, safeMonth, today);

  return (
    <aside className="recurring-detail-panel">
      <header>
        <div className="recurring-detail-title">
          <HabitIconBadge color={habit.color} icon={habit.icon} />
          <div>
            <h2>{habit.title}</h2>
            <span>{slotLabel(habit.slot)} · {recurringHabitIconLabels[habit.icon]}</span>
          </div>
        </div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="상세 닫기">
          <X size={17} />
        </button>
      </header>

      {habit.details.description.trim() && <p className="recurring-detail-description">{habit.details.description}</p>}

      <RecurringStatsGrid stats={stats} monthStats={monthStats} />

      <RecurringMonthCalendar
        checkIns={checkIns}
        habit={habit}
        month={safeMonth}
        pendingCheckIns={pendingCheckIns}
        today={today}
        onMonthChange={onMonthChange}
        onSelectDate={onSelectDate}
        onToggleCheckIn={onToggleCheckIn}
      />

      <footer className="recurring-detail-actions">
        <button className="danger-button" type="button" onClick={() => onDelete(habit)}>
          <Trash2 size={16} />
          삭제
        </button>
        <button type="button" onClick={() => onEdit(habit)}>
          <Pencil size={16} />
          수정
        </button>
      </footer>
    </aside>
  );
}

function RecurringStatsGrid({
  monthStats,
  stats
}: {
  monthStats: ReturnType<typeof calculateHabitMonthStats>;
  stats: ReturnType<typeof calculateHabitStats>;
}) {
  const cards: Array<{ Icon: LucideIcon; color: string; label: string; value: string }> = [
    { Icon: CheckCircle2, color: "#10b981", label: "월간 체크인 수", value: `${monthStats.checkedDays}일` },
    { Icon: Zap, color: "#2563eb", label: "총 체크인 수", value: `${stats.totalCheckIns}일` },
    { Icon: Percent, color: "#7c3aed", label: "월별 체크인 비율", value: `${monthStats.percent}%` },
    { Icon: Flame, color: "#ef4444", label: "연속", value: `${stats.streakDays}일` }
  ];

  return (
    <div className="recurring-stats-grid">
      {cards.map(({ Icon, color, label, value }) => (
        <div key={label}>
          <span className="recurring-stat-icon" style={{ "--recurring-stat-color": color } as CSSProperties}>
            <Icon size={16} />
          </span>
          <span className="recurring-stat-copy">
            <span>{label}</span>
            <strong>{value}</strong>
          </span>
        </div>
      ))}
    </div>
  );
}

function RecurringMonthCalendar({
  checkIns,
  habit,
  month,
  onMonthChange,
  onSelectDate,
  onToggleCheckIn,
  pendingCheckIns,
  today
}: {
  checkIns: RecurringHabitCheckInSnapshot[];
  habit: DecryptedRecurringHabit;
  month: string;
  onMonthChange: (month: string) => void;
  onSelectDate: (date: string) => void;
  onToggleCheckIn: (habit: DecryptedRecurringHabit, date: string) => void;
  pendingCheckIns: Record<string, boolean>;
  today: string;
}) {
  const weeks = buildRecurringMonthCalendar(month, today);

  return (
    <section className="recurring-month-card">
      <header>
        <button className="icon-button" type="button" aria-label="이전 달" onClick={() => onMonthChange(recurringMonthOffset(month, -1))}>
          <ChevronLeft size={16} />
        </button>
        <MonthPicker value={month} today={today} onChange={onMonthChange} />
        <button className="icon-button" type="button" aria-label="다음 달" onClick={() => onMonthChange(recurringMonthOffset(month, 1))}>
          <ChevronRight size={16} />
        </button>
      </header>
      <div className="recurring-month-weekdays" aria-hidden="true">
        {["일", "월", "화", "수", "목", "금", "토"].map((weekday) => (
          <span key={weekday}>{weekday}</span>
        ))}
      </div>
      <div className="recurring-month-grid">
        {weeks.flatMap((week) =>
          week.days.map((day) => {
            const checked = isHabitCheckedOn(checkIns, habit.id, day.dateString);
            const pending = pendingCheckIns[recurringCheckInId(habit.id, day.dateString)] === true;
            const disabled = !day.inCurrentMonth || day.dateString > today || pending;

            return (
              <button
                aria-label={`${formatDateLabel(day.dateString)} ${checked ? "체크됨" : "체크 안 됨"}`}
                className={[
                  day.inCurrentMonth ? "" : "muted",
                  checked ? "checked" : "",
                  day.isToday ? "today" : ""
                ]
                  .filter(Boolean)
                  .join(" ")}
                disabled={disabled}
                key={day.dateString}
                onClick={() => {
                  onSelectDate(day.dateString);
                  onToggleCheckIn(habit, day.dateString);
                }}
                type="button"
              >
                <span>{day.dayNumber}</span>
                {checked && <Check size={15} />}
              </button>
            );
          })
        )}
      </div>
    </section>
  );
}

function MonthPicker({
  onChange,
  today,
  value
}: {
  onChange: (month: string) => void;
  today: string;
  value: string;
}) {
  const safeMonth = normalizeMonthString(value, today.slice(0, 7));
  const safeYear = Number(safeMonth.slice(0, 4)) || new Date().getFullYear();
  const currentMonth = today.slice(0, 7);
  const [open, setOpen] = useState(false);
  const [cursorYear, setCursorYear] = useState(safeYear);

  useEffect(() => {
    setCursorYear(safeYear);
  }, [safeYear]);

  function choose(month: string) {
    onChange(month);
    setOpen(false);
  }

  return (
    <div
      className="month-picker"
      onBlur={(event) => {
        const nextTarget = event.relatedTarget;

        if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
          setOpen(false);
        }
      }}
    >
      <button
        aria-expanded={open}
        aria-label={`${recurringMonthLabel(safeMonth)} 선택`}
        className="month-picker-trigger"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <CalendarDays size={15} />
        <span>{recurringMonthLabel(safeMonth)}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="month-picker-popover">
          <header>
            <button className="icon-button" type="button" aria-label="이전 연도" onClick={() => setCursorYear((year) => year - 1)}>
              <ChevronLeft size={15} />
            </button>
            <strong>{cursorYear}</strong>
            <button className="icon-button" type="button" aria-label="다음 연도" onClick={() => setCursorYear((year) => year + 1)}>
              <ChevronRight size={15} />
            </button>
          </header>
          <div className="month-picker-grid">
            {Array.from({ length: 12 }, (_, index) => {
              const month = `${cursorYear}-${`${index + 1}`.padStart(2, "0")}`;

              return (
                <button
                  className={[month === safeMonth ? "selected" : "", month === currentMonth ? "current" : ""].filter(Boolean).join(" ")}
                  key={month}
                  onClick={() => choose(month)}
                  type="button"
                >
                  {index + 1}월
                </button>
              );
            })}
          </div>
          <footer>
            <button className="secondary-button" type="button" onClick={() => choose(currentMonth)}>
              이번 달
            </button>
          </footer>
        </div>
      )}
    </div>
  );
}

function RecurringHabitModal({
  habit,
  onClose,
  onCreate,
  onDelete,
  onSave
}: {
  habit: DecryptedRecurringHabit | null;
  onClose: () => void;
  onCreate: (draft: RecurringHabitDraft) => Promise<boolean>;
  onDelete: (habit: DecryptedRecurringHabit) => void;
  onSave: (habit: DecryptedRecurringHabit, draft: RecurringHabitDraft) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<RecurringHabitDraft>(() => recurringDraftFromHabit(habit));
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(recurringDraftFromHabit(habit));
  }, [habit]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const validationError = recurringHabitTitleValidationError(draft.title)
      ?? recurringHabitDetailsValidationError({ description: draft.description, checklist: habit?.details.checklist ?? [] });

    if (validationError) {
      setLocalError(validationError);
      return;
    }

    setBusy(true);
    setLocalError(null);

    const saved = habit ? await onSave(habit, draft) : await onCreate(draft);
    setBusy(false);

    if (saved) {
      onClose();
    }
  }

  return (
    <div className="modal-backdrop schedule-detail-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="recurring-edit-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <p className="section-kicker">
              <Repeat2 size={15} />
              반복 업무
            </p>
            <h2>{habit ? "반복 업무 수정" : "반복 업무 추가"}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="닫기">
            <X size={18} />
          </button>
        </header>
        <form onSubmit={(event) => void submit(event)}>
          <label>
            이름
            <input
              autoFocus
              maxLength={recurringHabitTitleMaxLength}
              onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
              placeholder="반복 업무 이름"
              value={draft.title}
            />
          </label>
          <label>
            설명
            <textarea
              maxLength={recurringHabitDescriptionMaxLength}
              onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
              placeholder="간단한 설명"
              rows={4}
              value={draft.description}
            />
          </label>
          <div className="recurring-edit-grid">
            <label>
              구분
              <select
                onChange={(event) => setDraft((current) => ({ ...current, slot: event.target.value as RecurringHabitSlot }))}
                value={draft.slot}
              >
                {recurringHabitSlots.map((slot) => (
                  <option key={slot.key} value={slot.key}>
                    {slot.label}
                  </option>
                ))}
              </select>
            </label>
            <ScheduleColorPicker
              value={draft.color}
              onChange={(color) => setDraft((current) => ({ ...current, color }))}
            />
          </div>
          <fieldset className="recurring-icon-picker">
            <legend>이미지</legend>
            <div>
              {recurringHabitIconValues.map((icon) => (
                <button
                  className={draft.icon === icon ? "selected" : ""}
                  key={icon}
                  onClick={() => setDraft((current) => ({ ...current, color: recurringHabitIconMeta[icon].color, icon }))}
                  type="button"
                >
                  <HabitIconBadge color={recurringHabitIconMeta[icon].color} icon={icon} />
                  <span>{recurringHabitIconLabels[icon]}</span>
                </button>
              ))}
            </div>
          </fieldset>
          {localError && <p className="form-error">{localError}</p>}
          <footer>
            {habit ? (
              <button className="danger-button" type="button" onClick={() => onDelete(habit)}>
                <Trash2 size={16} />
                삭제
              </button>
            ) : (
              <span />
            )}
            <button disabled={busy} type="submit">
              <Save size={16} />
              {busy ? "저장 중" : "저장"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function RecurringOverviewModal({
  checkIns,
  habits,
  month,
  onClose,
  onMonthChange,
  onOpenHabit,
  today
}: {
  checkIns: RecurringHabitCheckInSnapshot[];
  habits: DecryptedRecurringHabit[];
  month: string;
  onClose: () => void;
  onMonthChange: (month: string) => void;
  onOpenHabit: (habitId: string) => void;
  today: string;
}) {
  const safeMonth = normalizeMonthString(month, today.slice(0, 7));
  const summaries = buildRecurringMonthlySummaries(habits, checkIns, safeMonth, today, today);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop schedule-detail-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="recurring-overview-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <p className="section-kicker">
              <LayoutGrid size={15} />
              월별 반복 조회
            </p>
            <h2>{recurringMonthLabel(safeMonth)}</h2>
          </div>
          <div>
            <button className="icon-button" type="button" aria-label="이전 달" onClick={() => onMonthChange(recurringMonthOffset(safeMonth, -1))}>
              <ChevronLeft size={17} />
            </button>
            <MonthPicker value={safeMonth} today={today} onChange={onMonthChange} />
            <button className="icon-button" type="button" aria-label="다음 달" onClick={() => onMonthChange(recurringMonthOffset(safeMonth, 1))}>
              <ChevronRight size={17} />
            </button>
            <button className="icon-button" type="button" onClick={onClose} aria-label="닫기">
              <X size={18} />
            </button>
          </div>
        </header>
        {summaries.length ? (
          <div className="recurring-overview-list">
            {summaries.map((summary) => (
              <button
                className="recurring-overview-item"
                key={summary.habit.id}
                onClick={() => onOpenHabit(summary.habit.id)}
                type="button"
              >
                <span className="recurring-overview-title">
                  <HabitIconBadge color={summary.habit.color} icon={summary.habit.icon} />
                  <span>
                    <strong>{summary.habit.title}</strong>
                    <small>{slotLabel(summary.habit.slot)}</small>
                  </span>
                </span>
                <span className="recurring-overview-stats">
                  <span className="metric-month">
                    <CheckCircle2 size={13} />
                    {summary.checkedDays}일
                  </span>
                  <span className="metric-total">
                    <Zap size={13} />
                    {summary.totalCheckIns}일
                  </span>
                  <span className="metric-percent">
                    <Percent size={13} />
                    {summary.percent}%
                  </span>
                  <span className="metric-streak">
                    <Flame size={13} />
                    {summary.streakDays}일
                  </span>
                </span>
                <MiniRecurringMonth checkIns={checkIns} habit={summary.habit} month={safeMonth} today={today} />
              </button>
            ))}
          </div>
        ) : (
          <p className="schedule-empty">조회할 반복 업무가 없습니다.</p>
        )}
      </section>
    </div>
  );
}

function MiniRecurringMonth({
  checkIns,
  habit,
  month,
  today
}: {
  checkIns: RecurringHabitCheckInSnapshot[];
  habit: DecryptedRecurringHabit;
  month: string;
  today: string;
}) {
  const weeks = buildRecurringMonthCalendar(month, today);

  return (
    <span className="recurring-mini-month" aria-hidden="true">
      {weeks.flatMap((week) =>
        week.days.map((day) => (
          <span
            className={[
              day.inCurrentMonth ? "" : "muted",
              isHabitCheckedOn(checkIns, habit.id, day.dateString) ? "checked" : ""
            ]
              .filter(Boolean)
              .join(" ")}
            key={day.dateString}
          />
        ))
      )}
    </span>
  );
}

function RecurringProgressRing({ percent, total }: { percent: number; total: number }) {
  const normalizedPercent = Math.max(0, Math.min(100, percent));

  return (
    <span
      aria-hidden="true"
      className="recurring-progress-ring"
      style={
        {
          "--recurring-progress": `${normalizedPercent}%`,
          "--recurring-progress-color": recurringProgressColor(normalizedPercent, total)
        } as CSSProperties
      }
    />
  );
}

function recurringProgressColor(percent: number, total: number) {
  if (total <= 0) {
    return "#d7ded9";
  }

  if (percent >= 100) {
    return "#2563eb";
  }

  if (percent >= 67) {
    return "#16a34a";
  }

  if (percent >= 34) {
    return "#f59e0b";
  }

  return "#dc2626";
}

function HabitIconBadge({ color, icon }: { color: string; icon: RecurringHabitIcon }) {
  const meta = recurringHabitIconMeta[icon] ?? recurringHabitIconMeta.other;
  const Icon = meta.Icon;
  const normalizedColor = normalizeScheduleTaskColor(color);
  const displayColor = normalizedColor.toLowerCase() === "#6fa99f" ? meta.color : normalizedColor;

  return (
    <span
      aria-label={meta.label}
      className="habit-icon-badge"
      style={{ "--habit-icon-color": displayColor } as CSSProperties}
      title={meta.label}
    >
      <Icon size={18} />
    </span>
  );
}

function recurringDraftFromHabit(habit: DecryptedRecurringHabit | null): RecurringHabitDraft {
  return {
    title: habit?.title ?? "",
    description: habit?.details.description ?? "",
    slot: habit?.slot ?? "morning",
    icon: habit?.icon ?? "work",
    color: normalizeScheduleTaskColor(habit?.color ?? recurringHabitIconMeta[habit?.icon ?? "work"].color)
  };
}

function nextRecurringHabitSortOrder(habits: DecryptedRecurringHabit[], slot: RecurringHabitSlot) {
  const slotOrders = habits
    .filter((habit) => habit.status === "active" && habit.slot === slot)
    .map((habit) => habit.sortOrder)
    .filter((value): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0);

  return slotOrders.length ? Math.max(...slotOrders) + 1 : habits.filter((habit) => habit.status === "active" && habit.slot === slot).length + 1;
}

function slotLabel(slot: RecurringHabitSlot) {
  return recurringHabitSlots.find((item) => item.key === slot)?.label ?? "기타";
}

function recurringMonthOffset(month: string, offset: number) {
  const safeMonth = normalizeMonthString(month);
  const [year, monthNumber] = safeMonth.split("-").map(Number);
  const nextDate = new Date(year, monthNumber - 1 + offset, 1);

  return `${nextDate.getFullYear()}-${`${nextDate.getMonth() + 1}`.padStart(2, "0")}`;
}

function recurringMonthLabel(month: string) {
  const safeMonth = normalizeMonthString(month);
  const [year, monthNumber] = safeMonth.split("-").map(Number);

  return new Intl.DateTimeFormat("ko-KR", { month: "long", year: "numeric" }).format(new Date(year, monthNumber - 1, 1));
}

function RecurringHabitReadModal({
  checkIns,
  dayStatePending,
  habit,
  onClose,
  onDelete,
  onEdit,
  onToggleChecklist,
  onUpdateDetails,
  onUpdateProgress,
  selectedDate,
  today
}: {
  checkIns: RecurringHabitCheckInSnapshot[];
  dayStatePending: boolean;
  habit: DecryptedRecurringHabit;
  onClose: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onToggleChecklist: (itemId: string) => void | Promise<void>;
  onUpdateDetails: (updateDetails: RecurringHabitDetailsUpdater) => boolean | Promise<boolean>;
  onUpdateProgress: (percent: number) => void | Promise<void>;
  selectedDate: string;
  today: string;
}) {
  const titleId = useId();
  const details = habit.details ?? { description: "", checklist: [] };
  const checkedItemIds = recurringHabitDayCheckedItemIds(checkIns, habit.id, selectedDate);
  const dailyProgressPercent = recurringHabitDayProgressPercent(habit, checkIns, selectedDate);
  const displayedChecklist = details.checklist.map((item) => ({ ...item, checked: checkedItemIds.has(item.id) }));
  const checklistGroups = checklistDisplayGroups(displayedChecklist);
  const hasChecklist = displayedChecklist.length > 0;
  const selectedDateIsEditable = isValidScheduleDateString(selectedDate) && selectedDate <= today;
  const [isDescriptionEditing, setIsDescriptionEditing] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState(details.description);
  const [progressPercent, setProgressPercent] = useState(() => normalizeTaskProgressPercent(dailyProgressPercent));
  const [pendingProgress, setPendingProgress] = useState(false);
  const [pendingDetailsAction, setPendingDetailsAction] = useState<string | null>(null);
  const [isAddingChecklist, setIsAddingChecklist] = useState(false);
  const [newChecklistText, setNewChecklistText] = useState("");
  const [editingChecklistItemId, setEditingChecklistItemId] = useState<string | null>(null);
  const [checklistEditText, setChecklistEditText] = useState("");
  const [isChecklistComposing, setIsChecklistComposing] = useState(false);
  const [pendingChecklistItemId, setPendingChecklistItemId] = useState<string | null>(null);
  const detailsMutationPending = pendingDetailsAction !== null || pendingChecklistItemId !== null;
  const dayMutationPending = dayStatePending || pendingProgress || pendingChecklistItemId !== null;

  useEffect(() => {
    setProgressPercent(normalizeTaskProgressPercent(dailyProgressPercent));
  }, [dailyProgressPercent, habit.id, selectedDate]);

  useEffect(() => {
    if (!isDescriptionEditing) {
      setDescriptionDraft(details.description);
    }
  }, [details.description, habit.id, isDescriptionEditing]);

  useEffect(() => {
    setEditingChecklistItemId(null);
    setChecklistEditText("");
    setIsAddingChecklist(false);
    setNewChecklistText("");
  }, [habit.id, selectedDate]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  async function changeProgress(percent: number) {
    if (!selectedDateIsEditable || dayMutationPending) {
      return;
    }

    const nextPercent = normalizeTaskProgressPercent(percent);

    setProgressPercent(nextPercent);
    setPendingProgress(true);

    try {
      await onUpdateProgress(nextPercent);
    } finally {
      setPendingProgress(false);
    }
  }

  async function saveInlineDetails(updateDetails: RecurringHabitDetailsUpdater, actionId: string) {
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

    if (!text || details.checklist.length >= recurringHabitChecklistMaxItems) {
      return;
    }

    const didSave = await saveInlineDetails(
      (currentDetails) => ({
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
        description: currentDetails.description,
        checklist: currentDetails.checklist.map((item) => (item.id === itemId ? { ...item, text, checked: false } : item))
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
    if (!selectedDateIsEditable || dayMutationPending) {
      return;
    }

    setPendingChecklistItemId(itemId);

    try {
      await onToggleChecklist(itemId);
    } finally {
      setPendingChecklistItemId(null);
    }
  }

  return (
    <div className="modal-backdrop schedule-detail-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="schedule-read-modal recurring-read-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div className="recurring-read-title">
            <HabitIconBadge color={habit.color} icon={habit.icon} />
            <div>
              <p className="section-kicker">
                <Repeat2 size={15} />
                반복 업무
              </p>
              <h2 id={titleId}>{habit.title}</h2>
            </div>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="닫기">
            <X size={18} />
          </button>
        </header>

        <div className="task-read-meta">
          <span>{formatDateLabel(selectedDate)}</span>
          <span>{slotLabel(habit.slot)}</span>
          <span>{recurringHabitIconLabels[habit.icon]}</span>
          <span>매일 초기화</span>
        </div>

        <TaskProgressControl
          disabled={!selectedDateIsEditable || dayMutationPending}
          helperText={selectedDateIsEditable ? (dayMutationPending ? "저장 중" : "선택 날짜 기준") : "미래 날짜는 수정할 수 없습니다"}
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
              maxLength={recurringHabitDescriptionMaxLength}
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
              disabled={detailsMutationPending || details.checklist.length >= recurringHabitChecklistMaxItems}
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
                maxLength={recurringHabitChecklistItemMaxLength}
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
                          disabled={detailsMutationPending || dayMutationPending || !selectedDateIsEditable}
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
                              maxLength={recurringHabitChecklistItemMaxLength}
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
          <button className="danger-button" type="button" onClick={onDelete}>
            <Trash2 size={17} />
            삭제
          </button>
          <div>
            <button type="button" onClick={onEdit}>
              <Pencil size={17} />
              수정
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function TaskDeleteConfirmDialog({
  error,
  onCancel,
  onConfirm,
  pending,
  task
}: {
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  pending: boolean;
  task: DecryptedScheduleTask;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const targetId = useId();
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const displayTitle = task.title.trim() || "제목 없는 일정";

  useLayoutEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    cancelButtonRef.current?.focus({ preventScroll: true });

    return () => {
      window.setTimeout(() => {
        if (previouslyFocused?.isConnected) {
          previouslyFocused.focus({ preventScroll: true });
        }
      }, 0);
    };
  }, []);

  function handleKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();

      if (!pending) {
        onCancel();
      }
      return;
    }

    if (event.key !== "Tab") {
      return;
    }

    const focusableElements = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled)")
    );
    const firstFocusableElement = focusableElements[0];
    const lastFocusableElement = focusableElements.at(-1);

    if (!firstFocusableElement || !lastFocusableElement) {
      event.preventDefault();
      return;
    }

    if (event.shiftKey && document.activeElement === firstFocusableElement) {
      event.preventDefault();
      lastFocusableElement.focus();
    } else if (!event.shiftKey && document.activeElement === lastFocusableElement) {
      event.preventDefault();
      firstFocusableElement.focus();
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
        role="alertdialog"
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
            disabled={pending}
            ref={cancelButtonRef}
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
  inactive,
  onClose,
  onDelete,
  onDuplicate,
  onEdit,
  onToggleChecklist,
  onUpdateDetails,
  onUpdateProgress,
  task
}: {
  duplicationPending: boolean;
  inactive: boolean;
  onClose: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onEdit: () => void;
  onToggleChecklist: (itemId: string) => void | Promise<void>;
  onUpdateDetails: (updateDetails: TaskDetailsUpdater) => boolean | Promise<boolean>;
  onUpdateProgress: (percent: number) => void | Promise<void>;
  task: DecryptedScheduleTask;
}) {
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
          <button className="danger-button" type="button" onClick={onDelete}>
            <Trash2 size={17} />
            삭제
          </button>
          <div>
            <button
              className="secondary-button"
              disabled={duplicationPending}
              type="button"
              onClick={onDuplicate}
            >
              {duplicationPending ? <LoaderCircle aria-hidden="true" className="spin" size={17} /> : <Copy size={17} />}
              {duplicationPending ? "복사 중" : "복사"}
            </button>
            <button type="button" onClick={onEdit}>
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
  inactive,
  onClose,
  onDelete,
  onSave,
  task
}: {
  inactive: boolean;
  onClose: () => void;
  onDelete: () => void;
  onSave: (draft: TaskDraft) => void;
  task: DecryptedScheduleTask;
}) {
  const [draft, setDraft] = useState<TaskDraft>(() => draftFromTask(task));
  const [checklistText, setChecklistText] = useState("");
  const [isChecklistComposing, setIsChecklistComposing] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const checklistGroups = useMemo(() => checklistDisplayGroups(draft.checklist), [draft.checklist]);

  useEffect(() => {
    setDraft(draftFromTask(task));
  }, [task]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !inactive) {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [inactive, onClose]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
    onSave({
      ...submittedDraft,
      endDate: submittedDraft.endDate || submittedDraft.startDate
    });
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
      onMouseDown={inactive ? undefined : onClose}
    >
      <section className="schedule-detail-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <button className="icon-button" type="button" onClick={onClose} aria-label="닫기">
            <X size={18} />
          </button>
        </header>
        <form onSubmit={submit}>
          <label>
            제목
            <input
              autoFocus
              onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
              required
              value={draft.title}
            />
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
              <select
                onChange={(event) => {
                  const nextMode = event.target.value as TaskDraft["timeMode"];
                  setDraft((current) => applyScheduleTimeMode(current, nextMode));
                }}
                value={draft.timeMode}
              >
                <option value="none">시간 없음</option>
                <option value="point">시각</option>
                <option value="range">시간 범위</option>
              </select>
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
          {localError && <p className="form-error">{localError}</p>}
          <footer>
            <button className="danger-button" type="button" onClick={onDelete}>
              <Trash2 size={17} />
              삭제
            </button>
            <button type="submit">
              <Save size={17} />
              저장
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
    formatTaskDateDisplay(task),
    task.isImportant ? "중요" : "",
    task.isUrgent ? "긴급" : "",
    task.status === "completed" ? "완료" : "진행"
  ]
    .join(" ")
    .toLocaleLowerCase("ko")
    .includes(term);
}

function recurringHabitMatchesQuery(habit: DecryptedRecurringHabit, query: string) {
  const term = normalizedScheduleSearch(query);

  if (!term) {
    return true;
  }

  return [
    habit.title,
    habit.details.description,
    habit.details.checklist.map((item) => item.text).join(" "),
    slotLabel(habit.slot),
    recurringHabitIconLabels[habit.icon]
  ]
    .join(" ")
    .toLocaleLowerCase("ko")
    .includes(term);
}

function scheduleDashboardStats(tasks: DecryptedScheduleTask[], habits: DecryptedRecurringHabit[], today: string) {
  const activeTasks = tasks.filter((task) => task.status !== "completed");

  return {
    active: activeTasks.length,
    completed: tasks.length - activeTasks.length,
    overdue: activeTasks.filter((task) => isTaskScheduleOverdue(task, today)).length,
    recurring: habits.filter((habit) => habit.status === "active").length,
    today: activeTasks.filter((task) => taskCoversDate(task, today)).length
  };
}

function scheduleActionError(caught: unknown, fallback: string) {
  const error = caught as { code?: unknown; message?: unknown };
  const code = typeof error.code === "string" ? error.code : "";

  if (code.includes("permission-denied")) {
    return `${fallback} Firestore 권한이 거부되었습니다. 규칙 배포 상태와 사용자 활성 상태를 확인해주세요.`;
  }

  if (code.includes("failed-precondition")) {
    return `${fallback} Firestore 인덱스 또는 쿼리 조건을 확인해주세요.`;
  }

  if (typeof error.message === "string" && error.message) {
    return `${fallback} ${error.message}`;
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

function formatCompletedTaskMeta(task: DecryptedScheduleTask) {
  const completedDate = taskCompletedDate(task);
  const parts = completedDate ? [`완료 ${formatDateLabel(completedDate)}`] : ["완료일 없음"];

  parts.push(formatTaskMeta(task));
  return parts.join(" · ");
}

function taskCompletedDate(task: DecryptedScheduleTask) {
  const completedAt = timestampMillis(task.completedAt);
  return completedAt ? toLocalDateString(new Date(completedAt)) : null;
}

function timestampMillis(value: { toMillis?: () => number } | null | undefined) {
  return value && typeof value.toMillis === "function" ? value.toMillis() : 0;
}

function completedTaskInMonthWindow(completedDate: string, month: string, months: CompletedMonthsFilter) {
  if (months === "all") {
    return true;
  }

  const range = completedMonthRange(month, months);
  return completedDate >= range.start && completedDate <= range.end;
}

function completedMonthRangeLabel(month: string, months: CompletedMonthsFilter) {
  if (months === "all") {
    return "전체 기간";
  }

  const range = completedMonthRange(month, months);
  return range.start.slice(0, 7) === range.end.slice(0, 7)
    ? `${range.end.slice(0, 7)} 완료`
    : `${range.start.slice(0, 7)} - ${range.end.slice(0, 7)} 완료`;
}

function completedMonthRange(month: string, months: Exclude<CompletedMonthsFilter, "all">) {
  const [yearText, monthText] = month.split("-");
  const year = Number(yearText);
  const monthNumber = Number(monthText);
  const count = Number(months);
  const safeDate =
    Number.isInteger(year) && Number.isInteger(monthNumber) && monthNumber >= 1 && monthNumber <= 12
      ? new Date(year, monthNumber - 1, 1)
      : new Date();
  const start = new Date(safeDate.getFullYear(), safeDate.getMonth() - count + 1, 1);
  const end = new Date(safeDate.getFullYear(), safeDate.getMonth() + 1, 0);

  return {
    start: toLocalDateString(start),
    end: toLocalDateString(end)
  };
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

function taskCoversDate(task: DecryptedScheduleTask, dateString: string) {
  const startDate = taskStartDate(task);
  const endDate = taskEndDate(task);

  return Boolean(startDate && startDate <= dateString && (!endDate || endDate >= dateString));
}
