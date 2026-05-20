import { describe, expect, it } from "vitest";
import { getKoreanHolidayMapForDates, isKoreanHoliday } from "./koreanHolidays";

describe("korean holidays", () => {
  it("marks Korean public holidays for calendar display", () => {
    const holidayMap = getKoreanHolidayMapForDates(["2026-01-01", "2026-05-05", "2026-05-19", "2026-06-03"]);

    expect(holidayMap["2026-01-01"]?.[0]?.name).toBe("신정");
    expect(holidayMap["2026-05-05"]?.[0]?.name).toBe("어린이날");
    expect(holidayMap["2026-05-19"]).toBeUndefined();
    expect(holidayMap["2026-06-03"]?.[0]?.name).toBe("지방선거");
    expect(isKoreanHoliday("2026-01-01")).toBe(true);
    expect(isKoreanHoliday("2026-06-03")).toBe(true);
  });
});
