import {
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Flag,
  Grid2X2,
  ListTodo,
  Pencil,
  Plus,
  Save,
  Search,
  Trash2,
  X
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { FormEvent, useEffect, useId, useMemo, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { serverTimestamp } from "firebase/firestore";
import { AppShell } from "../components/AppShell";
import { UnlockPanel } from "../components/UnlockPanel";
import { useAuth } from "../context/AuthContext";
import { decryptText, encryptText, generateNoteKey, unwrapNoteKey, wrapNoteKey } from "../lib/crypto";
import { getKoreanHolidayMapForDates, type KoreanHoliday } from "../lib/koreanHolidays";
import {
  addDays,
  buildCalendarMonth,
  compareCompletedTasks,
  compareTaskSchedule,
  emptyScheduleDetails,
  formatScheduleDateRange,
  formatScheduleTimeRange,
  formatTaskTime,
  groupTasksByMatrix,
  groupTasksByTodoDate,
  normalizeScheduleDetails,
  taskEndDate,
  taskStartDate,
  taskStartTime,
  tasksByDate,
  timeInputToMinutes,
  toLocalDateString,
  type MatrixSection
} from "../lib/scheduleHelpers";
import {
  createScheduleTask,
  deleteScheduleTask,
  subscribeScheduleTasks,
  updateScheduleTask,
  type ScheduleTaskSnapshot
} from "../services/scheduleTasks";
import { getUserPreferences } from "../services/userPreferences";
import type { DecryptedScheduleTask, ScheduleChecklistItem, ScheduleTaskDetails, ScheduleView } from "../types";

const scheduleTabs: Array<{ view: ScheduleView; label: string; shortLabel: string; Icon: LucideIcon }> = [
  { view: "todo", label: "할 일", shortLabel: "할 일", Icon: ListTodo },
  { view: "calendar", label: "달력", shortLabel: "달력", Icon: CalendarDays },
  { view: "matrix", label: "매트릭스", shortLabel: "매트릭스", Icon: Grid2X2 },
  { view: "completed", label: "완료", shortLabel: "완료", Icon: CheckCircle2 }
];

const taskPageSize = 5;
const completedPageSize = 10;

type CompletedContentFilter = "all" | "hasDescription" | "hasChecklist";
type CompletedMonthsFilter = "1" | "3" | "6" | "12" | "all";
type CompletedPriorityFilter = "all" | "important" | "urgent" | "importantUrgent";

interface QuickDefaults {
  startDate?: string | null;
  endDate?: string | null;
  startTimeMinutes?: number | null;
  endTimeMinutes?: number | null;
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
  isImportant: boolean;
  isUrgent: boolean;
}

interface CreateDialogState {
  allowPriority?: boolean;
  defaults: QuickDefaults;
  title: string;
}

export default function SchedulePage() {
  const { privateKey, profile } = useAuth();
  const [activeView, setActiveView] = useState<ScheduleView>("todo");
  const [tasks, setTasks] = useState<ScheduleTaskSnapshot[]>([]);
  const [decryptedTasks, setDecryptedTasks] = useState<DecryptedScheduleTask[]>([]);
  const [viewTaskId, setViewTaskId] = useState<string | null>(null);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [selectedCalendarDate, setSelectedCalendarDate] = useState(() => toLocalDateString(new Date()));
  const [calendarCursor, setCalendarCursor] = useState(() => new Date());
  const [createDialog, setCreateDialog] = useState<CreateDialogState | null>(null);
  const [completedQuery, setCompletedQuery] = useState("");
  const [completedDate, setCompletedDate] = useState("");
  const [completedMonth, setCompletedMonth] = useState(() => toLocalDateString(new Date()).slice(0, 7));
  const [completedMonths, setCompletedMonths] = useState<CompletedMonthsFilter>("1");
  const [completedPriority, setCompletedPriority] = useState<CompletedPriorityFilter>("all");
  const [completedContent, setCompletedContent] = useState<CompletedContentFilter>("all");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const today = useMemo(() => toLocalDateString(new Date()), []);

  useEffect(() => {
    if (!profile) {
      return undefined;
    }

    let active = true;
    void getUserPreferences(profile.uid)
      .then((preferences) => {
        if (active) {
          setActiveView(preferences.scheduleDefaultView);
        }
      })
      .catch(() => undefined);

    return () => {
      active = false;
    };
  }, [profile]);

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
    if (!profile || !privateKey) {
      setDecryptedTasks([]);
      return undefined;
    }

    const safeProfile = profile;
    const safePrivateKey = privateKey;
    let active = true;

    async function decryptTasks() {
      const nextTasks = await Promise.all(
        tasks.map(async (task) => {
          const wrappedKey = task.wrappedKeys[safeProfile.uid];

          if (!wrappedKey) {
            return null;
          }

          try {
            const taskKey = await unwrapNoteKey(wrappedKey, safePrivateKey);
            const [title, detailsJson] = await Promise.all([
              decryptText(task.encryptedTitle, taskKey),
              decryptText(task.encryptedDetails, taskKey)
            ]);
            const parsedDetails = JSON.parse(detailsJson) as unknown;

            return {
              ...task,
              title,
              details: normalizeScheduleDetails(parsedDetails)
            };
          } catch {
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

  const sortedTasks = useMemo(() => [...decryptedTasks].sort(compareTaskSchedule), [decryptedTasks]);
  const viewTask = useMemo(
    () => sortedTasks.find((task) => task.id === viewTaskId) ?? null,
    [viewTaskId, sortedTasks]
  );
  const editingTask = useMemo(
    () => sortedTasks.find((task) => task.id === editingTaskId) ?? null,
    [editingTaskId, sortedTasks]
  );
  const completedTasks = useMemo(
    () => sortedTasks.filter((task) => task.status === "completed").sort(compareCompletedTasks),
    [sortedTasks]
  );
  const todoGroups = useMemo(() => groupTasksByTodoDate(sortedTasks, today), [sortedTasks, today]);
  const matrixSections = useMemo(() => groupTasksByMatrix(sortedTasks), [sortedTasks]);
  const calendarWeeks = useMemo(
    () => buildCalendarMonth(calendarCursor.getFullYear(), calendarCursor.getMonth(), today),
    [calendarCursor, today]
  );
  const calendarTaskMap = useMemo(() => tasksByDate(sortedTasks), [sortedTasks]);
  const calendarHolidayMap = useMemo(
    () => getKoreanHolidayMapForDates(calendarWeeks.flatMap((week) => week.days.map((day) => day.dateString))),
    [calendarWeeks]
  );
  const selectedDayTasks = calendarTaskMap[selectedCalendarDate] ?? [];

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

    try {
      const startDate = draft.startDate || draft.endDate || null;
      const endDate = startDate ? draft.endDate || startDate : null;
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

      await updateScheduleTask(task.id, unlockedProfile.uid, {
        encryptedTitle,
        encryptedDetails,
        dueDate: startDate,
        dueTimeMinutes: startTimeMinutes,
        startDate,
        endDate,
        startTimeMinutes,
        endTimeMinutes,
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

  async function toggleTaskChecklistItem(task: DecryptedScheduleTask, itemId: string) {
    const wrappedKey = task.wrappedKeys[unlockedProfile.uid];

    if (!wrappedKey) {
      setError("일정 암호화 키를 찾지 못했습니다.");
      return;
    }

    try {
      const taskKey = await unwrapNoteKey(wrappedKey, unlockedPrivateKey);
      const details: ScheduleTaskDetails = {
        description: task.details.description,
        checklist: task.details.checklist.map((item) =>
          item.id === itemId ? { ...item, checked: !item.checked } : item
        )
      };
      const encryptedDetails = await encryptText(JSON.stringify(details), taskKey);

      await updateScheduleTask(task.id, unlockedProfile.uid, { encryptedDetails });
      setError(null);
    } catch (caught) {
      setError(scheduleActionError(caught, "체크리스트 상태를 저장하지 못했습니다."));
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

  function quickDefaultsForActiveView(): QuickDefaults {
    if (activeView === "calendar") {
      return { startDate: selectedCalendarDate, endDate: selectedCalendarDate };
    }

    return { startDate: today, endDate: today };
  }

  function moveCalendarMonth(offset: number) {
    setCalendarCursor((current) => new Date(current.getFullYear(), current.getMonth() + offset, 1));
  }

  function goToday() {
    const nextToday = new Date();
    setCalendarCursor(new Date(nextToday.getFullYear(), nextToday.getMonth(), 1));
    setSelectedCalendarDate(toLocalDateString(nextToday));
  }

  function openCalendarCreateDialog(dateString: string) {
    setSelectedCalendarDate(dateString);
    setCreateDialog({
      defaults: { startDate: dateString, endDate: dateString },
      title: `${formatDateLabel(dateString)} 일정 추가`
    });
  }

  function openMatrixCreateDialog(section: MatrixSection) {
    setCreateDialog({
      allowPriority: false,
      defaults: {
        startDate: today,
        endDate: today,
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
            <h1>{scheduleTabs.find((tab) => tab.view === activeView)?.label}</h1>
          </div>
          <nav className="schedule-view-tabs" aria-label="일정관리 보기">
            {scheduleTabs.map(({ Icon, label, shortLabel, view }) => (
              <button
                key={view}
                className={activeView === view ? "active" : ""}
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

        {(error || status) && (
          <div className={`schedule-feedback ${error ? "error" : ""}`} role="status">
            {error || status}
          </div>
        )}

        {activeView === "todo" && (
          <ScheduleCreateForm
            defaults={quickDefaultsForActiveView()}
            label="업무 추가"
            onCreate={createTask}
          />
        )}

        {activeView === "todo" && (
          <TodoView groups={todoGroups} onOpen={setViewTaskId} onToggle={(task) => void toggleTask(task)} />
        )}

        {activeView === "calendar" && (
          <CalendarView
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
            sections={matrixSections}
            onAddSection={openMatrixCreateDialog}
            onOpen={setViewTaskId}
            onToggle={(task) => void toggleTask(task)}
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
          onEdit={() => {
            setEditingTaskId(viewTask.id);
            setViewTaskId(null);
          }}
          onToggleChecklist={(itemId) => void toggleTaskChecklistItem(viewTask, itemId)}
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

      {createDialog && (
        <ScheduleCreateDialog
          allowPriority={createDialog.allowPriority}
          defaults={createDialog.defaults}
          title={createDialog.title}
          onClose={() => setCreateDialog(null)}
          onCreate={createTask}
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
              setDraft((current) => ({
                ...current,
                timeMode: nextMode,
                startTime: nextMode === "none" ? "" : current.startTime || "09:00",
                endTime:
                  nextMode === "range"
                    ? current.endTime || addMinutesToTimeInput(current.startTime || "09:00", 60)
                    : ""
              }));
            }}
            value={draft.timeMode}
          >
            <option value="none">시간 없음</option>
            <option value="point">시각</option>
            <option value="range">시간 범위</option>
          </select>
        </label>
        {draft.timeMode !== "none" && (
          <label>
            <span>시작 시간</span>
            <input
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  startTime: event.target.value,
                  endTime:
                    current.timeMode === "range" && current.endTime && current.endTime < event.target.value
                      ? addMinutesToTimeInput(event.target.value, 60)
                      : current.endTime
                }))
              }
              required
              type="time"
              value={draft.startTime}
            />
          </label>
        )}
        {draft.timeMode === "range" && (
          <label>
            <span>종료 시간</span>
            <input
              min={draft.startTime || undefined}
              onChange={(event) => setDraft((current) => ({ ...current, endTime: event.target.value }))}
              required
              type="time"
              value={draft.endTime}
            />
          </label>
        )}
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
      <section className="schedule-create-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <p className="section-kicker">
              <CalendarDays size={15} />
              일정 추가
            </p>
            <h2>{title}</h2>
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
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(() => datePickerCursor(value || min || todayString));
  const weeks = useMemo(() => buildCalendarMonth(cursor.getFullYear(), cursor.getMonth(), todayString), [cursor, todayString]);
  const holidayMap = useMemo(
    () => getKoreanHolidayMapForDates(weeks.flatMap((week) => week.days.map((day) => day.dateString))),
    [weeks]
  );

  useEffect(() => {
    if (value) {
      setCursor(datePickerCursor(value));
    }
  }, [value]);

  function selectDate(dateString: string) {
    if (min && dateString < min) {
      return;
    }

    onChange(dateString);
    setOpen(false);
  }

  return (
    <div
      className={`date-picker-field ${className}`.trim()}
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
        {open && (
          <div className="date-picker-popover">
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
        )}
      </div>
    </div>
  );
}

function TodoView({
  groups,
  onOpen,
  onToggle
}: {
  groups: ReturnType<typeof groupTasksByTodoDate>;
  onOpen: (taskId: string) => void;
  onToggle: (task: DecryptedScheduleTask) => void;
}) {
  return (
    <div className="todo-groups">
      {groups.map((group) => (
        <section className="schedule-section" key={group.key}>
          <header>
            <h2>{group.label}</h2>
            <span>{group.tasks.length}</span>
          </header>
          <PagedTaskList tasks={group.tasks} onOpen={onOpen} onToggle={onToggle} />
        </section>
      ))}
    </div>
  );
}

function CalendarView({
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
                    {dayTasks.slice(0, 4).map((task) => {
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
                    {dayTasks.length > 4 && <span className="calendar-more">+{dayTasks.length - 4}</span>}
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
  onAddSection,
  onOpen,
  onToggle,
  sections
}: {
  onAddSection: (section: MatrixSection) => void;
  onOpen: (taskId: string) => void;
  onToggle: (task: DecryptedScheduleTask) => void;
  sections: MatrixSection[];
}) {
  return (
    <div className="matrix-grid">
      {sections.map((section) => (
        <section className={`matrix-section ${section.accent}`} key={section.key}>
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
          <PagedTaskList tasks={section.tasks} onOpen={onOpen} onToggle={onToggle} />
        </section>
      ))}
    </div>
  );
}

function PagedTaskList({
  emptyMessage,
  getMeta,
  onOpen,
  onToggle,
  pageSize = taskPageSize,
  strikeCompleted = true,
  tasks
}: {
  emptyMessage?: string;
  getMeta?: (task: DecryptedScheduleTask) => string;
  onOpen: (taskId: string) => void;
  onToggle: (task: DecryptedScheduleTask) => void;
  pageSize?: number;
  strikeCompleted?: boolean;
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
        strikeCompleted={strikeCompleted}
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
  strikeCompleted = true
}: {
  emptyMessage?: string;
  getMeta?: (task: DecryptedScheduleTask) => string;
  tasks: DecryptedScheduleTask[];
  onOpen: (taskId: string) => void;
  onToggle: (task: DecryptedScheduleTask) => void;
  strikeCompleted?: boolean;
}) {
  if (!tasks.length) {
    return <p className="schedule-empty">{emptyMessage}</p>;
  }

  return (
    <div className="task-list">
      {tasks.map((task) => (
        <div className={`task-row ${strikeCompleted && task.status === "completed" ? "completed" : ""}`} key={task.id}>
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
            <span>{getMeta ? getMeta(task) : formatTaskMeta(task)}</span>
          </button>
          <span className="task-flags">
            {task.isImportant && <Flag size={15} aria-label="중요" />}
            {task.isUrgent && <Clock size={15} aria-label="긴급" />}
          </span>
        </div>
      ))}
    </div>
  );
}

function TaskReadModal({
  onClose,
  onDelete,
  onEdit,
  onToggleChecklist,
  task
}: {
  onClose: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onToggleChecklist: (itemId: string) => void | Promise<void>;
  task: DecryptedScheduleTask;
}) {
  const details = task.details ?? emptyScheduleDetails;
  const hasChecklist = details.checklist.length > 0;
  const [pendingChecklistItemId, setPendingChecklistItemId] = useState<string | null>(null);

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

        <section className="task-read-section">
          <h3>내용</h3>
          <p>{details.description.trim() || "내용이 없습니다."}</p>
        </section>

        <section className="task-read-section">
          <h3>체크리스트</h3>
          {hasChecklist ? (
            <ul className="task-read-checklist">
              {details.checklist.map((item) => (
                <li key={item.id} className={item.checked ? "checked" : ""}>
                  <button
                    aria-checked={item.checked}
                    aria-label={item.checked ? `${item.text} 완료 해제` : `${item.text} 완료`}
                    className={`task-read-check-button ${item.checked ? "checked" : ""}`}
                    disabled={pendingChecklistItemId === item.id}
                    onClick={() => void toggleChecklistItem(item.id)}
                    role="checkbox"
                    type="button"
                  >
                    {item.checked ? <CheckCircle2 size={16} /> : null}
                  </button>
                  <span>{item.text}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p>체크리스트가 없습니다.</p>
          )}
        </section>

        <footer>
          <button className="danger-button" type="button" onClick={onDelete}>
            <Trash2 size={17} />
            삭제
          </button>
          <button type="button" onClick={onEdit}>
            <Pencil size={17} />
            수정
          </button>
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
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    timeMode: event.target.value as TaskDraft["timeMode"],
                    endTime: event.target.value === "range" ? current.endTime : ""
                  }))
                }
                value={draft.timeMode}
              >
                <option value="none">시간 없음</option>
                <option value="point">시각</option>
                <option value="range">시간 범위</option>
              </select>
            </label>
            {draft.timeMode !== "none" && (
              <label>
                시작 시간
                <input
                  onChange={(event) => setDraft((current) => ({ ...current, startTime: event.target.value }))}
                  required
                  type="time"
                  value={draft.startTime}
                />
              </label>
            )}
            {draft.timeMode === "range" && (
              <label>
                종료 시간
                <input
                  min={draft.startTime || undefined}
                  onChange={(event) => setDraft((current) => ({ ...current, endTime: event.target.value }))}
                  required
                  type="time"
                  value={draft.endTime}
                />
              </label>
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
    isImportant: defaults.isImportant ?? false,
    isUrgent: defaults.isUrgent ?? false
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
