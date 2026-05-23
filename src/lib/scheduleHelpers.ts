import type { DecryptedScheduleTask, ScheduleTaskDetails } from "../types";

export type TodoGroupKey = "today" | "tomorrow" | "next7" | "later" | "noDate" | "completed";
export type MatrixQuadrantKey = "urgentImportant" | "urgentNotImportant" | "importantNotUrgent" | "notUrgentNotImportant";
export type MatrixDateGroupKey = "next3" | "later" | "noDate";

export interface TodoGroup {
  key: TodoGroupKey;
  label: string;
  tasks: DecryptedScheduleTask[];
}

export interface CalendarDay {
  date: Date;
  dateString: string;
  dayNumber: number;
  inCurrentMonth: boolean;
  isToday: boolean;
}

export interface CalendarWeek {
  days: CalendarDay[];
}

export interface CalendarTaskPlacement {
  color: string;
  slotIndex: number;
  task: DecryptedScheduleTask;
}

export type CalendarTaskLayout = Record<string, Array<CalendarTaskPlacement | null>>;

export interface MatrixSection {
  key: MatrixQuadrantKey;
  label: string;
  accent: "red" | "gold" | "blue" | "teal";
  isImportant: boolean;
  isUrgent: boolean;
  dateGroups: MatrixDateGroup[];
  progress: MatrixSectionProgress;
  tasks: DecryptedScheduleTask[];
}

export interface MatrixDateGroup {
  key: MatrixDateGroupKey;
  label: string;
  tasks: DecryptedScheduleTask[];
}

export interface MatrixSectionProgress {
  checked: number;
  total: number;
  percent: number;
}

export interface ScheduleTaskOrderUpdate {
  taskId: string;
  sortOrder: number | null;
}

const dayMillis = 24 * 60 * 60 * 1000;
const scheduleDatePattern = /^(19|20|21)\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const scheduleColorPattern = /^#[0-9a-f]{6}$/i;

export const maxScheduleTaskRangeDays = 366;
export const scheduleTaskColorPalette = [
  "#6fa99f",
  "#7f99c2",
  "#b79252",
  "#bd7b73",
  "#8f9f68",
  "#a888b8",
  "#729eae",
  "#c28794"
];

export const emptyScheduleDetails: ScheduleTaskDetails = {
  description: "",
  checklist: []
};

export function toLocalDateString(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");

  return `${year}-${month}-${day}`;
}

