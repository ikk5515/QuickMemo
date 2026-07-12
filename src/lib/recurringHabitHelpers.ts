import type {
  DecryptedRecurringHabit,
  RecurringHabitCheckInDocument,
  RecurringHabitDetails,
  RecurringHabitIcon,
  RecurringHabitSlot,
  ScheduleChecklistItem
} from "../types";
import {
  addDays,
  buildCalendarMonth,
  isValidScheduleDateString,
  parseLocalDateString,
  toLocalDateString
} from "./scheduleHelpers";

export interface RecurringHabitSlotGroup {
  key: RecurringHabitSlot;
  label: string;
  habits: DecryptedRecurringHabit[];
}

export interface RecurringDateProgress {
  checked: number;
  total: number;
  percent: number;
}

export interface RecurringHabitStats {
  totalCheckIns: number;
  streakDays: number;
}

export interface RecurringHabitMonthStats {
  checkedDays: number;
  denominatorDays: number;
  percent: number;
}

export interface RecurringHabitMonthlySummary extends RecurringHabitStats, RecurringHabitMonthStats {
  habit: DecryptedRecurringHabit;
}

export interface RecurringHabitOrderUpdate {
  habitId: string;
  slot: RecurringHabitSlot;
  sortOrder: number;
}

export const recurringHabitTitleMaxLength = 160;
export const recurringHabitDescriptionMaxLength = 4000;
export const recurringHabitChecklistItemMaxLength = 200;
export const recurringHabitChecklistMaxItems = 100;
export const recurringHabitDetailsMaxBytes = 8000;

function utf8ByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

export function recurringHabitTitleValidationError(title: string) {
  const trimmedTitle = title.trim();

  if (!trimmedTitle) {
    return "반복 업무 이름을 입력해주세요.";
  }

  if (trimmedTitle.length > recurringHabitTitleMaxLength || utf8ByteLength(trimmedTitle) > 600) {
    return `반복 업무 이름은 ${recurringHabitTitleMaxLength}자 이내로 입력해주세요.`;
  }

  return null;
}

export function recurringHabitDetailsValidationError(details: RecurringHabitDetails) {
  if (details.description.length > recurringHabitDescriptionMaxLength) {
    return `반복 업무 설명은 ${recurringHabitDescriptionMaxLength}자 이내로 입력해주세요.`;
  }

  if (details.checklist.length > recurringHabitChecklistMaxItems) {
    return `체크리스트는 최대 ${recurringHabitChecklistMaxItems}개까지 추가할 수 있습니다.`;
  }

  if (details.checklist.some((item) => item.text.length > recurringHabitChecklistItemMaxLength)) {
    return `체크리스트 항목은 ${recurringHabitChecklistItemMaxLength}자 이내로 입력해주세요.`;
  }

  if (utf8ByteLength(JSON.stringify(details)) > recurringHabitDetailsMaxBytes) {
    return "반복 업무 상세 내용이 너무 큽니다. 설명이나 체크리스트를 줄여주세요.";
  }

  return null;
}

export const recurringHabitSlots: Array<{ key: RecurringHabitSlot; label: string }> = [
  { key: "morning", label: "오전" },
  { key: "afternoon", label: "오후" },
  { key: "other", label: "기타" }
];

export const recurringHabitIconLabels: Record<RecurringHabitIcon, string> = {
  work: "일",
  study: "공부",
  reading: "독서",
  exercise: "운동",
  health: "건강",
  cleanup: "정리",
  review: "회고",
  other: "기타"
};

export const recurringHabitIconValues = Object.keys(recurringHabitIconLabels) as RecurringHabitIcon[];

interface RecurringCheckInIndex {
  byHabitDate: Map<string, RecurringHabitCheckInDocument>;
  completedDatesByHabit: Map<string, Set<string>>;
}

const recurringCheckInIndexCache = new WeakMap<RecurringHabitCheckInDocument[], RecurringCheckInIndex>();

function recurringCheckInIndex(checkIns: RecurringHabitCheckInDocument[]) {
  const cached = recurringCheckInIndexCache.get(checkIns);

  if (cached) {
    return cached;
  }

  const index: RecurringCheckInIndex = {
    byHabitDate: new Map(),
    completedDatesByHabit: new Map()
  };

  checkIns.forEach((checkIn) => {
    if (!checkIn.habitId || !isValidScheduleDateString(checkIn.date)) {
      return;
    }

    index.byHabitDate.set(recurringCheckInId(checkIn.habitId, checkIn.date), checkIn);

    if (recurringHabitCheckInCompleted(checkIn)) {
      const dates = index.completedDatesByHabit.get(checkIn.habitId) ?? new Set<string>();
      dates.add(checkIn.date);
      index.completedDatesByHabit.set(checkIn.habitId, dates);
    }
  });

  recurringCheckInIndexCache.set(checkIns, index);
  return index;
}

