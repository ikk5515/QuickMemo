import { addDays } from "./scheduleHelpers";

export interface KoreanHoliday {
  name: string;
  type: string;
}

const holidayCache = new Map<number, Record<string, KoreanHoliday[]>>();
const lunarDateFormatter = new Intl.DateTimeFormat("en-u-ca-dangi", {
  day: "numeric",
  month: "numeric",
  timeZone: "Asia/Seoul"
});
const solarPublicHolidays: Array<{ name: string; sinceYear?: number; suffix: string }> = [
  { suffix: "01-01", name: "신정" },
  { suffix: "03-01", name: "3·1절" },
  { suffix: "05-05", name: "어린이날" },
  { suffix: "06-06", name: "현충일" },
  { suffix: "07-17", name: "제헌절", sinceYear: 2026 },
  { suffix: "08-15", name: "광복절" },
  { suffix: "10-03", name: "개천절" },
  { suffix: "10-09", name: "한글날" },
  { suffix: "12-25", name: "기독탄신일" }
];
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
// Keep verified one-off Korean public holidays that are not derivable from fixed solar/lunar rules.
const supplementalPublicHolidays: Record<string, KoreanHoliday[]> = {
  "2026-06-03": [{ name: "지방선거", type: "public" }]
};

interface HolidayOccurrence {
  dates: string[];
  durationDays: number;
  name: string;
  startDate: string;
}

export async function getKoreanHolidayMapForDates(dateStrings: string[]) {
  const years = new Set(
    dateStrings
      .map((dateString) => Number(dateString.slice(0, 4)))
      .filter((year) => Number.isInteger(year))
  );
  const yearMaps = [...years].map((year) => [year, getKoreanHolidayMapForYear(year)] as const);

  return yearMaps.reduce<Record<string, KoreanHoliday[]>>((map, [, yearMap]) => {
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

  const map = buildKoreanHolidayMapForYear(year);
  holidayCache.set(year, map);

  return map;
}

function buildKoreanHolidayMapForYear(year: number) {
  const map: Record<string, KoreanHoliday[]> = {};
  const occurrences: HolidayOccurrence[] = [];

  solarPublicHolidays.forEach((holiday) => {
    if (!holiday.sinceYear || year >= holiday.sinceYear) {
      addHolidayOccurrence(map, occurrences, [`${year}-${holiday.suffix}`], holiday.name);
    }
  });

  addLunarHolidayOccurrences(year, map, occurrences);

  Object.entries(supplementalPublicHolidays).forEach(([dateString, holidays]) => {
    if (dateString.startsWith(`${year}-`)) {
      map[dateString] = mergeHolidays(map[dateString], holidays);
    }
  });

  addSubstituteHolidays(map, occurrences);

  return map;
}

function addLunarHolidayOccurrences(
  year: number,
  map: Record<string, KoreanHoliday[]>,
  occurrences: HolidayOccurrence[]
) {
  let dateString = `${year}-01-01`;
  const endDateString = `${year}-12-31`;

  while (dateString <= endDateString) {
    const lunarDate = koreanLunarMonthDay(dateString);

    if (lunarDate.month === 1 && lunarDate.day === 1) {
      addHolidayOccurrence(map, occurrences, [addDays(dateString, -1), dateString, addDays(dateString, 1)], "설날");
    } else if (lunarDate.month === 4 && lunarDate.day === 8) {
      addHolidayOccurrence(map, occurrences, [dateString], "석가탄신일");
    } else if (lunarDate.month === 8 && lunarDate.day === 15) {
      addHolidayOccurrence(map, occurrences, [addDays(dateString, -1), dateString, addDays(dateString, 1)], "추석");
    }

    dateString = addDays(dateString, 1);
  }
}

function addHolidayOccurrence(
  map: Record<string, KoreanHoliday[]>,
  occurrences: HolidayOccurrence[],
  dates: string[],
  name: string
) {
  dates.forEach((dateString) => {
    map[dateString] = mergeHolidays(map[dateString], [{ name, type: "public" }]);
  });

  occurrences.push({ dates, durationDays: dates.length, name, startDate: dates[0] });
}

function koreanLunarMonthDay(dateString: string) {
  const parts = lunarDateFormatter.formatToParts(new Date(`${dateString}T12:00:00+09:00`));
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);

  return { month, day };
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
  const day = dayOfWeek(dateString);

  return day === 0 || day === 6;
}

function isSunday(dateString: string) {
  return dayOfWeek(dateString) === 0;
}

function dayOfWeek(dateString: string) {
  const [year, month, day] = dateString.split("-").map(Number);

  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
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

export async function isKoreanHoliday(dateString: string) {
  const year = Number(dateString.slice(0, 4));

  if (!Number.isInteger(year)) {
    return false;
  }

  return Boolean(getKoreanHolidayMapForYear(year)[dateString]?.length);
}