export function parseLocalDateString(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function isValidScheduleDateString(value: string | null | undefined): value is string {
  if (!value || !scheduleDatePattern.test(value)) {
    return false;
  }

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);

  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

export function scheduleDateRangeDays(startDate: string | null | undefined, endDate: string | null | undefined) {
  if (!isValidScheduleDateString(startDate)) {
    return null;
  }

  const safeEndDate = endDate ?? startDate;

  if (!isValidScheduleDateString(safeEndDate) || safeEndDate < startDate) {
    return null;
  }

  const startMillis = parseLocalDateString(startDate).getTime();
  const endMillis = parseLocalDateString(safeEndDate).getTime();

  return Math.floor((endMillis - startMillis) / dayMillis) + 1;
}

export function isSafeScheduleDateRange(startDate: string | null | undefined, endDate: string | null | undefined) {
  const days = scheduleDateRangeDays(startDate, endDate);
  const safeEndDate = endDate ?? startDate;

  return (
    days != null
    && days <= maxScheduleTaskRangeDays
    && isValidScheduleDateString(startDate)
    && isValidScheduleDateString(safeEndDate)
    && startDate.slice(0, 4) === safeEndDate.slice(0, 4)
  );
}

export function addDays(dateString: string, days: number) {
  const date = parseLocalDateString(dateString);
  date.setDate(date.getDate() + days);
  return toLocalDateString(date);
}

export function taskStartDate(task: Pick<DecryptedScheduleTask, "dueDate" | "startDate">) {
  return task.startDate ?? task.dueDate ?? null;
}

export function taskEndDate(task: Pick<DecryptedScheduleTask, "dueDate" | "endDate" | "startDate">) {
  return task.endDate ?? task.startDate ?? task.dueDate ?? null;
}

export function taskStartTime(task: Pick<DecryptedScheduleTask, "dueTimeMinutes" | "startTimeMinutes">) {
  return task.startTimeMinutes ?? task.dueTimeMinutes ?? null;
}

export function taskEndTime(task: Pick<DecryptedScheduleTask, "endTimeMinutes">) {
  return task.endTimeMinutes ?? null;
}

function timestampMillis(value: { toMillis?: () => number } | null | undefined) {
  return value && typeof value.toMillis === "function" ? value.toMillis() : 0;
}

function taskCreatedMillis(task: Pick<DecryptedScheduleTask, "createdAt" | "updatedAt">) {
  return timestampMillis(task.createdAt) || timestampMillis(task.updatedAt);
}

function safeSortOrder(task: Pick<DecryptedScheduleTask, "sortOrder">) {
  return typeof task.sortOrder === "number" && Number.isInteger(task.sortOrder) && task.sortOrder >= 0
    ? task.sortOrder
    : null;
}

function compareManualOrderWithinSameDate(left: DecryptedScheduleTask, right: DecryptedScheduleTask) {
  if (left.status !== "active" || right.status !== "active") {
    return 0;
  }

  const leftDate = taskStartDate(left);
  const rightDate = taskStartDate(right);

  if (!isValidScheduleDateString(leftDate) || leftDate !== rightDate) {
    return 0;
  }

  const leftOrder = safeSortOrder(left);
  const rightOrder = safeSortOrder(right);

  if (leftOrder != null && rightOrder != null && leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }

  if (leftOrder != null && rightOrder == null) {
    return -1;
  }

  if (leftOrder == null && rightOrder != null) {
    return 1;
  }

  return 0;
}

export function normalizeScheduleTaskColor(color: string | null | undefined, fallbackIndex = 0) {
  if (typeof color === "string" && scheduleColorPattern.test(color)) {
    return color;
  }

  return scheduleTaskColorPalette[Math.abs(fallbackIndex) % scheduleTaskColorPalette.length];
}

export function nextScheduleTaskColor(tasks: Array<Pick<DecryptedScheduleTask, "createdAt" | "updatedAt">>) {
  return scheduleTaskColorPalette[tasks.length % scheduleTaskColorPalette.length];
}

export function compareTaskNewest(left: DecryptedScheduleTask, right: DecryptedScheduleTask) {
  const leftCreated = taskCreatedMillis(left);
  const rightCreated = taskCreatedMillis(right);

  if (leftCreated !== rightCreated) {
    return rightCreated - leftCreated;
  }

  return compareTaskSchedule(left, right);
}

function taskPriorityRank(task: Pick<DecryptedScheduleTask, "isImportant" | "isUrgent">) {
  if (task.isImportant && task.isUrgent) {
    return 0;
  }

  if (task.isImportant) {
    return 1;
  }

  if (task.isUrgent) {
    return 2;
  }

  return 3;
}

function compareTaskStartDates(left: DecryptedScheduleTask, right: DecryptedScheduleTask) {
  const leftDate = taskStartDate(left);
  const rightDate = taskStartDate(right);
  const leftHasDate = isValidScheduleDateString(leftDate);
  const rightHasDate = isValidScheduleDateString(rightDate);

  if (leftHasDate && rightHasDate && leftDate !== rightDate) {
    return leftDate.localeCompare(rightDate);
  }

  if (leftHasDate && !rightHasDate) {
    return -1;
  }

  if (!leftHasDate && rightHasDate) {
    return 1;
  }

  return 0;
}

export function compareTodoTasks(left: DecryptedScheduleTask, right: DecryptedScheduleTask) {
  const manualOrder = compareManualOrderWithinSameDate(left, right);

  if (manualOrder !== 0) {
    return manualOrder;
  }

  const dateOrder = compareTaskStartDates(left, right);

  if (dateOrder !== 0) {
    return dateOrder;
  }

  const leftPriority = taskPriorityRank(left);
  const rightPriority = taskPriorityRank(right);

  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }

  const leftTime = taskStartTime(left);
  const rightTime = taskStartTime(right);

  if (leftTime != null && rightTime != null && leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  if (leftTime != null) {
    return -1;
  }

  if (rightTime != null) {
    return 1;
  }

  return compareTaskNewest(left, right);
}

export function compareCompletedTasks(left: DecryptedScheduleTask, right: DecryptedScheduleTask) {
  const leftCompleted = timestampMillis(left.completedAt);
  const rightCompleted = timestampMillis(right.completedAt);

  if (leftCompleted !== rightCompleted) {
    return rightCompleted - leftCompleted;
  }

  return compareTaskNewest(left, right);
}

export function compareMatrixTasks(left: DecryptedScheduleTask, right: DecryptedScheduleTask) {
  const dateOrder = compareTaskStartDates(left, right);

  if (dateOrder !== 0) {
    return dateOrder;
  }

  const manualOrder = compareManualOrderWithinSameDate(left, right);

  if (manualOrder !== 0) {
    return manualOrder;
  }

  const leftTime = taskStartDateTimeMillis(left);
  const rightTime = taskStartDateTimeMillis(right);

  if (leftTime != null && rightTime != null && leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  if (leftTime != null) {
    return -1;
  }

  if (rightTime != null) {
    return 1;
  }

  return compareTaskNewest(left, right);
}

function taskStartDateTimeMillis(task: DecryptedScheduleTask) {
  const startTime = taskStartTime(task);

  if (startTime == null) {
    return null;
  }

  const startDate = taskStartDate(task);
  const dateMillis = isValidScheduleDateString(startDate)
    ? parseLocalDateString(startDate).getTime()
    : Number.MAX_SAFE_INTEGER - 24 * 60 * 60 * 1000;

  return dateMillis + startTime * 60 * 1000;
}

export function compareTaskSchedule(left: DecryptedScheduleTask, right: DecryptedScheduleTask) {
  const leftDate = taskStartDate(left) ?? "9999-12-31";
  const rightDate = taskStartDate(right) ?? "9999-12-31";

  if (leftDate !== rightDate) {
    return leftDate.localeCompare(rightDate);
  }

  const manualOrder = compareManualOrderWithinSameDate(left, right);

  if (manualOrder !== 0) {
    return manualOrder;
  }

  const leftTime = taskStartTime(left) ?? 24 * 60 + 1;
  const rightTime = taskStartTime(right) ?? 24 * 60 + 1;

  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  return left.title.localeCompare(right.title, "ko");
}

export function compareCalendarTasks(left: DecryptedScheduleTask, right: DecryptedScheduleTask) {
  if (left.status !== right.status) {
    return left.status === "active" ? -1 : 1;
  }

  return compareTaskSchedule(left, right);
}

export function compareCalendarAgendaTasks(left: DecryptedScheduleTask, right: DecryptedScheduleTask) {
  if (left.status !== right.status) {
    return left.status === "active" ? -1 : 1;
  }

  return compareTodoTasks(left, right);
}

function compareCalendarLayoutTasks(left: DecryptedScheduleTask, right: DecryptedScheduleTask) {
  if (left.status !== right.status) {
    return left.status === "active" ? -1 : 1;
  }

  const leftCreated = taskCreatedMillis(left);
  const rightCreated = taskCreatedMillis(right);

  if (leftCreated !== rightCreated) {
    return leftCreated - rightCreated;
  }

  return compareTaskSchedule(left, right);
}

export function formatTaskTime(minutes: number | null) {
  if (minutes == null) {
    return "";
  }

  const hour = `${Math.floor(minutes / 60)}`.padStart(2, "0");
  const minute = `${minutes % 60}`.padStart(2, "0");

  return `${hour}:${minute}`;
}

export function timeInputToMinutes(value: string) {
  if (!value) {
    return null;
  }

  const [hour, minute] = value.split(":").map(Number);

  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    return null;
  }

  return hour * 60 + minute;
}

export function formatScheduleDateRange(task: DecryptedScheduleTask) {
  const startDate = taskStartDate(task);
  const endDate = taskEndDate(task);

  if (!isValidScheduleDateString(startDate)) {
    return "날짜 없음";
  }

  if (!isValidScheduleDateString(endDate) || endDate === startDate) {
    return startDate;
  }

  return `${startDate} - ${endDate}`;
}

export function formatScheduleTimeRange(task: DecryptedScheduleTask) {
  const startTime = taskStartTime(task);
  const endTime = taskEndTime(task);

  if (startTime == null) {
    return "";
  }

  if (endTime == null) {
    return formatTaskTime(startTime);
  }

  return `${formatTaskTime(startTime)} - ${formatTaskTime(endTime)}`;
}

export function groupTasksByTodoDate(tasks: DecryptedScheduleTask[], today = toLocalDateString(new Date())): TodoGroup[] {
  const completedSince = addDays(today, -6);
  const tomorrow = addDays(today, 1);
  const nextSevenEnd = addDays(today, 7);
  const groups: Record<TodoGroupKey, DecryptedScheduleTask[]> = {
    today: [],
    tomorrow: [],
    next7: [],
    later: [],
    noDate: [],
    completed: []
  };

  tasks.forEach((task) => {
    if (task.status === "completed") {
      const completedAt = timestampMillis(task.completedAt);
      const completedDate = completedAt ? toLocalDateString(new Date(completedAt)) : null;

      if (completedDate && completedDate >= completedSince) {
        groups.completed.push(task);
      }
      return;
    }

    const startDate = taskStartDate(task);
    const endDate = taskEndDate(task);

    if (!isValidScheduleDateString(startDate)) {
      groups.noDate.push(task);
      return;
    }

    const safeEndDate = isValidScheduleDateString(endDate) ? endDate : startDate;

    if (startDate <= today && safeEndDate >= today) {
      groups.today.push(task);
      return;
    }

    if (startDate <= today) {
      groups.today.push(task);
      return;
    }

    if (startDate === tomorrow) {
      groups.tomorrow.push(task);
      return;
    }

    if (startDate <= nextSevenEnd) {
      groups.next7.push(task);
      return;
    }

    groups.later.push(task);
  });

  return [
    { key: "today", label: "오늘", tasks: groups.today.sort(compareTodoTasks) },
    { key: "tomorrow", label: "내일", tasks: groups.tomorrow.sort(compareTodoTasks) },
    { key: "next7", label: "다음 7일", tasks: groups.next7.sort(compareTodoTasks) },
    { key: "later", label: "이후", tasks: groups.later.sort(compareTodoTasks) },
    { key: "noDate", label: "날짜 없음", tasks: groups.noDate.sort(compareTodoTasks) },
    { key: "completed", label: "최근 완료", tasks: groups.completed.sort(compareCompletedTasks) }
  ];
}

export function buildCalendarMonth(year: number, monthIndex: number, today = toLocalDateString(new Date())): CalendarWeek[] {
  const firstDay = new Date(year, monthIndex, 1);
  const cursor = new Date(firstDay);
  cursor.setDate(1 - firstDay.getDay());

  const weeks: CalendarWeek[] = [];

  for (let weekIndex = 0; weekIndex < 6; weekIndex += 1) {
    const days: CalendarDay[] = [];

    for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
      const date = new Date(cursor);
      const dateString = toLocalDateString(date);

      days.push({
        date,
        dateString,
        dayNumber: date.getDate(),
        inCurrentMonth: date.getMonth() === monthIndex,
        isToday: dateString === today
      });

      cursor.setTime(cursor.getTime() + dayMillis);
    }

    weeks.push({ days });
  }

  return weeks;
}

