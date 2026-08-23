export interface DailyCalendarDay {
  dateKey: string;
  day: number;
  inMonth: boolean;
  isToday: boolean;
}

export interface DailyCalendarWeek {
  days: DailyCalendarDay[];
}

export interface IsoWeekPeriod {
  key: string;
  startDateKey: string;
  endDateKey: string;
  dateKeys: string[];
}

export interface MonthlyPeriod {
  key: string;
  startDateKey: string;
  endDateKey: string;
  dateKeys: string[];
  weekKeys: string[];
}

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const MONTH_KEY_PATTERN = /^(\d{4})-(\d{2})$/u;
const ISO_WEEK_KEY_PATTERN = /^(\d{4})-W(\d{2})$/u;
const DAY_IN_MILLISECONDS = 86_400_000;

function twoDigits(value: number) {
  return String(value).padStart(2, "0");
}

function fourDigits(value: number) {
  return String(value).padStart(4, "0");
}

function localNoon(year: number, monthIndex: number, day: number) {
  const date = new Date(0);
  date.setHours(12, 0, 0, 0);
  date.setFullYear(year, monthIndex, day);
  return date;
}

function utcDay(year: number, monthIndex: number, day: number) {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, monthIndex, day);
  return date;
}

function utcDateKey(date: Date) {
  return `${fourDigits(date.getUTCFullYear())}-${twoDigits(date.getUTCMonth() + 1)}-${twoDigits(date.getUTCDate())}`;
}

function isoWeekKeyFromParts(year: number, monthIndex: number, day: number) {
  const thursday = utcDay(year, monthIndex, day);
  const mondayBasedDay = (thursday.getUTCDay() + 6) % 7;
  thursday.setUTCDate(thursday.getUTCDate() + 3 - mondayBasedDay);

  const isoYear = thursday.getUTCFullYear();
  const firstThursday = utcDay(isoYear, 0, 4);
  firstThursday.setUTCDate(firstThursday.getUTCDate() + 3 - ((firstThursday.getUTCDay() + 6) % 7));
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * DAY_IN_MILLISECONDS));
  return `${fourDigits(isoYear)}-W${twoDigits(week)}`;
}

export function localDateKey(date: Date) {
  return `${fourDigits(date.getFullYear())}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}`;
}

export function localMonthKey(date: Date) {
  return `${fourDigits(date.getFullYear())}-${twoDigits(date.getMonth() + 1)}`;
}

export function parseLocalDateKey(value: string): Date | null {
  const match = DATE_KEY_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isSafeInteger(year) || year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) {
    return null;
  }
  const date = localNoon(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? date
    : null;
}

export function normalizeDailyMonth(value: string, fallback = new Date()) {
  const match = MONTH_KEY_PATTERN.exec(value);
  if (!match) {
    return localMonthKey(fallback);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  return Number.isSafeInteger(year) && year >= 1 && year <= 9999 && month >= 1 && month <= 12
    ? `${match[1]}-${match[2]}`
    : localMonthKey(fallback);
}

export function moveDailyMonth(monthKey: string, offset: number) {
  const normalized = normalizeDailyMonth(monthKey);
  const [year, month] = normalized.split("-").map(Number);
  return localMonthKey(localNoon(year, month - 1 + Math.trunc(offset), 1));
}

export function buildDailyCalendarMonth(
  monthKey: string,
  todayKey = localDateKey(new Date())
): DailyCalendarWeek[] {
  const normalized = normalizeDailyMonth(monthKey);
  const [year, month] = normalized.split("-").map(Number);
  const first = localNoon(year, month - 1, 1);
  // Monday-first grid. JavaScript Sunday=0, so Monday becomes offset 0.
  const mondayOffset = (first.getDay() + 6) % 7;
  const gridStart = localNoon(year, month - 1, 1 - mondayOffset);
  return Array.from({ length: 6 }, (_, weekIndex): DailyCalendarWeek => ({
    days: Array.from({ length: 7 }, (_, dayIndex): DailyCalendarDay => {
      const date = localNoon(
        gridStart.getFullYear(),
        gridStart.getMonth(),
        gridStart.getDate() + weekIndex * 7 + dayIndex
      );
      const dateKey = localDateKey(date);
      return {
        dateKey,
        day: date.getDate(),
        inMonth: date.getFullYear() === year && date.getMonth() === month - 1,
        isToday: dateKey === todayKey
      };
    })
  }));
}

export function dailyNoteDateFromTitle(title: string) {
  const normalized = title.trim().replace(/\.md$/iu, "");
  return parseLocalDateKey(normalized) ? normalized : null;
}

export function isoWeekKey(date: Date) {
  if (Number.isNaN(date.getTime())) {
    throw new Error("ISO 주차를 계산할 날짜가 올바르지 않습니다.");
  }
  return isoWeekKeyFromParts(date.getFullYear(), date.getMonth(), date.getDate());
}

export function isoWeekKeyFromDateKey(dateKey: string) {
  const date = parseLocalDateKey(dateKey);
  return date ? isoWeekKey(date) : null;
}

export function parseIsoWeekKey(value: string): IsoWeekPeriod | null {
  const match = ISO_WEEK_KEY_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (!Number.isSafeInteger(year) || year < 1 || year > 9999 || week < 1 || week > 53) {
    return null;
  }

  const januaryFourth = utcDay(year, 0, 4);
  const mondayOffset = (januaryFourth.getUTCDay() + 6) % 7;
  const monday = new Date(januaryFourth);
  monday.setUTCDate(januaryFourth.getUTCDate() - mondayOffset + ((week - 1) * 7));
  if (isoWeekKeyFromParts(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate()) !== value) {
    return null;
  }

  const dateKeys = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(monday);
    date.setUTCDate(monday.getUTCDate() + index);
    return utcDateKey(date);
  });
  return {
    key: value,
    startDateKey: dateKeys[0],
    endDateKey: dateKeys[6],
    dateKeys
  };
}