export function normalizeRecurringHabitDetails(value: unknown) {
  if (!value || typeof value !== "object") {
    return { description: "", checklist: [] };
  }

  const details = value as { checklist?: unknown; description?: unknown };
  const checklist = Array.isArray(details.checklist)
    ? details.checklist
      .map((item, index): ScheduleChecklistItem | null => {
        if (!item || typeof item !== "object") {
          return null;
        }

        const checklistItem = item as { checked?: unknown; id?: unknown; text?: unknown };
        const text = typeof checklistItem.text === "string" ? checklistItem.text.trim() : "";

        if (!text) {
          return null;
        }

        return {
          id: typeof checklistItem.id === "string" && checklistItem.id ? checklistItem.id : `recurring-checklist-${index}`,
          text,
          checked: false
        };
      })
      .filter((item): item is ScheduleChecklistItem => Boolean(item))
    : [];

  return {
    description: typeof details.description === "string" ? details.description : "",
    checklist
  };
}

export function buildRecurringDateStrip(anchorDate: string) {
  const safeAnchorDate = isValidScheduleDateString(anchorDate) ? anchorDate : toLocalDateString(new Date());

  return Array.from({ length: 7 }, (_, index) => {
    const dateString = addDays(safeAnchorDate, index - 6);
    const date = parseLocalDateString(dateString);

    return {
      date,
      dateString,
      dayNumber: date.getDate(),
      weekday: new Intl.DateTimeFormat("ko-KR", { weekday: "short" }).format(date)
    };
  });
}

export function groupRecurringHabitsBySlot(habits: DecryptedRecurringHabit[]): RecurringHabitSlotGroup[] {
  const activeHabits = habits.filter((habit) => habit.status === "active");

  return recurringHabitSlots.map((slot) => ({
    ...slot,
    habits: activeHabits
      .filter((habit) => habit.slot === slot.key)
      .sort(compareRecurringHabits)
  }));
}

export function recurringCheckInId(habitId: string, date: string) {
  return `${habitId}_${date}`;
}

export function buildRecurringHabitOrderUpdates(
  habits: DecryptedRecurringHabit[],
  activeHabitId: string,
  targetSlot: RecurringHabitSlot,
  overHabitId: string | null
): RecurringHabitOrderUpdate[] {
  const activeHabit = habits.find((habit) => habit.id === activeHabitId && habit.status === "active");

  if (!activeHabit) {
    return [];
  }

  const affectedSlots = new Set<RecurringHabitSlot>([activeHabit.slot, targetSlot]);
  const groupedHabits = new Map(
    groupRecurringHabitsBySlot(habits).map((group) => [group.key, group.habits] as const)
  );
  const updates: RecurringHabitOrderUpdate[] = [];

  affectedSlots.forEach((slot) => {
    const orderedHabits = (groupedHabits.get(slot) ?? []).filter((habit) => habit.id !== activeHabitId);

    if (slot === targetSlot) {
      const targetHabit = { ...activeHabit, slot: targetSlot };
      const overIndex = overHabitId ? orderedHabits.findIndex((habit) => habit.id === overHabitId) : -1;

      orderedHabits.splice(overIndex >= 0 ? overIndex : orderedHabits.length, 0, targetHabit);
    }

    orderedHabits.forEach((habit, index) => {
      const sortOrder = index + 1;
      const previousHabit = habit.id === activeHabitId ? activeHabit : habit;

      if (previousHabit.slot !== slot || safeSortOrder(previousHabit) !== sortOrder) {
        updates.push({ habitId: habit.id, slot, sortOrder });
      }
    });
  });

  return updates;
}

export function isHabitCheckedOn(checkIns: RecurringHabitCheckInDocument[], habitId: string, date: string) {
  const checkIn = recurringHabitDayState(checkIns, habitId, date);

  return checkIn ? recurringHabitCheckInCompleted(checkIn) : false;
}

export function recurringHabitDayState(
  checkIns: RecurringHabitCheckInDocument[],
  habitId: string,
  date: string
) {
  return recurringCheckInIndex(checkIns).byHabitDate.get(recurringCheckInId(habitId, date)) ?? null;
}

export function recurringHabitDayCheckedItemIds(
  checkIns: RecurringHabitCheckInDocument[],
  habitId: string,
  date: string
) {
  const state = recurringHabitDayState(checkIns, habitId, date);

  return new Set(
    Array.isArray(state?.checkedItemIds)
      ? state.checkedItemIds.filter((itemId): itemId is string => typeof itemId === "string" && itemId.length > 0)
      : []
  );
}

export function recurringHabitDayProgressPercent(
  habit: DecryptedRecurringHabit,
  checkIns: RecurringHabitCheckInDocument[],
  date: string
) {
  const state = recurringHabitDayState(checkIns, habit.id, date);
  const storedPercent = normalizeRecurringProgressPercent(state?.progressPercent);

  if (storedPercent != null) {
    return storedPercent;
  }

  if (habit.details.checklist.length > 0) {
    const checkedIds = recurringHabitDayCheckedItemIds(checkIns, habit.id, date);
    const checkedCount = habit.details.checklist.filter((item) => checkedIds.has(item.id)).length;

    return Math.round((checkedCount / habit.details.checklist.length) * 100);
  }

  return state && recurringHabitCheckInCompleted(state) ? 100 : 0;
}