export function tasksByDate(tasks: DecryptedScheduleTask[]) {
  return tasks.reduce<Record<string, DecryptedScheduleTask[]>>((map, task) => {
    const startDate = taskStartDate(task);
    const endDate = taskEndDate(task);

    if (!isValidScheduleDateString(startDate)) {
      return map;
    }

    const lastDate = isValidScheduleDateString(endDate) && endDate >= startDate ? endDate : startDate;
    const rangeDays = scheduleDateRangeDays(startDate, lastDate);

    if (rangeDays == null || rangeDays > maxScheduleTaskRangeDays) {
      return map;
    }

    let cursor = startDate;

    for (let offset = 0; offset < rangeDays; offset += 1) {
      map[cursor] = [...(map[cursor] ?? []), task];
      map[cursor].sort(compareCalendarTasks);
      cursor = addDays(cursor, 1);
    }

    return map;
  }, {});
}

function taskDateRange(task: DecryptedScheduleTask) {
  const startDate = taskStartDate(task);
  const endDate = taskEndDate(task);

  if (!isValidScheduleDateString(startDate)) {
    return null;
  }

  const lastDate = isValidScheduleDateString(endDate) && endDate >= startDate ? endDate : startDate;
  const rangeDays = scheduleDateRangeDays(startDate, lastDate);

  if (rangeDays == null || rangeDays > maxScheduleTaskRangeDays) {
    return null;
  }

  return { endDate: lastDate, startDate };
}

