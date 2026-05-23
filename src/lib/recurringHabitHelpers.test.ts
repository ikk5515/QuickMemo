import { describe, expect, it } from "vitest";
import type { DecryptedRecurringHabit, RecurringHabitCheckInDocument } from "../types";
import {
  buildRecurringDateStrip,
  buildRecurringHabitOrderUpdates,
  buildRecurringMonthlySummaries,
  calculateHabitMonthStats,
  calculateHabitStats,
  calculateRecurringDateProgress,
  groupRecurringHabitsBySlot,
  isHabitCheckedOn,
  normalizeRecurringHabitDetails,
  recurringHabitDayCheckedItemIds,
  recurringHabitDayProgressPercent
} from "./recurringHabitHelpers";

function timestamp(value: string) {
  return {
    toMillis: () => new Date(value).getTime()
  } as DecryptedRecurringHabit["createdAt"];
}

function habit(id: string, overrides: Partial<DecryptedRecurringHabit> = {}): DecryptedRecurringHabit {
  return {
    id,
    ownerUid: "user-a",
    status: "active",
    slot: "morning",
    icon: "work",
    color: "#6fa99f",
    encryptedTitle: { version: 1, algorithm: "AES-GCM", cipherText: "cipher", iv: "iv" },
    encryptedDetails: { version: 1, algorithm: "AES-GCM", cipherText: "cipher", iv: "iv" },
    wrappedKeys: {
      "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "wrapped" }
    },
    createdBy: "user-a",
    updatedBy: "user-a",
    createdAt: timestamp("2026-05-01T00:00:00.000Z"),
    updatedAt: timestamp("2026-05-01T00:00:00.000Z"),
    title: id,
    details: { description: "", checklist: [] },
    ...overrides
  };
}

function checkIn(
  habitId: string,
  date: string,
  overrides: Partial<RecurringHabitCheckInDocument> = {}
): RecurringHabitCheckInDocument {
  return {
    ownerUid: "user-a",
    habitId,
    date,
    ...overrides
  };
}

