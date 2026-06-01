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
  Minus,
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
import { FormEvent, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import { serverTimestamp } from "firebase/firestore";
import { AppShell } from "../components/AppShell";
import { UnlockPanel } from "../components/UnlockPanel";
import { useAuth } from "../context/AuthContext";
import { decryptText, encryptText, generateNoteKey, unwrapNoteKey, wrapNoteKey } from "../lib/crypto";
import { getKoreanHolidayMapForDates, type KoreanHoliday } from "../lib/koreanHolidays";
import { defaultMatrixLabels } from "../lib/matrixLabels";
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
  recurringCheckInId,
  recurringHabitDayCheckedItemIds,
  recurringHabitDayProgressPercent,
  recurringHabitIconLabels,
  recurringHabitIconValues,
  recurringHabitSlots
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
  updateRecurringHabit,
  updateRecurringHabitDayState,
  updateRecurringHabitOrderBatch,
  type RecurringHabitCheckInSnapshot,
  type RecurringHabitSnapshot
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

const scheduleTabs: Array<{ view: ScheduleView; label: string; shortLabel: string; Icon: LucideIcon }> = [
  { view: "todo", label: "할 일", shortLabel: "할 일", Icon: ListTodo },
  { view: "calendar", label: "달력", shortLabel: "달력", Icon: CalendarDays },
  { view: "matrix", label: "매트릭스", shortLabel: "매트릭스", Icon: Grid2X2 },
  { view: "recurring", label: "반복", shortLabel: "반복", Icon: Repeat2 },
  { view: "completed", label: "완료", shortLabel: "완료", Icon: CheckCircle2 }
];

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

type DecryptedTaskCache = Map<string, { signature: string; task: DecryptedScheduleTask }>;
type DecryptedHabitCache = Map<string, { habit: DecryptedRecurringHabit; signature: string }>;

function scheduleTimestampSignature(value: { seconds: number; nanoseconds: number } | null | undefined) {
  return value ? `${value.seconds}:${value.nanoseconds}` : "";
}

function schedulePayloadSignature(payload: ScheduleTaskSnapshot["encryptedTitle"]) {
  return `${payload.version}:${payload.algorithm}:${payload.iv}:${payload.cipherText}`;
}

function scheduleWrappedKeySignature(wrappedKey: ScheduleTaskSnapshot["wrappedKeys"][string] | undefined) {
  return wrappedKey ? `${wrappedKey.version}:${wrappedKey.algorithm}:${wrappedKey.wrappedKey}` : "";
}

function pruneScheduleDecryptCache<TCache extends Map<string, unknown>>(cache: TCache, snapshots: Array<{ id: string }>) {
  const activeIds = new Set(snapshots.map((snapshot) => snapshot.id));

  for (const id of cache.keys()) {
    if (!activeIds.has(id)) {
      cache.delete(id);
    }
  }
}

function taskDecryptSignature(task: ScheduleTaskSnapshot, uid: string) {
  return [
    task.id,
    task.ownerUid,
    task.status,
    task.dueDate ?? "",
    task.dueTimeMinutes ?? "",
    task.startDate ?? "",
    task.endDate ?? "",
    task.startTimeMinutes ?? "",
    task.endTimeMinutes ?? "",
    task.color ?? "",
    task.sortOrder ?? "",
    task.progressPercent ?? "",
    task.isImportant ? "important" : "normal",
    task.isUrgent ? "urgent" : "later",
    task.createdBy,
    task.updatedBy,
    scheduleTimestampSignature(task.createdAt),
    scheduleTimestampSignature(task.updatedAt),
    scheduleTimestampSignature(task.completedAt),
    schedulePayloadSignature(task.encryptedTitle),
    schedulePayloadSignature(task.encryptedDetails),
    scheduleWrappedKeySignature(task.wrappedKeys[uid])
  ].join("|");
}

function habitDecryptSignature(habit: RecurringHabitSnapshot, uid: string) {
  return [
    habit.id,
    habit.ownerUid,
    habit.status,
    habit.slot,
    habit.icon,
    habit.color,
    habit.sortOrder ?? "",
    habit.createdBy,
    habit.updatedBy,
    scheduleTimestampSignature(habit.createdAt),
    scheduleTimestampSignature(habit.updatedAt),
    schedulePayloadSignature(habit.encryptedTitle),
    schedulePayloadSignature(habit.encryptedDetails),
    scheduleWrappedKeySignature(habit.wrappedKeys[uid])
  ].join("|");
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

export default function SchedulePage() {
  const { privateKey, profile } = useAuth();
  const [activeView, setActiveView] = useState<ScheduleView | null>(() =>
    profile ? getCachedUserPreferences(profile.uid)?.scheduleDefaultView ?? null : null
  );
  const [matrixLabels, setMatrixLabels] = useState<MatrixLabels>(() =>
    profile ? getCachedUserPreferences(profile.uid)?.matrixLabels ?? defaultMatrixLabels : defaultMatrixLabels
  );
  const [tasks, setTasks] = useState<ScheduleTaskSnapshot[]>([]);
  const [decryptedTasks, setDecryptedTasks] = useState<DecryptedScheduleTask[]>([]);
  const [recurringHabits, setRecurringHabits] = useState<RecurringHabitSnapshot[]>([]);
  const [decryptedRecurringHabits, setDecryptedRecurringHabits] = useState<DecryptedRecurringHabit[]>([]);
  const [recurringCheckIns, setRecurringCheckIns] = useState<RecurringHabitCheckInSnapshot[]>([]);
  const [viewTaskId, setViewTaskId] = useState<string | null>(null);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [viewRecurringHabitId, setViewRecurringHabitId] = useState<string | null>(null);
  const [readRecurringHabitId, setReadRecurringHabitId] = useState<string | null>(null);
  const [recurringHabitDialog, setRecurringHabitDialog] = useState<RecurringHabitDialogState | null>(null);
  const [recurringOverviewOpen, setRecurringOverviewOpen] = useState(false);
  const [todayPanelOpen, setTodayPanelOpen] = useState(false);
  const [selectedRecurringDate, setSelectedRecurringDate] = useState(() => toLocalDateString(new Date()));
  const [recurringMonth, setRecurringMonth] = useState(() => toLocalDateString(new Date()).slice(0, 7));
  const [pendingRecurringCheckIn, setPendingRecurringCheckIn] = useState<Record<string, boolean>>({});
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
  const decryptedTasksRef = useRef<DecryptedScheduleTask[]>([]);
  const decryptedRecurringHabitsRef = useRef<DecryptedRecurringHabit[]>([]);
  const decryptedTaskCacheRef = useRef<DecryptedTaskCache>(new Map());
  const decryptedHabitCacheRef = useRef<DecryptedHabitCache>(new Map());
  const taskDetailsUpdateQueueRef = useRef<Partial<Record<string, Promise<ScheduleTaskDetails>>>>({});
  const recurringDetailsUpdateQueueRef = useRef<Partial<Record<string, Promise<RecurringHabitDetails>>>>({});

  useEffect(() => {
    if (!profile) {
      setActiveView(null);
      return undefined;
    }

    let active = true;
    const cachedPreferences = getCachedUserPreferences(profile.uid);

    setActiveView(cachedPreferences?.scheduleDefaultView ?? null);
    void getUserPreferences(profile.uid)
      .then((preferences) => {
        if (active) {
          setActiveView(preferences.scheduleDefaultView);
        }
      })
      .catch(() => {
        if (active) {
          setActiveView(cachedPreferences?.scheduleDefaultView ?? defaultUserPreferences.scheduleDefaultView);
        }
      });

    return () => {
      active = false;
    };
  }, [profile]);

  useEffect(() => {
    if (!profile) {
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
  }, [profile]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      const nextToday = toLocalDateString(new Date());

      setToday(nextToday);
    }, 60 * 1000);

    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    setSelectedRecurringDate((current) => (current < today ? today : current));
    setRecurringMonth((current) => current || today.slice(0, 7));
  }, [today]);

  useEffect(() => {
    if (!profile) {
      return undefined;
    }

    return subscribeScheduleTasks(
      profile.uid,
      (nextTasks) => {
        setTasks(nextTasks);
        setError(null);
      },
      (caught) => setError(scheduleActionError(caught, "일정 목록을 불러오지 못했습니다."))
    );
  }, [profile]);

  useEffect(() => {
    if (!profile) {
      setRecurringHabits([]);
      setRecurringCheckIns([]);
      return undefined;
    }

    const unsubscribeHabits = subscribeRecurringHabits(
      profile.uid,
      (nextHabits) => {
        setRecurringHabits(nextHabits);
        setError(null);
      },
      (caught) => setError(scheduleActionError(caught, "반복 업무를 불러오지 못했습니다."))
    );
    const unsubscribeCheckIns = subscribeRecurringHabitCheckIns(
      profile.uid,
      (nextCheckIns) => {
        setRecurringCheckIns(nextCheckIns);
        setError(null);
      },
      (caught) => setError(scheduleActionError(caught, "반복 체크인을 불러오지 못했습니다."))
    );

    return () => {
      unsubscribeHabits();
      unsubscribeCheckIns();
    };
  }, [profile]);

  useEffect(() => {
    if (!profile || !privateKey) {
      decryptedTaskCacheRef.current.clear();
      setDecryptedTasks([]);
      return undefined;
    }

    const safeProfile = profile;
    const safePrivateKey = privateKey;
    let active = true;

    async function decryptTasks() {
      pruneScheduleDecryptCache(decryptedTaskCacheRef.current, tasks);
      const nextTasks = await Promise.all(
        tasks.map(async (task) => {
          const wrappedKey = task.wrappedKeys[safeProfile.uid];

          if (!wrappedKey) {
            decryptedTaskCacheRef.current.delete(task.id);
            return null;
          }

          const signature = taskDecryptSignature(task, safeProfile.uid);
          const cached = decryptedTaskCacheRef.current.get(task.id);

          if (cached?.signature === signature) {
            return cached.task;
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

            decryptedTaskCacheRef.current.set(task.id, { signature, task: decryptedTask });
            return decryptedTask;
          } catch {
            decryptedTaskCacheRef.current.delete(task.id);
            return null;
          }
        })
      );

      if (active) {
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

    async function decryptHabits() {
      pruneScheduleDecryptCache(decryptedHabitCacheRef.current, recurringHabits);
      const nextHabits = await Promise.all(
        recurringHabits.map(async (habit) => {
          const wrappedKey = habit.wrappedKeys[safeProfile.uid];

          if (!wrappedKey) {
            decryptedHabitCacheRef.current.delete(habit.id);
            return null;
          }

          const signature = habitDecryptSignature(habit, safeProfile.uid);
          const cached = decryptedHabitCacheRef.current.get(habit.id);

          if (cached?.signature === signature) {
            return cached.habit;
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

            decryptedHabitCacheRef.current.set(habit.id, { habit: decryptedHabit, signature });
            return decryptedHabit;
          } catch {
            decryptedHabitCacheRef.current.delete(habit.id);
            return null;
          }
        })
      );

      if (active) {
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
  const displayedTasks = useMemo(
    () => sortedTasks.filter((task) => scheduleTaskMatchesQuery(task, scheduleQuery)),
    [scheduleQuery, sortedTasks]
  );
  const displayedRecurringHabits = useMemo(
    () => decryptedRecurringHabits.filter((habit) => recurringHabitMatchesQuery(habit, scheduleQuery)),
    [decryptedRecurringHabits, scheduleQuery]
  );
  const scheduleStats = useMemo(
    () => scheduleDashboardStats(sortedTasks, decryptedRecurringHabits, today),
    [decryptedRecurringHabits, sortedTasks, today]
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
    () => decryptedRecurringHabits.find((habit) => habit.id === viewRecurringHabitId) ?? null,
    [decryptedRecurringHabits, viewRecurringHabitId]
  );
  const readRecurringHabit = useMemo(
    () => decryptedRecurringHabits.find((habit) => habit.id === readRecurringHabitId) ?? null,
    [decryptedRecurringHabits, readRecurringHabitId]
  );
  const editingRecurringHabit = useMemo(
    () => decryptedRecurringHabits.find((habit) => habit.id === recurringHabitDialog?.habitId) ?? null,
    [decryptedRecurringHabits, recurringHabitDialog?.habitId]
  );
  const completedTasks = useMemo(
    () => displayedTasks.filter((task) => task.status === "completed").sort(compareCompletedTasks),
    [displayedTasks]
  );
  const todoGroups = useMemo(() => groupTasksByTodoDate(displayedTasks, today), [displayedTasks, today]);
  const matrixSections = useMemo(() => groupTasksByMatrix(displayedTasks, today, matrixLabels), [displayedTasks, matrixLabels, today]);
  const activeMatrixTaskCount = useMemo(() => sortedTasks.filter((task) => task.status !== "completed").length, [sortedTasks]);
  const visibleMatrixTaskCount = useMemo(
    () => displayedTasks.filter((task) => task.status !== "completed").length,
    [displayedTasks]
  );
  const calendarWeeks = useMemo(
    () => buildCalendarMonth(calendarCursor.getFullYear(), calendarCursor.getMonth(), today),
    [calendarCursor, today]
  );
  const calendarTaskMap = useMemo(() => tasksByDate(displayedTasks), [displayedTasks]);
  const calendarTaskLayout = useMemo(
    () => buildCalendarTaskLayout(calendarWeeks, displayedTasks),
    [calendarWeeks, displayedTasks]
  );
  const calendarDateStrings = useMemo(
    () => calendarWeeks.flatMap((week) => week.days.map((day) => day.dateString)),
    [calendarWeeks]
  );
  const calendarHolidayMap = useKoreanHolidayMap(calendarDateStrings);
  const selectedDayTasks = useMemo(
    () => [...(calendarTaskMap[selectedCalendarDate] ?? [])].sort(compareCalendarAgendaTasks),
    [calendarTaskMap, selectedCalendarDate]
  );
  const todayWorkSummary = useMemo<TodayWorkSummary>(() => {
    const activeTasks = sortedTasks.filter((task) => task.status !== "completed");
    const overdueTasks = activeTasks.filter((task) => isTaskScheduleOverdue(task, today));
    const todayTasks = activeTasks.filter((task) => taskCoversDate(task, today) && !isTaskScheduleOverdue(task, today));
    const recurringHabitsForToday = decryptedRecurringHabits.filter((habit) => habit.status === "active");

    return { overdueTasks, recurringHabits: recurringHabitsForToday, todayTasks };
  }, [decryptedRecurringHabits, sortedTasks, today]);

  useEffect(() => {
    if (viewRecurringHabitId && !selectedRecurringHabit) {
      setViewRecurringHabitId(null);
    }
    if (readRecurringHabitId && !readRecurringHabit) {
      setReadRecurringHabitId(null);
    }
  }, [readRecurringHabit, readRecurringHabitId, selectedRecurringHabit, viewRecurringHabitId]);

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

      await createScheduleTask({
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

  async function saveTask(task: DecryptedScheduleTask, draft: TaskDraft) {
    const wrappedKey = task.wrappedKeys[unlockedProfile.uid];

    if (!wrappedKey) {
      setError("일정 암호화 키를 찾지 못했습니다.");
      return;
    }

    try {
      const taskKey = await unwrapNoteKey(wrappedKey, unlockedPrivateKey);
      const details: ScheduleTaskDetails = {
        description: draft.description,
        checklist: draft.checklist
          .map((item) => ({ ...item, text: item.text.trim() }))
          .filter((item) => item.text)
      };
      const [encryptedTitle, encryptedDetails] = await encryptTaskFields(draft.title, details, taskKey);
      const nextCompleted = draft.status === "completed";
      const startDate = draft.startDate || null;
      const endDate = draft.endDate || startDate;
      const startTimeMinutes = draft.timeMode === "none" ? null : timeInputToMinutes(draft.startTime);
      const endTimeMinutes = draft.timeMode === "range" ? timeInputToMinutes(draft.endTime) : null;

      if (startDate && !isSafeScheduleDateRange(startDate, endDate)) {
        setError(scheduleDateRangeValidationMessage);
        return;
      }

      await updateScheduleTask(task.id, unlockedProfile.uid, {
        encryptedTitle,
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
      });
      setEditingTaskId(null);
      setViewTaskId(null);
      setStatus("일정을 저장했습니다.");
      setError(null);
    } catch (caught) {
      setError(scheduleActionError(caught, "일정을 저장하지 못했습니다."));
    }
  }

  function currentTaskDetails(task: DecryptedScheduleTask) {
    return decryptedTasksRef.current.find((currentTask) => currentTask.id === task.id)?.details ?? task.details ?? emptyScheduleDetails;
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

      await createScheduleTask({
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
      setStatus("일정을 복사했습니다.");
      setError(null);
    } catch (caught) {
      setError(scheduleActionError(caught, "일정을 복사하지 못했습니다."));
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
      setStatus("업무 위치를 변경했습니다.");
      setError(null);
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

  async function removeTask(task: DecryptedScheduleTask) {
    try {
      await deleteScheduleTask(task.id);
      setEditingTaskId(null);
      setViewTaskId(null);
      setStatus("일정을 삭제했습니다.");
      setError(null);
    } catch (caught) {
      setError(scheduleActionError(caught, "일정을 삭제하지 못했습니다."));
    }
  }

  async function encryptRecurringHabitFields(title: string, details: RecurringHabitDetails, habitKey: CryptoKey) {
    const normalizedDetails = normalizeMutableRecurringHabitDetails(details);

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

  function normalizeMutableRecurringHabitDetails(details: RecurringHabitDetails): RecurringHabitDetails {
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
      .then(async (queuedDetails) => {
        const habitKey = await unwrapNoteKey(wrappedKey, unlockedPrivateKey);
        const nextDetails = normalizeMutableRecurringHabitDetails(updateDetails(queuedDetails));
        const encryptedDetails = await encryptText(JSON.stringify(nextDetails), habitKey);

        await updateRecurringHabit(habit.id, unlockedProfile.uid, { encryptedDetails });
        return nextDetails;
      });

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

    if (!trimmedTitle) {
      setError("반복 업무 이름을 입력해주세요.");
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

    if (!draft.title.trim()) {
      setError("반복 업무 이름을 입력해주세요.");
      return false;
    }

    try {
      const habitKey = await unwrapNoteKey(wrappedKey, unlockedPrivateKey);
      const currentDetails = currentRecurringHabitDetails(habit);
      const [encryptedTitle, encryptedDetails] = await encryptRecurringHabitFields(
        draft.title,
        { description: draft.description, checklist: currentDetails.checklist },
        habitKey
      );

      await updateRecurringHabit(habit.id, unlockedProfile.uid, {
        encryptedTitle,
        encryptedDetails,
        slot: draft.slot,
        icon: draft.icon,
        color: normalizeScheduleTaskColor(draft.color)
      });
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
    try {
      await deleteRecurringHabit(habit.id, unlockedProfile.uid);
      setRecurringHabitDialog(null);
      setViewRecurringHabitId(null);
      setReadRecurringHabitId(null);
      setStatus("반복 업무를 삭제했습니다.");
      setError(null);
    } catch (caught) {
      setError(scheduleActionError(caught, "반복 업무를 삭제하지 못했습니다."));
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
    const previousCheckIns = recurringCheckIns;

    setPendingRecurringCheckIn((current) => ({ ...current, [checkInId]: true }));
    setRecurringCheckIns((current) => {
      if (!nextChecked) {
        return current.filter((checkIn) => !(checkIn.habitId === habit.id && checkIn.date === date));
      }

      if (current.some((checkIn) => checkIn.habitId === habit.id && checkIn.date === date)) {
        return current.map((checkIn) =>
          checkIn.habitId === habit.id && checkIn.date === date
            ? { ...checkIn, completed: true, progressPercent: 100 }
            : checkIn
        );
      }

      return [
        ...current,
        {
          id: checkInId,
          ownerUid: unlockedProfile.uid,
          habitId: habit.id,
          date,
          completed: true,
          progressPercent: 100,
          checkedItemIds: []
        }
      ];
    });

    try {
      await setRecurringHabitCheckIn(unlockedProfile.uid, habit.id, date, nextChecked);
      setError(null);
    } catch (caught) {
      setRecurringCheckIns(previousCheckIns);
      setError(scheduleActionError(caught, "반복 체크인을 저장하지 못했습니다."));
    } finally {
      setPendingRecurringCheckIn((current) => {
        const next = { ...current };
        delete next[checkInId];
        return next;
      });
    }
  }

  async function updateRecurringHabitDailyState(
    habit: DecryptedRecurringHabit,
    date: string,
    input: { checkedItemIds?: string[]; completed?: boolean; progressPercent?: number | null }
  ) {
    if (!isValidScheduleDateString(date) || date > today) {
      setError("오늘 또는 지난 날짜만 수정할 수 있습니다.");
      return false;
    }

    const checkInId = recurringCheckInId(habit.id, date);
    const previousCheckIns = recurringCheckIns;

    setPendingRecurringCheckIn((current) => ({ ...current, [checkInId]: true }));
    setRecurringCheckIns((current) => {
      const existing = current.find((checkIn) => checkIn.habitId === habit.id && checkIn.date === date);
      const nextState: RecurringHabitCheckInSnapshot = {
        id: checkInId,
        ownerUid: unlockedProfile.uid,
        habitId: habit.id,
        date,
        ...(existing ?? {}),
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
      await updateRecurringHabitDayState(unlockedProfile.uid, habit.id, date, input);
      setError(null);
      return true;
    } catch (caught) {
      setRecurringCheckIns(previousCheckIns);
      setError(scheduleActionError(caught, "반복 업무 진행 상태를 저장하지 못했습니다."));
      return false;
    } finally {
      setPendingRecurringCheckIn((current) => {
        const next = { ...current };
        delete next[checkInId];
        return next;
      });
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
      progressPercent
    });
  }

  function quickDefaultsForActiveView(): QuickDefaults {
    const color = nextScheduleTaskColor(decryptedTasks);

    if (activeView === "calendar") {
      return { startDate: selectedCalendarDate, endDate: selectedCalendarDate, color };
    }

    return { startDate: today, endDate: today, color };
  }

  function moveCalendarMonth(offset: number) {
    setCalendarCursor((current) => new Date(current.getFullYear(), current.getMonth() + offset, 1));
  }

  function goToday() {
    const nextToday = new Date();
    setCalendarCursor(new Date(nextToday.getFullYear(), nextToday.getMonth(), 1));
    setSelectedCalendarDate(toLocalDateString(nextToday));
  }

  function openTodayWorkPanel() {
    const nextToday = toLocalDateString(new Date());
    const nextDate = new Date(`${nextToday}T00:00:00`);

    setCalendarCursor(new Date(nextDate.getFullYear(), nextDate.getMonth(), 1));
    setSelectedCalendarDate(nextToday);
    setSelectedRecurringDate(nextToday);
    setRecurringMonth(nextToday.slice(0, 7));
    setTodayPanelOpen(true);
  }

  function openQuickTaskDialog() {
    if (activeView === "matrix") {
      setCreateDialog({
        defaults: { startDate: today, endDate: today, color: nextScheduleTaskColor(decryptedTasks), isImportant: true, isUrgent: true },
        title: "매트릭스 일정 추가"
      });
      return;
    }

    if (activeView === "calendar") {
      openCalendarCreateDialog(selectedCalendarDate);
      return;
    }

    setCreateDialog({
      defaults: { startDate: today, endDate: today, color: nextScheduleTaskColor(decryptedTasks) },
      title: "새 일정 추가"
    });
  }

  function openQuickRecurringDialog() {
    setActiveView("recurring");
    setRecurringHabitDialog({ mode: "create" });
  }

  function openCalendarCreateDialog(dateString: string) {
    setSelectedCalendarDate(dateString);
    setCreateDialog({
      defaults: { startDate: dateString, endDate: dateString, color: nextScheduleTaskColor(decryptedTasks) },
      title: `${formatDateLabel(dateString)} 일정 추가`
    });
  }

  function openMatrixCreateDialog(section: MatrixSection) {
    const defaultDate = section.key === "firstPriority" ? addDays(today, 1) : today;

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

  return (
    <AppShell>
      <section className="schedule-workspace">
        <header className="schedule-header">
          <div>
            <p className="section-kicker">
              <CalendarDays size={16} />
              일정관리
            </p>
            <h1>{scheduleTabs.find((tab) => tab.view === activeView)?.label ?? "일정관리"}</h1>
          </div>
          <label className="schedule-search-control">
            <Search size={17} aria-hidden="true" />
            <span className="sr-only">일정 검색</span>
            <input
              aria-label="일정과 반복 업무 검색"
              onChange={(event) => setScheduleQuery(event.target.value)}
              placeholder="일정, 설명, 체크리스트 검색"
              type="search"
              value={scheduleQuery}
            />
          </label>
          <nav className="schedule-view-tabs" role="tablist" aria-label="일정관리 보기">
            {scheduleTabs.map(({ Icon, label, shortLabel, view }) => (
              <button
                key={view}
                aria-selected={activeView === view}
                className={activeView === view ? "active" : ""}
                role="tab"
                type="button"
                onClick={() => setActiveView(view)}
                aria-label={label}
              >
                <Icon size={18} />
                <span>{shortLabel}</span>
              </button>
            ))}
          </nav>
        </header>

        <section className="schedule-command-panel" aria-label="일정 요약과 빠른 작업">
          <div className="schedule-stat-grid">
            <span className="schedule-stat-card today">
              <strong>{scheduleStats.today}</strong>
              <em>오늘</em>
            </span>
            <span className="schedule-stat-card overdue">
              <strong>{scheduleStats.overdue}</strong>
              <em>지연</em>
            </span>
            <span className="schedule-stat-card active">
              <strong>{scheduleStats.active}</strong>
              <em>진행 중</em>
            </span>
            <span className="schedule-stat-card completed">
              <strong>{scheduleStats.completed}</strong>
              <em>완료</em>
            </span>
            <span className="schedule-stat-card recurring">
              <strong>{scheduleStats.recurring}</strong>
              <em>반복</em>
            </span>
          </div>
          <div className="schedule-quick-actions">
            {scheduleQuery.trim() && (
              <span className="schedule-query-result">
                검색 결과 {displayedTasks.length + displayedRecurringHabits.length}개
              </span>
            )}
            <button className="secondary-button" type="button" onClick={openTodayWorkPanel}>
              <Zap size={16} />
              오늘 업무
            </button>
            <button type="button" onClick={openQuickTaskDialog}>
              <Plus size={16} />
              새 일정
            </button>
            <button className="secondary-button" type="button" onClick={openQuickRecurringDialog}>
              <Repeat2 size={16} />
              반복 업무
            </button>
          </div>
        </section>

        {todayPanelOpen && (
          <TodayWorkPanel
            checkIns={recurringCheckIns}
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
            onClose={() => setTodayPanelOpen(false)}
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
          <ScheduleCreateForm
            defaults={quickDefaultsForActiveView()}
            label="업무 추가"
            onCreate={createTask}
          />
        )}

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
          task={viewTask}
          onClose={() => setViewTaskId(null)}
          onDelete={() => void removeTask(viewTask)}
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
          task={editingTask}
          onClose={() => setEditingTaskId(null)}
          onDelete={() => void removeTask(editingTask)}
          onSave={(draft) => void saveTask(editingTask, draft)}
        />
      )}

      {readRecurringHabit && (
        <RecurringHabitReadModal
          checkIns={recurringCheckIns}
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

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!draft.title.trim()) {
      setLocalError("일정 제목을 입력해주세요.");
      return;
    }

    if (draft.startDate && draft.endDate && draft.endDate < draft.startDate) {
      setLocalError("종료일은 시작일보다 빠를 수 없습니다.");
      return;
    }

    if (draft.startDate && !isSafeScheduleDateRange(draft.startDate, draft.endDate || draft.startDate)) {
      setLocalError(scheduleDateRangeValidationMessage);
      return;
    }

    if (draft.timeMode !== "none" && !draft.startTime) {
      setLocalError("시작 시간을 입력해주세요.");
      return;
    }

    if (draft.timeMode === "range" && !draft.endTime) {
      setLocalError("종료 시간을 입력해주세요.");
      return;
    }

    if (draft.timeMode === "range" && draft.startTime && draft.endTime && draft.endTime < draft.startTime) {
      setLocalError("종료 시간은 시작 시간보다 빠를 수 없습니다.");
      return;
    }

    setLocalError(null);
    setIsCreating(true);
    const created = await onCreate({
      ...draft,
      endDate: draft.endDate || draft.startDate
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
        <DatePickerField
          label="종료일"
          min={draft.startDate || undefined}
          onChange={(dateString) => setDraft((current) => ({ ...current, endDate: dateString }))}
          value={draft.endDate}
        />
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
        {draft.checklist.map((item) => (
          <label key={item.id}>
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
      if (event.key === "Escape") {
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
  onAddTask,
  onClose,
  onOpenHabit,
  onOpenTask,
  onToggleHabit,
  onToggleTask,
  pendingCheckIns,
  summary,
  today
}: {
  checkIns: RecurringHabitCheckInSnapshot[];
  onAddTask: () => void;
  onClose: () => void;
  onOpenHabit: (habitId: string) => void;
  onOpenTask: (taskId: string) => void;
  onToggleHabit: (habit: DecryptedRecurringHabit) => void;
  onToggleTask: (task: DecryptedScheduleTask) => void;
  pendingCheckIns: Record<string, boolean>;
  summary: TodayWorkSummary;
  today: string;
}) {
  const panelRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const totalCount = summary.overdueTasks.length + summary.todayTasks.length + summary.recurringHabits.length;

  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <aside
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
        if (event.key === "Escape") {
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
        if (event.key === "Escape") {
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
            <button className="secondary-button" type="button" onClick={onToday}>
              오늘
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
    setNodeRef,
    transform,
    transition
  } = useSortable({
    id: task.id,
    data: { sectionKey, taskId: task.id, type: "matrix-task" }
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    touchAction: "none"
  };

  return (
    <div
      className={`task-row matrix-task-row ${task.status === "completed" ? "completed" : ""} ${isDragging ? "dragging" : ""}`}
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
    >
      <button
        className="task-drag-handle"
        type="button"
        aria-label={`${task.title} 드래그 이동`}
        title="드래그 이동"
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
        <span className="matrix-task-progress-label" aria-hidden="true" style={progressStyle}>
          {progressPercent}%
        </span>
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
  onSelectDate,
  onToggleCheckIn,
  pendingCheckIns,
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
  onSelectDate: (date: string) => void;
  onToggleCheckIn: (habit: DecryptedRecurringHabit, date: string) => void;
  pendingCheckIns: Record<string, boolean>;
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
    setNodeRef,
    transform,
    transition
  } = useSortable({
    id: habit.id,
    data: { habitId: habit.id, slot, type: "recurring-habit" }
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    touchAction: "none"
  };

  return (
    <div
      className={`recurring-habit-row ${checked ? "checked" : ""} ${isDragging ? "dragging" : ""}`}
      onDoubleClick={onRead}
      ref={setNodeRef}
      style={style}
      title="더블클릭하여 상세 보기"
      {...attributes}
      {...listeners}
    >
      <button
        aria-label={`${habit.title} 위치 이동`}
        className="recurring-drag-handle"
        type="button"
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
  today
}: {
  checkIns: RecurringHabitCheckInSnapshot[];
  habit: DecryptedRecurringHabit;
  month: string;
  onMonthChange: (month: string) => void;
  onSelectDate: (date: string) => void;
  onToggleCheckIn: (habit: DecryptedRecurringHabit, date: string) => void;
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
            const disabled = !day.inCurrentMonth || day.dateString > today;

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

    if (!draft.title.trim()) {
      setLocalError("반복 업무 이름을 입력해주세요.");
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
              onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
              placeholder="반복 업무 이름"
              value={draft.title}
            />
          </label>
          <label>
            설명
            <textarea
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
    if (!selectedDateIsEditable) {
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
    if (!selectedDateIsEditable) {
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
          disabled={!selectedDateIsEditable || pendingProgress}
          helperText={selectedDateIsEditable ? (pendingProgress ? "저장 중" : "선택 날짜 기준") : "미래 날짜는 수정할 수 없습니다"}
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
            <ul className="task-read-checklist">
              {displayedChecklist.map((item) => (
                <li key={item.id} className={item.checked ? "checked" : ""}>
                  <button
                    aria-checked={item.checked}
                    aria-label={item.checked ? `${item.text} 완료 해제` : `${item.text} 완료`}
                    className={`task-read-check-button ${item.checked ? "checked" : ""}`}
                    disabled={detailsMutationPending || !selectedDateIsEditable}
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

function TaskReadModal({
  onClose,
  onDelete,
  onDuplicate,
  onEdit,
  onToggleChecklist,
  onUpdateDetails,
  onUpdateProgress,
  task
}: {
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
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop schedule-detail-backdrop" role="presentation" onMouseDown={onClose}>
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
            <ul className="task-read-checklist">
              {details.checklist.map((item) => (
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
            <button className="secondary-button" type="button" onClick={onDuplicate}>
              <Copy size={17} />
              복사
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
  onClose,
  onDelete,
  onSave,
  task
}: {
  onClose: () => void;
  onDelete: () => void;
  onSave: (draft: TaskDraft) => void;
  task: DecryptedScheduleTask;
}) {
  const [draft, setDraft] = useState<TaskDraft>(() => draftFromTask(task));
  const [checklistText, setChecklistText] = useState("");
  const [isChecklistComposing, setIsChecklistComposing] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(draftFromTask(task));
  }, [task]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (draft.startDate && draft.endDate && draft.endDate < draft.startDate) {
      setLocalError("종료일은 시작일보다 빠를 수 없습니다.");
      return;
    }

    if (draft.startDate && !isSafeScheduleDateRange(draft.startDate, draft.endDate || draft.startDate)) {
      setLocalError(scheduleDateRangeValidationMessage);
      return;
    }

    if (draft.timeMode === "range" && draft.startTime && draft.endTime && draft.endTime < draft.startTime) {
      setLocalError("종료 시간은 시작 시간보다 빠를 수 없습니다.");
      return;
    }

    setLocalError(null);
    onSave({
      ...draft,
      endDate: draft.endDate || draft.startDate
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
    <div className="modal-backdrop schedule-detail-backdrop" role="presentation" onMouseDown={onClose}>
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
            <DatePickerField
              label="종료일"
              min={draft.startDate || undefined}
              onChange={(dateString) => setDraft((current) => ({ ...current, endDate: dateString }))}
              value={draft.endDate}
            />
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
            {draft.checklist.map((item) => (
              <label key={item.id}>
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
