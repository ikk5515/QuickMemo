import {
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Flag,
  Grid2X2,
  ListTodo,
  Plus,
  Save,
  Trash2,
  X
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { FormEvent, useEffect, useId, useMemo, useState } from "react";
import { serverTimestamp } from "firebase/firestore";
import { AppShell } from "../components/AppShell";
import { UnlockPanel } from "../components/UnlockPanel";
import { useAuth } from "../context/AuthContext";
import { decryptText, encryptText, generateNoteKey, unwrapNoteKey, wrapNoteKey } from "../lib/crypto";
import {
  buildCalendarMonth,
  compareTaskSchedule,
  emptyScheduleDetails,
  formatScheduleDateRange,
  formatScheduleTimeRange,
  formatTaskTime,
  groupTasksByMatrix,
  groupTasksByTodoDate,
  normalizeScheduleDetails,
  taskStartDate,
  taskStartTime,
  tasksByDate,
  timeInputToMinutes,
  toLocalDateString,
  type MatrixSection
} from "../lib/scheduleHelpers";
import {
  createScheduleTask,
  defaultScheduleDetails,
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
  { view: "matrix", label: "아이젠하워", shortLabel: "매트릭스", Icon: Grid2X2 }
];

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
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedCalendarDate, setSelectedCalendarDate] = useState(() => toLocalDateString(new Date()));
  const [calendarCursor, setCalendarCursor] = useState(() => new Date());
  const [createDialog, setCreateDialog] = useState<CreateDialogState | null>(null);
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
  const selectedTask = useMemo(
    () => sortedTasks.find((task) => task.id === selectedTaskId) ?? null,
    [selectedTaskId, sortedTasks]
  );
  const todoGroups = useMemo(() => groupTasksByTodoDate(sortedTasks, today), [sortedTasks, today]);
  const matrixSections = useMemo(() => groupTasksByMatrix(sortedTasks), [sortedTasks]);
  const calendarWeeks = useMemo(
    () => buildCalendarMonth(calendarCursor.getFullYear(), calendarCursor.getMonth(), today),
    [calendarCursor, today]
  );
  const calendarTaskMap = useMemo(() => tasksByDate(sortedTasks), [sortedTasks]);
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
      const [encryptedTitle, encryptedDetails] = await encryptTaskFields(trimmedTitle, defaultScheduleDetails, taskKey);
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
      setSelectedTaskId(null);
      setStatus("일정을 저장했습니다.");
      setError(null);
    } catch (caught) {
      setError(scheduleActionError(caught, "일정을 저장하지 못했습니다."));
    }
  }

  async function removeTask(task: DecryptedScheduleTask) {
    try {
      await deleteScheduleTask(task.id);
      setSelectedTaskId(null);
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

        {activeView !== "matrix" && (
          <ScheduleCreateForm
            key={`${activeView}-${selectedCalendarDate}`}
            defaults={quickDefaultsForActiveView()}
            label={activeView === "calendar" ? `${formatDateLabel(selectedCalendarDate)}에 추가` : "빠른 일정 추가"}
            onCreate={createTask}
          />
        )}

        {activeView === "todo" && (
          <TodoView groups={todoGroups} onOpen={setSelectedTaskId} onToggle={(task) => void toggleTask(task)} />
        )}

        {activeView === "calendar" && (
          <CalendarView
            calendarTaskMap={calendarTaskMap}
            selectedDate={selectedCalendarDate}
            selectedDayTasks={selectedDayTasks}
            weeks={calendarWeeks}
            monthLabel={calendarMonthLabel(calendarCursor)}
            onMoveMonth={moveCalendarMonth}
            onOpen={setSelectedTaskId}
            onSelectDate={openCalendarCreateDialog}
            onToday={goToday}
            onToggle={(task) => void toggleTask(task)}
          />
        )}

        {activeView === "matrix" && (
          <MatrixView
            sections={matrixSections}
            onAddSection={openMatrixCreateDialog}
            onOpen={setSelectedTaskId}
            onToggle={(task) => void toggleTask(task)}
          />
        )}
      </section>

      {selectedTask && (
        <TaskDetailModal
          task={selectedTask}
          onClose={() => setSelectedTaskId(null)}
          onDelete={() => void removeTask(selectedTask)}
          onSave={(draft) => void saveTask(selectedTask, draft)}
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
      onCreated?.();
    }
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
        <label>
          <span>시작일</span>
          <input
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                startDate: event.target.value,
                endDate: event.target.value
                  ? current.endDate && current.endDate >= event.target.value
                    ? current.endDate
                    : event.target.value
                  : ""
              }))
            }
            type="date"
            value={draft.startDate}
          />
        </label>
        <label>
          <span>종료일</span>
          <input
            min={draft.startDate || undefined}
            onChange={(event) => setDraft((current) => ({ ...current, endDate: event.target.value }))}
            type="date"
            value={draft.endDate}
          />
        </label>
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
          <TaskList tasks={group.tasks} onOpen={onOpen} onToggle={onToggle} />
        </section>
      ))}
    </div>
  );
}

