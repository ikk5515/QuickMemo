import { describe, expect, it } from "vitest";
import { getKoreanHolidayMapForDates, isKoreanHoliday } from "./koreanHolidays";

describe("korean holidays", () => {
  it("marks Korean public holidays for calendar display", async () => {
    const holidayMap = await getKoreanHolidayMapForDates([
      "2025-05-06",
      "2026-01-01",
      "2026-03-02",
      "2026-05-05",
      "2026-05-19",
      "2026-05-25",
      "2026-06-03",
      "2026-06-08",
      "2026-08-17",
      "2026-10-05"
    ]);

    expect(holidayMap["2026-01-01"]?.[0]?.name).toBe("신정");
    expect(holidayMap["2026-03-02"]?.[0]?.name).toBe("대체공휴일");
    expect(holidayMap["2026-05-05"]?.[0]?.name).toBe("어린이날");
    expect(holidayMap["2026-05-19"]).toBeUndefined();
    expect(holidayMap["2026-05-25"]?.[0]?.name).toBe("대체공휴일");
    expect(holidayMap["2026-06-03"]?.[0]?.name).toBe("지방선거");
    expect(holidayMap["2026-06-08"]).toBeUndefined();
    expect(holidayMap["2026-08-17"]?.[0]?.name).toBe("대체공휴일");
    expect(holidayMap["2026-10-05"]?.[0]?.name).toBe("대체공휴일");
    expect(holidayMap["2025-05-06"]?.[0]?.name).toBe("대체공휴일");
    await expect(isKoreanHoliday("2026-01-01")).resolves.toBe(true);
    await expect(isKoreanHoliday("2026-05-25")).resolves.toBe(true);
    await expect(isKoreanHoliday("2026-06-03")).resolves.toBe(true);
    await expect(isKoreanHoliday("2026-06-08")).resolves.toBe(false);
  });
});