describe("recurring habit helpers", () => {
  it("normalizes encrypted detail payloads safely", () => {
    expect(normalizeRecurringHabitDetails({ description: "memo" })).toEqual({ description: "memo", checklist: [] });
    expect(normalizeRecurringHabitDetails({ description: 1 })).toEqual({ description: "", checklist: [] });
    expect(normalizeRecurringHabitDetails(null)).toEqual({ description: "", checklist: [] });
    expect(
      normalizeRecurringHabitDetails({
        checklist: [
          { checked: true, id: "read", text: "  읽기  " },
          { checked: true, text: "쓰기" },
          { checked: true, text: " " }
        ],
        description: "memo"
      })
    ).toEqual({
      description: "memo",
      checklist: [
        { checked: false, id: "read", text: "읽기" },
        { checked: false, id: "recurring-checklist-1", text: "쓰기" }
      ]
    });
  });

  it("builds a 7-day strip ending on the anchor date", () => {
    expect(buildRecurringDateStrip("2026-05-21").map((day) => day.dateString)).toEqual([
      "2026-05-15",
      "2026-05-16",
      "2026-05-17",
      "2026-05-18",
      "2026-05-19",
      "2026-05-20",
      "2026-05-21"
    ]);
  });

  it("groups active habits by slot and ignores archived habits", () => {
    const groups = groupRecurringHabitsBySlot([
      habit("later", { slot: "other" }),
      habit("study", { slot: "afternoon" }),
      habit("work", { slot: "morning" }),
      habit("archived", { status: "archived", slot: "morning" })
    ]);

    expect(groups.map((group) => [group.key, group.habits.map((item) => item.id)])).toEqual([
      ["morning", ["work"]],
      ["afternoon", ["study"]],
      ["other", ["later"]]
    ]);
  });

  it("sorts habits by manual order inside each slot", () => {
    const groups = groupRecurringHabitsBySlot([
      habit("third", { sortOrder: 3 }),
      habit("first", { sortOrder: 1 }),
      habit("second", { sortOrder: 2 })
    ]);

    expect(groups[0].habits.map((item) => item.id)).toEqual(["first", "second", "third"]);
  });

  it("builds order updates for moving habits between slots", () => {
    const updates = buildRecurringHabitOrderUpdates(
      [
        habit("morning-1", { slot: "morning", sortOrder: 1 }),
        habit("morning-2", { slot: "morning", sortOrder: 2 }),
        habit("afternoon-1", { slot: "afternoon", sortOrder: 1 })
      ],
      "morning-2",
      "afternoon",
      "afternoon-1"
    );

    expect(updates).toEqual([
      { habitId: "morning-2", slot: "afternoon", sortOrder: 1 },
      { habitId: "afternoon-1", slot: "afternoon", sortOrder: 2 }
    ]);
  });

  it("calculates date progress from active habits only", () => {
    const habits = [
      habit("work"),
      habit("read"),
      habit("old", { status: "archived" })
    ];
    const checkIns = [
      checkIn("work", "2026-05-21"),
      checkIn("old", "2026-05-21")
    ];

    expect(calculateRecurringDateProgress(habits, checkIns, "2026-05-21")).toEqual({
      checked: 1,
      total: 2,
      percent: 50
    });
  });

  it("calculates daily checklist state and progress separately from the template", () => {
    const readingHabit = habit("read", {
      details: {
        description: "",
        checklist: [
          { id: "book", text: "책 읽기", checked: false },
          { id: "memo", text: "메모", checked: false }
        ]
      }
    });
    const checkIns = [
      checkIn("read", "2026-05-21", { checkedItemIds: ["book"], completed: false, progressPercent: 50 })
    ];

    expect([...recurringHabitDayCheckedItemIds(checkIns, "read", "2026-05-21")]).toEqual(["book"]);
    expect(recurringHabitDayProgressPercent(readingHabit, checkIns, "2026-05-21")).toBe(50);
    expect(isHabitCheckedOn(checkIns, "read", "2026-05-21")).toBe(false);
  });

  it("calculates total check-ins and streak through the anchor date", () => {
    const checkIns = [
      checkIn("work", "2026-05-18"),
      checkIn("work", "2026-05-20"),
      checkIn("work", "2026-05-21"),
      checkIn("work", "2026-05-22"),
      checkIn("other", "2026-05-22"),
      checkIn("work", "2026-05-23", { completed: false, progressPercent: 40 })
    ];

    expect(isHabitCheckedOn(checkIns, "work", "2026-05-21")).toBe(true);
    expect(calculateHabitStats("work", checkIns, "2026-05-22")).toEqual({
      totalCheckIns: 4,
      streakDays: 3
    });
    expect(calculateHabitStats("work", checkIns, "2026-05-19")).toEqual({
      totalCheckIns: 4,
      streakDays: 0
    });
    expect(isHabitCheckedOn(checkIns, "work", "2026-05-23")).toBe(false);
  });

  it("calculates current-month ratio against elapsed days", () => {
    const checkIns = [
      checkIn("work", "2026-05-01"),
      checkIn("work", "2026-05-05"),
      checkIn("work", "2026-05-10"),
      checkIn("work", "2026-06-01")
    ];

    expect(calculateHabitMonthStats("work", checkIns, "2026-05", "2026-05-10")).toEqual({
      checkedDays: 3,
      denominatorDays: 10,
      percent: 30
    });
  });

  it("builds monthly overview summaries", () => {
    const summaries = buildRecurringMonthlySummaries(
      [habit("work"), habit("read", { slot: "afternoon" })],
      [checkIn("work", "2026-05-20"), checkIn("work", "2026-05-21"), checkIn("read", "2026-05-21")],
      "2026-05",
      "2026-05-21",
      "2026-05-21"
    );

    expect(summaries.map((summary) => [summary.habit.id, summary.checkedDays, summary.streakDays])).toEqual([
      ["work", 2, 2],
      ["read", 1, 1]
    ]);
  });
});