export function parseMonthlyPeriod(value: string): MonthlyPeriod | null {
  const match = MONTH_KEY_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isSafeInteger(year) || year < 1 || year > 9999 || month < 1 || month > 12) {
    return null;
  }

  const lastDay = localNoon(year, month, 0).getDate();
  const dateKeys = Array.from({ length: lastDay }, (_, index) =>
    localDateKey(localNoon(year, month - 1, index + 1))
  );
  const weekKeys = [...new Set(dateKeys.map((dateKey) => isoWeekKeyFromDateKey(dateKey)))].filter(
    (weekKey): weekKey is string => Boolean(weekKey)
  );
  return {
    key: value,
    startDateKey: dateKeys[0],
    endDateKey: dateKeys.at(-1) ?? dateKeys[0],
    dateKeys,
    weekKeys
  };
}

function frontmatterList(values: string[]) {
  return values.map((value) => `  - ${value}`).join("\n");
}

function wikilinkList(values: string[]) {
  return values.map((value) => `- [[${value}]]`).join("\n");
}

export function dailyNoteBody(dateKey: string, templateBody?: string) {
  const date = parseLocalDateKey(dateKey);
  if (!date) {
    throw new Error("Daily Note 날짜가 올바르지 않습니다.");
  }
  if (templateBody !== undefined) {
    return templateBody;
  }
  const weekKey = isoWeekKey(date);
  const monthKey = localMonthKey(date);
  return `---\ntype: daily-note\ndate: ${dateKey}\nweek: ${weekKey}\nmonth: ${monthKey}\ntags:\n${frontmatterList(["daily"])}\nreviewed: false\n---\n\n# ${dateKey}\n\n주간: [[${weekKey}]] · 월간: [[${monthKey}]]\n\n## 오늘의 초점\n- \n\n## 인박스\n- \n\n## 이동할 항목\n- \n\n## 짧은 회고\n- \n`;
}

export function weeklyNoteBody(weekKey: string) {
  const period = parseIsoWeekKey(weekKey);
  if (!period) {
    throw new Error("주간 노트의 ISO 주차가 올바르지 않습니다.");
  }
  return `---\ntype: weekly-review\nweek: ${period.key}\nstart: ${period.startDateKey}\nend: ${period.endDateKey}\ntags:\n${frontmatterList(["weekly-review"])}\nreviewed: false\n---\n\n# ${period.key}\n\n## 이번 주 데일리 노트\n${wikilinkList(period.dateKeys)}\n\n## 이번 주 완료\n- \n\n## 미뤄진 일\n- \n\n## 이동한 노트\n- \n\n## 다음 주 초점\n- \n`;
}

export function monthlyNoteBody(monthKey: string) {
  const period = parseMonthlyPeriod(monthKey);
  if (!period) {
    throw new Error("월간 노트의 연월이 올바르지 않습니다.");
  }
  return `---\ntype: monthly-review\nmonth: ${period.key}\ntags:\n${frontmatterList(["monthly-review"])}\nreviewed: false\n---\n\n# ${period.key}\n\n## 이번 달 주간 리뷰\n${wikilinkList(period.weekKeys)}\n\n## 반복된 병목\n- \n\n## 가장 가치 있었던 메모\n- \n\n## 다음 달 조정\n- \n`;
}