export function buildCalendarTaskLayout(weeks: CalendarWeek[], tasks: DecryptedScheduleTask[]): CalendarTaskLayout {
  const layout: CalendarTaskLayout = {};

  weeks.forEach((week) => {
    const weekStart = week.days[0]?.dateString;
    const weekEnd = week.days[week.days.length - 1]?.dateString;

    if (!weekStart || !weekEnd) {
      return;
    }

    const occupied = new Map<string, Set<number>>();
    const weekTasks = tasks
      .flatMap((task) => {
        const range = taskDateRange(task);

        return range ? [{ range, task }] : [];
      })
      .filter(
        (entry) =>
          entry.range.startDate <= weekEnd
          && entry.range.endDate >= weekStart
      )
      .sort((left, right) => compareCalendarLayoutTasks(left.task, right.task));

    weekTasks.forEach(({ range, task }) => {
      const segmentStart = range.startDate > weekStart ? range.startDate : weekStart;
      const segmentEnd = range.endDate < weekEnd ? range.endDate : weekEnd;
      const segmentDays = scheduleDateRangeDays(segmentStart, segmentEnd);

      if (segmentDays == null) {
        return;
      }

      const dates: string[] = [];
      let cursor = segmentStart;

      for (let offset = 0; offset < segmentDays; offset += 1) {
        dates.push(cursor);
        cursor = addDays(cursor, 1);
      }

      let slotIndex = 0;

      while (dates.some((dateString) => occupied.get(dateString)?.has(slotIndex))) {
        slotIndex += 1;
      }

      const color = normalizeScheduleTaskColor(task.color, slotIndex);

      dates.forEach((dateString) => {
        const dateOccupied = occupied.get(dateString) ?? new Set<number>();
        dateOccupied.add(slotIndex);
        occupied.set(dateString, dateOccupied);

        const placements = layout[dateString] ?? [];

        while (placements.length < slotIndex) {
          placements.push(null);
        }

        placements[slotIndex] = { color, slotIndex, task };
        layout[dateString] = placements;
      });
    });
  });

  return layout;
}

