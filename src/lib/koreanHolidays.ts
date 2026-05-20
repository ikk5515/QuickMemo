import Holidays from "date-holidays";
import { addDays, parseLocalDateString } from "./scheduleHelpers";

export interface KoreanHoliday {
  name: string;
  type: string;
}

const dayMillis = 24 * 60 * 60 * 1000;
const koreanHolidays = new Holidays("KR");
const holidayCache = new Map<number, Record<string, KoreanHoliday[]>>();
const substituteHolidayNames = new Set([
  "3·1절",
  "제헌절",
  "광복절",
  "개천절",
  "한글날",
  "어린이날",
  "석가탄신일",
  "부처님오신날",
  "부처님 오신 날",
  "기독탄신일"
]);
// date-holidays can miss Korean term-expiry election public holidays, so keep verified one-off dates here.
const supplementalPublicHolidays: Record<string, KoreanHoliday[]> = {
  "2026-06-03": [{ name: "지방선거", type: "public" }]
};

interface HolidayOccurrence {
  dates: string[];
  durationDays: number;
  name: string;
  startDate: string;
}

export function getKoreanHolidayMapForDates(dateStrings: string[]) {
  const years = new Set(
    dateStrings
      .map((dateString) => Number(dateString.slice(0, 4)))
      .filter((year) => Number.isInteger(year))
  );

  return [...years].reduce<Record<string, KoreanHoliday[]>>((map, year) => {
    const yearMap = getKoreanHolidayMapForYear(year);

    Object.entries(yearMap).forEach(([dateString, holidays]) => {
      map[dateString] = holidays;
    });

    return map;
  }, {});
}

function getKoreanHolidayMapForYear(year: number) {
  const cached = holidayCache.get(year);

  if (cached) {
    return cached;
  }

  const map: Record<string, KoreanHoliday[]> = {};
  const occurrences: HolidayOccurrence[] = [];

  koreanHolidays
    .getHolidays(year)
    .filter((holiday) => holiday.type === "public")
    .forEach((holiday) => {
      const startDate = holiday.date.slice(0, 10);
      const durationDays = Math.max(1, Math.round((holiday.end.getTime() - holiday.start.getTime()) / dayMillis));
      const dates: string[] = [];

      for (let offset = 0; offset < durationDays; offset += 1) {
        const dateString = addDays(startDate, offset);
        dates.push(dateString);
        map[dateString] = [...(map[dateString] ?? []), { name: holiday.name, type: holiday.type }];
      }

      occurrences.push({ dates, durationDays, name: holiday.name, startDate });
    });

  Object.entries(supplementalPublicHolidays).forEach(([dateString, holidays]) => {
    if (dateString.startsWith(`${year}-`)) {
      map[dateString] = mergeHolidays(map[dateString], holidays);
    }
  });

  addSubstituteHolidays(map, occurrences);

  holidayCache.set(year, map);
  return map;
}

function addSubstituteHolidays(map: Record<string, KoreanHoliday[]>, occurrences: HolidayOccurrence[]) {
  const observedForDate = new Set<string>();

  occurrences.forEach((occurrence) => {
    const shouldObserve = occurrence.durationDays > 1
      ? occurrence.dates.some((dateString) => isSunday(dateString) || hasMultipleHolidays(map, dateString))
      : substituteHolidayNames.has(occurrence.name)
        && occurrence.dates.some((dateString) => isWeekend(dateString) || hasMultipleHolidays(map, dateString));

    if (!shouldObserve || observedForDate.has(occurrence.startDate)) {
      return;
    }

    const observedDate = nextNonHolidayAfter(occurrence.dates[occurrence.dates.length - 1], map);

    map[observedDate] = mergeHolidays(map[observedDate], [{ name: "대체공휴일", type: "public" }]);
    observedForDate.add(occurrence.startDate);
  });
}

function hasMultipleHolidays(map: Record<string, KoreanHoliday[]>, dateString: string) {
  return (map[dateString]?.length ?? 0) > 1;
}

function nextNonHolidayAfter(dateString: string, map: Record<string, KoreanHoliday[]>) {
  let nextDate = addDays(dateString, 1);

  while (map[nextDate]?.length || isWeekend(nextDate)) {
    nextDate = addDays(nextDate, 1);
  }

  return nextDate;
}

function isWeekend(dateString: string) {
  const day = parseLocalDateString(dateString).getDay();

  return day === 0 || day === 6;
}

function isSunday(dateString: string) {
  return parseLocalDateString(dateString).getDay() === 0;
}

function mergeHolidays(current: KoreanHoliday[] = [], supplemental: KoreanHoliday[]) {
  const names = new Set(current.map((holiday) => holiday.name));
  const next = [...current];

  supplemental.forEach((holiday) => {
    if (!names.has(holiday.name)) {
      next.push(holiday);
    }
  });

  return next;
}

export function isKoreanHoliday(dateString: string) {
  const year = Number(dateString.slice(0, 4));

  if (!Number.isInteger(year)) {
    return false;
  }

  return Boolean(getKoreanHolidayMapForYear(year)[dateString]?.length);
}