export function calculateRecurringDateProgress(
  habits: DecryptedRecurringHabit[],
  checkIns: RecurringHabitCheckInDocument[],
  date: string
): RecurringDateProgress {
  const activeHabits = habits.filter((habit) => habit.status === "active");
  const total = activeHabits.length;
  const checked = activeHabits.filter((habit) => isHabitCheckedOn(checkIns, habit.id, date)).length;

  return {
    checked,
    total,
    percent: total ? Math.round((checked / total) * 100) : 0
  };
}

export function calculateHabitStats(
  habitId: string,
  checkIns: RecurringHabitCheckInDocument[],
  anchorDate: string
): RecurringHabitStats {
  const dates = checkInDateSet(habitId, checkIns);
  let streakDays = 0;
  let cursor = isValidScheduleDateString(anchorDate) ? anchorDate : toLocalDateString(new Date());

  while (dates.has(cursor)) {
    streakDays += 1;
    cursor = addDays(cursor, -1);
  }

  return {
    totalCheckIns: dates.size,
    streakDays
  };
}

export function calculateHabitMonthStats(
  habitId: string,
  checkIns: RecurringHabitCheckInDocument[],
  month: string,
  today = toLocalDateString(new Date())
): RecurringHabitMonthStats {
  const safeMonth = normalizeMonthString(month, today.slice(0, 7));
  const checkedDays = [...checkInDateSet(habitId, checkIns)]
    .filter((date) => date.startsWith(`${safeMonth}-`)).length;
  const denominatorDays = monthDenominatorDays(safeMonth, today);

  return {
    checkedDays,
    denominatorDays,
    percent: denominatorDays ? Math.round((checkedDays / denominatorDays) * 100) : 0
  };
}

export function buildRecurringMonthCalendar(month: string, today = toLocalDateString(new Date())) {
  const safeMonth = normalizeMonthString(month, today.slice(0, 7));
  const [year, monthNumber] = safeMonth.split("-").map(Number);

  return buildCalendarMonth(year, monthNumber - 1, today);
}

export function buildRecurringMonthlySummaries(
  habits: DecryptedRecurringHabit[],
  checkIns: RecurringHabitCheckInDocument[],
  month: string,
  anchorDate: string,
  today = toLocalDateString(new Date())
): RecurringHabitMonthlySummary[] {
  return habits
    .filter((habit) => habit.status === "active")
    .sort(compareRecurringHabits)
    .map((habit) => ({
      habit,
      ...calculateHabitStats(habit.id, checkIns, anchorDate),
      ...calculateHabitMonthStats(habit.id, checkIns, month, today)
    }));
}

export function normalizeMonthString(month: string, fallbackMonth = toLocalDateString(new Date()).slice(0, 7)) {
  if (/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/u.test(month)) {
    return month;
  }

  return fallbackMonth;
}

function compareRecurringHabits(left: DecryptedRecurringHabit, right: DecryptedRecurringHabit) {
  const slotDifference = slotRank(left.slot) - slotRank(right.slot);

  if (slotDifference !== 0) {
    return slotDifference;
  }

  const sortOrderDifference = safeSortOrder(left) - safeSortOrder(right);

  if (sortOrderDifference !== 0) {
    return sortOrderDifference;
  }

  const createdDifference = timestampMillis(left.createdAt) - timestampMillis(right.createdAt);

  if (createdDifference !== 0) {
    return createdDifference;
  }

  return left.title.localeCompare(right.title, "ko");
}

function slotRank(slot: RecurringHabitSlot) {
  return recurringHabitSlots.findIndex((item) => item.key === slot);
}

function timestampMillis(value: { toMillis?: () => number } | null | undefined) {
  return value && typeof value.toMillis === "function" ? value.toMillis() : 0;
}

function safeSortOrder(habit: Pick<DecryptedRecurringHabit, "sortOrder">) {
  return typeof habit.sortOrder === "number" && Number.isInteger(habit.sortOrder) && habit.sortOrder >= 0
    ? habit.sortOrder
    : Number.MAX_SAFE_INTEGER;
}

function checkInDateSet(habitId: string, checkIns: RecurringHabitCheckInDocument[]) {
  return recurringCheckInIndex(checkIns).completedDatesByHabit.get(habitId) ?? new Set<string>();
}

function recurringHabitCheckInCompleted(checkIn: RecurringHabitCheckInDocument) {
  return checkIn.completed !== false;
}

function normalizeRecurringProgressPercent(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return Math.max(0, Math.min(100, Math.round(value)));
}

function monthDenominatorDays(month: string, today: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const daysInMonth = new Date(year, monthNumber, 0).getDate();

  if (today.startsWith(`${month}-`)) {
    return Math.min(daysInMonth, Number(today.slice(8, 10)));
  }

  return daysInMonth;
}