export function matrixQuadrantForTask(task: Pick<DecryptedScheduleTask, "isImportant" | "isUrgent">): MatrixQuadrantKey {
  if (task.isImportant && task.isUrgent) {
    return "urgentImportant";
  }

  if (!task.isImportant && task.isUrgent) {
    return "urgentNotImportant";
  }

  if (task.isImportant && !task.isUrgent) {
    return "importantNotUrgent";
  }

  return "notUrgentNotImportant";
}

export function groupTasksByMatrix(tasks: DecryptedScheduleTask[], today = toLocalDateString(new Date())): MatrixSection[] {
  const activeTasks = tasks.filter((task) => task.status === "active");
  const sections: MatrixSection[] = [
    {
      key: "urgentImportant",
      label: "오늘까지 해야 할 일",
      accent: "red",
      isImportant: true,
      isUrgent: true,
      dateGroups: [],
      progress: { checked: 0, percent: 0, total: 0 },
      tasks: []
    },
    {
      key: "urgentNotImportant",
      label: "2순위 업무",
      accent: "gold",
      isImportant: false,
      isUrgent: true,
      dateGroups: [],
      progress: { checked: 0, percent: 0, total: 0 },
      tasks: []
    },
    {
      key: "importantNotUrgent",
      label: "업무 목록",
      accent: "blue",
      isImportant: true,
      isUrgent: false,
      dateGroups: [],
      progress: { checked: 0, percent: 0, total: 0 },
      tasks: []
    },
    {
      key: "notUrgentNotImportant",
      label: "대기 업무",
      accent: "teal",
      isImportant: false,
      isUrgent: false,
      dateGroups: [],
      progress: { checked: 0, percent: 0, total: 0 },
      tasks: []
    }
  ];

  const sectionByKey = new Map(sections.map((section) => [section.key, section]));

  activeTasks.forEach((task) => {
    sectionByKey.get(matrixSectionForTask(task, today))?.tasks.push(task);
  });

  return sections.map((section) => ({
    ...section,
    dateGroups: groupMatrixTasksByDate(section.tasks, today),
    progress: calculateMatrixSectionProgress(section.tasks),
    tasks: section.tasks.sort(compareMatrixTasks)
  }));
}

