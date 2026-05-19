import type { DecryptedScheduleTask, ScheduleTaskDetails } from "../types";

export type TodoGroupKey = "today" | "tomorrow" | "next7" | "later" | "noDate" | "completed";
export type MatrixQuadrantKey = "urgentImportant" | "urgentNotImportant" | "importantNotUrgent" | "notUrgentNotImportant";

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

export interface MatrixSection {
  key: MatrixQuadrantKey;
  label: string;
  accent: "red" | "gold" | "blue" | "teal";
  isImportant: boolean;
  isUrgent: boolean;
  tasks: DecryptedScheduleTask[];
}

const dayMillis = 24 * 60 * 60 * 1000;

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

export function compareTaskNewest(left: DecryptedScheduleTask, right: DecryptedScheduleTask) {
  const leftCreated = taskCreatedMillis(left);
  const rightCreated = taskCreatedMillis(right);

  if (leftCreated !== rightCreated) {
    return rightCreated - leftCreated;
  }

  return compareTaskSchedule(left, right);
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
  const dateMillis = startDate ? parseLocalDateString(startDate).getTime() : Number.MAX_SAFE_INTEGER - 24 * 60 * 60 * 1000;

  return dateMillis + startTime * 60 * 1000;
}

export function compareTaskSchedule(left: DecryptedScheduleTask, right: DecryptedScheduleTask) {
  const leftDate = taskStartDate(left) ?? "9999-12-31";
  const rightDate = taskStartDate(right) ?? "9999-12-31";

  if (leftDate !== rightDate) {
    return leftDate.localeCompare(rightDate);
  }

  const leftTime = taskStartTime(left) ?? 24 * 60 + 1;
  const rightTime = taskStartTime(right) ?? 24 * 60 + 1;

  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  return left.title.localeCompare(right.title, "ko");
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

  if (!startDate) {
    return "날짜 없음";
  }

  if (!endDate || endDate === startDate) {
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

    if (!startDate) {
      groups.noDate.push(task);
      return;
    }

    if (startDate <= today && (!endDate || endDate >= today)) {
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
    { key: "today", label: "오늘", tasks: groups.today.sort(compareTaskNewest) },
    { key: "tomorrow", label: "내일", tasks: groups.tomorrow.sort(compareTaskNewest) },
    { key: "next7", label: "다음 7일", tasks: groups.next7.sort(compareTaskNewest) },
    { key: "later", label: "이후", tasks: groups.later.sort(compareTaskNewest) },
    { key: "noDate", label: "날짜 없음", tasks: groups.noDate.sort(compareTaskNewest) },
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

    if (!startDate) {
      return map;
    }

    let cursor = startDate;
    const lastDate = endDate && endDate >= startDate ? endDate : startDate;

    while (cursor <= lastDate) {
      map[cursor] = [...(map[cursor] ?? []), task];
      map[cursor].sort(compareTaskSchedule);
      cursor = addDays(cursor, 1);
    }

    return map;
  }, {});
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

export function groupTasksByMatrix(tasks: DecryptedScheduleTask[]): MatrixSection[] {
  const activeTasks = tasks.filter((task) => task.status === "active");
  const sections: MatrixSection[] = [
    {
      key: "urgentImportant",
      label: "오늘까지 해야 할 일",
      accent: "red",
      isImportant: true,
      isUrgent: true,
      tasks: []
    },
    {
      key: "urgentNotImportant",
      label: "순위 업무",
      accent: "gold",
      isImportant: false,
      isUrgent: true,
      tasks: []
    },
    {
      key: "importantNotUrgent",
      label: "업무 목록",
      accent: "blue",
      isImportant: true,
      isUrgent: false,
      tasks: []
    },
    {
      key: "notUrgentNotImportant",
      label: "대기 업무",
      accent: "teal",
      isImportant: false,
      isUrgent: false,
      tasks: []
    }
  ];

  const sectionByKey = new Map(sections.map((section) => [section.key, section]));

  activeTasks.forEach((task) => {
    sectionByKey.get(matrixQuadrantForTask(task))?.tasks.push(task);
  });

  return sections.map((section) => ({
    ...section,
    tasks: section.tasks.sort(compareMatrixTasks)
  }));
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
