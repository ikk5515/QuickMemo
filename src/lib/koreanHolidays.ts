import Holidays from "date-holidays";
import { addDays } from "./scheduleHelpers";

export interface KoreanHoliday {
  name: string;
  type: string;
}

const dayMillis = 24 * 60 * 60 * 1000;
const koreanHolidays = new Holidays("KR");
const holidayCache = new Map<number, Record<string, KoreanHoliday[]>>();
// date-holidays can miss Korean term-expiry election public holidays, so keep verified one-off dates here.
const supplementalPublicHolidays: Record<string, KoreanHoliday[]> = {
  "2026-06-03": [{ name: "지방선거", type: "public" }]
};

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

  koreanHolidays
    .getHolidays(year)
    .filter((holiday) => holiday.type === "public")
    .forEach((holiday) => {
      const startDate = holiday.date.slice(0, 10);
      const durationDays = Math.max(1, Math.round((holiday.end.getTime() - holiday.start.getTime()) / dayMillis));

      for (let offset = 0; offset < durationDays; offset += 1) {
        const dateString = addDays(startDate, offset);
        map[dateString] = [...(map[dateString] ?? []), { name: holiday.name, type: holiday.type }];
      }
    });

  Object.entries(supplementalPublicHolidays).forEach(([dateString, holidays]) => {
    if (dateString.startsWith(`${year}-`)) {
      map[dateString] = mergeHolidays(map[dateString], holidays);
    }
  });

  holidayCache.set(year, map);
  return map;
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