function matrixSectionForTask(task: DecryptedScheduleTask, today: string): MatrixQuadrantKey {
  const sectionKey = matrixQuadrantForTask(task);

  if (sectionKey !== "urgentImportant") {
    return sectionKey;
  }

  return isMatrixTodayTask(task, today) ? sectionKey : "urgentNotImportant";
}

function isMatrixTodayTask(task: DecryptedScheduleTask, today: string) {
  const startDate = taskStartDate(task);

  return isValidScheduleDateString(startDate) && startDate <= today;
}

export function matrixPriorityForSection(key: MatrixQuadrantKey) {
  return {
    isImportant: key === "urgentImportant" || key === "importantNotUrgent",
    isUrgent: key === "urgentImportant" || key === "urgentNotImportant"
  };
}

export function calculateMatrixSectionProgress(tasks: DecryptedScheduleTask[]): MatrixSectionProgress {
  const checklistItems = tasks.flatMap((task) => (task.details ?? emptyScheduleDetails).checklist);
  const total = checklistItems.length;
  const checked = checklistItems.filter((item) => item.checked).length;

  return {
    checked,
    total,
    percent: total ? Math.round((checked / total) * 100) : 0
  };
}

export function groupMatrixTasksByDate(
  tasks: DecryptedScheduleTask[],
  today = toLocalDateString(new Date())
): MatrixDateGroup[] {
  const nextThreeEnd = addDays(today, 3);
  const groups: Record<MatrixDateGroupKey, DecryptedScheduleTask[]> = {
    next3: [],
    later: [],
    noDate: []
  };

  tasks.forEach((task) => {
    const startDate = taskStartDate(task);

    if (!isValidScheduleDateString(startDate)) {
      groups.noDate.push(task);
      return;
    }

    if (startDate <= nextThreeEnd) {
      groups.next3.push(task);
      return;
    }

    groups.later.push(task);
  });

  return [
    { key: "next3", label: "다음 3일", tasks: groups.next3.sort(compareMatrixTasks) },
    { key: "later", label: "그 이후", tasks: groups.later.sort(compareMatrixTasks) },
    { key: "noDate", label: "날짜 없음", tasks: groups.noDate.sort(compareMatrixTasks) }
  ];
}

export function buildScheduleTaskOrderUpdates(
  tasks: DecryptedScheduleTask[],
  activeTaskId: string,
  overTaskId: string
): ScheduleTaskOrderUpdate[] | null {
  if (activeTaskId === overTaskId) {
    return [];
  }

  const activeTask = tasks.find((task) => task.id === activeTaskId);
  const overTask = tasks.find((task) => task.id === overTaskId);

  if (!activeTask || !overTask || activeTask.status !== "active" || overTask.status !== "active") {
    return null;
  }

  const activeDate = taskStartDate(activeTask);
  const overDate = taskStartDate(overTask);

  if (!isValidScheduleDateString(activeDate) || activeDate !== overDate) {
    return null;
  }

  const dateTasks = tasks
    .filter((task) => task.status === "active" && taskStartDate(task) === activeDate)
    .sort(compareMatrixTasks);
  const activeIndex = dateTasks.findIndex((task) => task.id === activeTaskId);
  const overIndex = dateTasks.findIndex((task) => task.id === overTaskId);

  if (activeIndex < 0 || overIndex < 0) {
    return null;
  }

  const reorderedTasks = [...dateTasks];
  const [pickedTask] = reorderedTasks.splice(activeIndex, 1);
  reorderedTasks.splice(overIndex, 0, pickedTask);

  return reorderedTasks.map((task, index) => ({ taskId: task.id, sortOrder: index + 1 }));
}

export function normalizeScheduleDetails(value: unknown) {
  if (!value || typeof value !== "object") {
    return emptyScheduleDetails;
  }

  const details = value as { description?: unknown; checklist?: unknown };
  const checklist = Array.isArray(details.checklist)
    ? details.checklist
        .filter((item): item is { id?: unknown; text?: unknown; checked?: unknown } => Boolean(item) && typeof item === "object")
        .map((item, index) => ({
          id: typeof item.id === "string" && item.id ? item.id : `item-${index}`,
          text: typeof item.text === "string" ? item.text : "",
          checked: item.checked === true
        }))
        .filter((item) => item.text.trim())
    : [];

  return {
    description: typeof details.description === "string" ? details.description : "",
    checklist
  };
}
