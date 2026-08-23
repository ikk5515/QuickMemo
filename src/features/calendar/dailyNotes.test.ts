import { describe, expect, it } from "vitest";
import {
  buildDailyCalendarMonth,
  dailyNoteBody,
  dailyNoteDateFromTitle,
  isoWeekKeyFromDateKey,
  monthlyNoteBody,
  moveDailyMonth,
  normalizeDailyMonth,
  parseIsoWeekKey,
  parseLocalDateKey,
  parseMonthlyPeriod,
  weeklyNoteBody
} from "./dailyNotes";

describe("Daily Notes calendar model", () => {
  it("builds a Monday-first six-week grid across month boundaries", () => {
    const weeks = buildDailyCalendarMonth("2026-08", "2026-08-22");
    expect(weeks).toHaveLength(6);
    expect(weeks[0].days[0].dateKey).toBe("2026-07-27");
    expect(weeks.flatMap((week) => week.days).find((day) => day.dateKey === "2026-08-22")?.isToday).toBe(true);
    expect(weeks[5].days[6].dateKey).toBe("2026-09-06");
  });

  it("validates dates and handles year movement", () => {
    expect(parseLocalDateKey("2024-02-29")).not.toBeNull();
    expect(parseLocalDateKey("2026-02-29")).toBeNull();
    expect(moveDailyMonth("2026-01", -1)).toBe("2025-12");
    expect(moveDailyMonth("2026-12", 1)).toBe("2027-01");
    expect(normalizeDailyMonth("bad", new Date(2026, 7, 1))).toBe("2026-08");
  });

  it("recognizes only canonical date note titles and keeps provided template text", () => {
    expect(dailyNoteDateFromTitle("2026-08-22.md")).toBe("2026-08-22");
    expect(dailyNoteDateFromTitle("2026-8-22")).toBeNull();
    expect(dailyNoteBody("2026-08-22", "# template\n")).toBe("# template\n");
    expect(() => dailyNoteBody("bad")).toThrow(/날짜/);
  });

  it("calculates ISO weeks across calendar-year boundaries", () => {
    expect(isoWeekKeyFromDateKey("2021-01-01")).toBe("2020-W53");
    expect(isoWeekKeyFromDateKey("2021-01-04")).toBe("2021-W01");
    expect(parseIsoWeekKey("2020-W53")).toEqual({
      key: "2020-W53",
      startDateKey: "2020-12-28",
      endDateKey: "2021-01-03",
      dateKeys: [
        "2020-12-28",
        "2020-12-29",
        "2020-12-30",
        "2020-12-31",
        "2021-01-01",
        "2021-01-02",
        "2021-01-03"
      ]
    });
    expect(parseIsoWeekKey("2021-W53")).toBeNull();
  });

  it("collects every ISO week intersecting a month exactly once", () => {
    expect(parseMonthlyPeriod("2026-04")).toMatchObject({
      key: "2026-04",
      startDateKey: "2026-04-01",
      endDateKey: "2026-04-30",
      weekKeys: ["2026-W14", "2026-W15", "2026-W16", "2026-W17", "2026-W18"]
    });
    expect(parseMonthlyPeriod("2026-13")).toBeNull();
  });

  it("creates deterministic linked daily, weekly, and monthly review Markdown", () => {
    expect(dailyNoteBody("2026-04-27")).toBe(`---
type: daily-note
date: 2026-04-27
week: 2026-W18
month: 2026-04
tags:
  - daily
reviewed: false
---

# 2026-04-27

주간: [[2026-W18]] · 월간: [[2026-04]]

## 오늘의 초점
-\x20

## 인박스
-\x20

## 이동할 항목
-\x20

## 짧은 회고
-\x20
`);
    expect(weeklyNoteBody("2026-W18")).toContain(
      "start: 2026-04-27\nend: 2026-05-03"
    );
    expect(weeklyNoteBody("2026-W18")).toContain(
      "- [[2026-04-27]]\n- [[2026-04-28]]\n- [[2026-04-29]]\n- [[2026-04-30]]\n- [[2026-05-01]]\n- [[2026-05-02]]\n- [[2026-05-03]]"
    );
    expect(monthlyNoteBody("2026-04")).toContain(
      "- [[2026-W14]]\n- [[2026-W15]]\n- [[2026-W16]]\n- [[2026-W17]]\n- [[2026-W18]]"
    );
    expect(weeklyNoteBody("2026-W18")).toBe(weeklyNoteBody("2026-W18"));
    expect(monthlyNoteBody("2026-04")).toBe(monthlyNoteBody("2026-04"));
    expect(() => weeklyNoteBody("2026-W54")).toThrow(/ISO 주차/);
    expect(() => monthlyNoteBody("2026-13")).toThrow(/연월/);
  });
});