function CalendarView({
  calendarTaskMap,
  monthLabel,
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
  monthLabel: string;
  onMoveMonth: (offset: number) => void;
  onOpen: (taskId: string) => void;
  onSelectDate: (dateString: string) => void;
  onToday: () => void;
  onToggle: (task: DecryptedScheduleTask) => void;
  selectedDate: string;
  selectedDayTasks: DecryptedScheduleTask[];
  weeks: ReturnType<typeof buildCalendarMonth>;
}) {
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
              const selected = selectedDate === day.dateString;

              return (
                <button
                  key={day.dateString}
                  className={`calendar-day ${day.inCurrentMonth ? "" : "muted"} ${day.isToday ? "today" : ""} ${selected ? "selected" : ""}`}
                  type="button"
                  onClick={() => onSelectDate(day.dateString)}
                >
                  <strong>{day.dayNumber}</strong>
                  <span className="calendar-task-stack">
                    {dayTasks.slice(0, 4).map((task) => (
                      <span
                        className={`calendar-task-pill ${task.status === "completed" ? "completed" : ""}`}
                        key={task.id}
                      >
                        {task.title}
                      </span>
                    ))}
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
        <TaskList tasks={selectedDayTasks} onOpen={onOpen} onToggle={onToggle} />
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
          <TaskList tasks={section.tasks} onOpen={onOpen} onToggle={onToggle} />
        </section>
      ))}
    </div>
  );
}

function TaskList({
  tasks,
  onOpen,
  onToggle
}: {
  tasks: DecryptedScheduleTask[];
  onOpen: (taskId: string) => void;
  onToggle: (task: DecryptedScheduleTask) => void;
}) {
  if (!tasks.length) {
    return <p className="schedule-empty">표시할 일정이 없습니다.</p>;
  }

  return (
    <div className="task-list">
      {tasks.map((task) => (
        <div className={`task-row ${task.status === "completed" ? "completed" : ""}`} key={task.id}>
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
            <span>
              {formatTaskDateDisplay(task)}
              {formatScheduleTimeRange(task) ? ` · ${formatScheduleTimeRange(task)}` : ""}
            </span>
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
            <label>
              시작일
              <input
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    startDate: event.target.value,
                    endDate: current.endDate && current.endDate < event.target.value ? event.target.value : current.endDate
                  }))
                }
                type="date"
                value={draft.startDate}
              />
            </label>
            <label>
              종료일
              <input
                min={draft.startDate || undefined}
                onChange={(event) => setDraft((current) => ({ ...current, endDate: event.target.value }))}
                type="date"
                value={draft.endDate}
              />
            </label>
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
                onChange={(event) => setChecklistText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
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
