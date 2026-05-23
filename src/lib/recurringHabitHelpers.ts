import type {
  DecryptedRecurringHabit,
  RecurringHabitCheckInDocument,
  RecurringHabitIcon,
  RecurringHabitSlot
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

export function normalizeRecurringHabitDetails(value: unknown) {
  if (!value || typeof value !== "object") {
    return { description: "" };
  }

  const details = value as { description?: unknown };

  return {
    description: typeof details.description === "string" ? details.description : ""
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

export function isHabitCheckedOn(checkIns: RecurringHabitCheckInDocument[], habitId: string, date: string) {
  return checkIns.some((checkIn) => checkIn.habitId === habitId && checkIn.date === date);
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
  const checkedDays = checkIns.filter((checkIn) => checkIn.habitId === habitId && checkIn.date.startsWith(`${safeMonth}-`)).length;
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

function checkInDateSet(habitId: string, checkIns: RecurringHabitCheckInDocument[]) {
  return new Set(
    checkIns
      .filter((checkIn) => checkIn.habitId === habitId && isValidScheduleDateString(checkIn.date))
      .map((checkIn) => checkIn.date)
  );
}

function monthDenominatorDays(month: string, today: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const daysInMonth = new Date(year, monthNumber, 0).getDate();

  if (today.startsWith(`${month}-`)) {
    return Math.min(daysInMonth, Number(today.slice(8, 10)));
  }

  return daysInMonth;
}
