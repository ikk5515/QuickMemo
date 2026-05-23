import { describe, expect, it } from "vitest";
import type { DecryptedScheduleTask } from "../types";
import {
  buildCalendarMonth,
  buildCalendarTaskLayout,
  buildScheduleTaskOrderUpdates,
  calculateMatrixSectionProgress,
  compareCalendarAgendaTasks,
  formatScheduleDateRange,
  formatScheduleTimeRange,
  formatTaskTime,
  groupMatrixTasksByDate,
  groupTasksByMatrix,
  groupTasksByTodoDate,
  isSafeScheduleDateRange,
  tasksByDate,
  matrixQuadrantForTask,
  normalizeScheduleTaskColor,
  scheduleDateRangeDays,
  scheduleTaskColorPalette,
  timeInputToMinutes
} from "./scheduleHelpers";

function timestamp(value: string) {
  return {
    toMillis: () => new Date(value).getTime()
  } as DecryptedScheduleTask["createdAt"];
}

function task(id: string, overrides: Partial<DecryptedScheduleTask> = {}): DecryptedScheduleTask {
  return {
    id,
    ownerUid: "user-a",
    status: "active",
    dueDate: null,
    dueTimeMinutes: null,
    isImportant: false,
    isUrgent: false,
    encryptedTitle: { version: 1, algorithm: "AES-GCM", cipherText: "cipher", iv: "iv" },
    encryptedDetails: { version: 1, algorithm: "AES-GCM", cipherText: "cipher", iv: "iv" },
    wrappedKeys: {
      "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "wrapped" }
    },
    createdBy: "user-a",
    updatedBy: "user-a",
    title: id,
    details: { description: "", checklist: [] },
    ...overrides
  };
}

describe("schedule helpers", () => {
  it("groups active and completed tasks by todo date", () => {
    const groups = groupTasksByTodoDate(
      [
        task("overdue", { dueDate: "2026-05-18" }),
        task("today", { dueDate: "2026-05-19" }),
        task("tomorrow", { dueDate: "2026-05-20" }),
        task("week", { dueDate: "2026-05-24" }),
        task("later", { dueDate: "2026-06-01" }),
        task("none"),
        task("done", { status: "completed", dueDate: "2026-05-19", completedAt: timestamp("2026-05-19T08:00:00Z") }),
        task("old-done", { status: "completed", dueDate: "2026-05-01", completedAt: timestamp("2026-05-01T08:00:00Z") })
      ],
      "2026-05-19"
    );

    expect(groups.map((group) => [group.key, group.tasks.map((item) => item.id)])).toEqual([
      ["today", ["overdue", "today"]],
      ["tomorrow", ["tomorrow"]],
      ["next7", ["week"]],
      ["later", ["later"]],
      ["noDate", ["none"]],
      ["completed", ["done"]]
    ]);
  });

  it("sorts todo groups by nearest date before priority, time, and newest creation", () => {
    const groups = groupTasksByTodoDate(
      [
        task("normal-old", {
          dueDate: "2026-05-19",
          createdAt: timestamp("2026-05-19T08:00:00Z")
        }),
        task("normal-new", {
          dueDate: "2026-05-19",
          createdAt: timestamp("2026-05-19T10:00:00Z")
        }),
        task("urgent", {
          dueDate: "2026-05-19",
          isUrgent: true,
          createdAt: timestamp("2026-05-19T07:00:00Z")
        }),
        task("important", {
          dueDate: "2026-05-19",
          isImportant: true,
          createdAt: timestamp("2026-05-19T06:00:00Z")
        }),
        task("top-late", {
          dueDate: "2026-05-19",
          isImportant: true,
          isUrgent: true,
          startTimeMinutes: 900,
          createdAt: timestamp("2026-05-19T11:00:00Z")
        }),
        task("top-early", {
          dueDate: "2026-05-19",
          isImportant: true,
          isUrgent: true,
          startTimeMinutes: 540,
          createdAt: timestamp("2026-05-19T05:00:00Z")
        })
      ],
      "2026-05-19"
    );

    expect(groups.find((group) => group.key === "today")?.tasks.map((item) => item.id)).toEqual([
      "top-early",
      "top-late",
      "important",
      "urgent",
      "normal-new",
      "normal-old"
    ]);
  });

  it("sorts upcoming todo groups by the closest date instead of newest creation", () => {
    const groups = groupTasksByTodoDate(
      [
        task("later-created-new", {
          dueDate: "2026-05-23",
          createdAt: timestamp("2026-05-19T12:00:00Z")
        }),
        task("soon-created-old", {
          dueDate: "2026-05-21",
          createdAt: timestamp("2026-05-19T07:00:00Z")
        }),
        task("middle-important", {
          dueDate: "2026-05-22",
          isImportant: true,
          createdAt: timestamp("2026-05-19T08:00:00Z")
        })
      ],
      "2026-05-19"
    );

    expect(groups.find((group) => group.key === "next7")?.tasks.map((item) => item.id)).toEqual([
      "soon-created-old",
      "middle-important",
      "later-created-new"
    ]);
  });

  it("uses manual sort order before automatic priority within the same date", () => {
    const groups = groupTasksByTodoDate(
      [
        task("important", {
          dueDate: "2026-05-19",
          isImportant: true,
          sortOrder: 2
        }),
        task("normal", {
          dueDate: "2026-05-19",
          sortOrder: 1
        }),
        task("other-date", {
          dueDate: "2026-05-20",
          sortOrder: 1
        })
      ],
      "2026-05-19"
    );

    expect(groups.find((group) => group.key === "today")?.tasks.map((item) => item.id)).toEqual([
      "normal",
      "important"
    ]);
    expect(groups.find((group) => group.key === "tomorrow")?.tasks.map((item) => item.id)).toEqual(["other-date"]);
  });

  it("builds same-date manual order updates and rejects cross-date reorders", () => {
    const tasks = [
      task("a", { dueDate: "2026-05-19", sortOrder: 1 }),
      task("b", { dueDate: "2026-05-19", sortOrder: 2 }),
      task("c", { dueDate: "2026-05-19", sortOrder: 3 }),
      task("next-day", { dueDate: "2026-05-20", sortOrder: 1 })
    ];

    expect(buildScheduleTaskOrderUpdates(tasks, "c", "a")).toEqual([
      { taskId: "c", sortOrder: 1 },
      { taskId: "a", sortOrder: 2 },
      { taskId: "b", sortOrder: 3 }
    ]);
    expect(buildScheduleTaskOrderUpdates(tasks, "a", "next-day")).toBeNull();
  });

  it("places multi-day tasks on every calendar date in range", () => {
    const dateMap = tasksByDate([
      task("range", {
        dueDate: "2026-05-15",
        startDate: "2026-05-15",
        endDate: "2026-05-17",
        startTimeMinutes: 540,
        endTimeMinutes: 600
      })
    ]);

    expect(dateMap["2026-05-15"].map((item) => item.id)).toEqual(["range"]);
    expect(dateMap["2026-05-16"].map((item) => item.id)).toEqual(["range"]);
    expect(dateMap["2026-05-17"].map((item) => item.id)).toEqual(["range"]);
    expect(dateMap["2026-05-18"]).toBeUndefined();
    expect(formatScheduleDateRange(dateMap["2026-05-15"][0])).toBe("2026-05-15 - 2026-05-17");
    expect(formatScheduleTimeRange(dateMap["2026-05-15"][0])).toBe("09:00 - 10:00");
  });

  it("keeps multi-day calendar tasks in the same visual slot across dates", () => {
    const weeks = buildCalendarMonth(2026, 4, "2026-05-19");
    const layout = buildCalendarTaskLayout(weeks, [
      task("single-20", {
        dueDate: "2026-05-20",
        startDate: "2026-05-20",
        endDate: "2026-05-20",
        createdAt: timestamp("2026-05-20T08:00:00Z")
      }),
      task("range-20-21", {
        dueDate: "2026-05-20",
        startDate: "2026-05-20",
        endDate: "2026-05-21",
        color: "#7f99c2",
        createdAt: timestamp("2026-05-20T09:00:00Z")
      })
    ]);

    expect(layout["2026-05-20"].map((placement) => placement?.task.id ?? null)).toEqual(["single-20", "range-20-21"]);
    expect(layout["2026-05-21"].map((placement) => placement?.task.id ?? null)).toEqual([null, "range-20-21"]);
    expect(layout["2026-05-21"][1]?.color).toBe("#7f99c2");
    expect(normalizeScheduleTaskColor("not-a-color", 2)).toBe(scheduleTaskColorPalette[2]);
  });

  it("sorts active tasks before completed tasks on the same calendar date", () => {
    const dateMap = tasksByDate([
      task("done-early", { status: "completed", dueDate: "2026-05-19", startTimeMinutes: 540 }),
      task("active-late", { dueDate: "2026-05-19", startTimeMinutes: 900 }),
      task("active-early", { dueDate: "2026-05-19", startTimeMinutes: 600 })
    ]);

    expect(dateMap["2026-05-19"].map((item) => item.id)).toEqual(["active-early", "active-late", "done-early"]);
  });

  it("sorts calendar agenda tasks like the todo view after active status", () => {
    const agendaTasks = [
      task("done-important", {
        status: "completed",
        dueDate: "2026-05-19",
        isImportant: true,
        completedAt: timestamp("2026-05-19T08:00:00Z")
      }),
      task("normal-new", {
        dueDate: "2026-05-19",
        createdAt: timestamp("2026-05-19T10:00:00Z")
      }),
      task("urgent", {
        dueDate: "2026-05-19",
        isUrgent: true,
        createdAt: timestamp("2026-05-19T07:00:00Z")
      }),
      task("important", {
        dueDate: "2026-05-19",
        isImportant: true,
        createdAt: timestamp("2026-05-19T06:00:00Z")
      }),
      task("top-late", {
        dueDate: "2026-05-19",
        isImportant: true,
        isUrgent: true,
        startTimeMinutes: 900,
        createdAt: timestamp("2026-05-19T11:00:00Z")
      }),
      task("top-early", {
        dueDate: "2026-05-19",
        isImportant: true,
        isUrgent: true,
        startTimeMinutes: 540,
        createdAt: timestamp("2026-05-19T05:00:00Z")
      })
    ].sort(compareCalendarAgendaTasks);

    expect(agendaTasks.map((item) => item.id)).toEqual([
      "top-early",
      "top-late",
      "important",
      "urgent",
      "normal-new",
      "done-important"
    ]);
  });

  it("rejects invalid and oversized calendar ranges before expanding tasks by date", () => {
    const dateMap = tasksByDate([
      task("invalid", { dueDate: "2026-99-99", startDate: "2026-99-99", endDate: "2026-99-99" }),
      task("oversized", { dueDate: "1900-01-01", startDate: "1900-01-01", endDate: "2199-12-31" })
    ]);

    expect(Object.keys(dateMap)).toEqual([]);
    expect(scheduleDateRangeDays("2026-02-29", "2026-02-29")).toBeNull();
    expect(isSafeScheduleDateRange("2028-02-29", "2028-02-29")).toBe(true);
    expect(isSafeScheduleDateRange("2026-01-01", "2026-12-31")).toBe(true);
    expect(isSafeScheduleDateRange("2026-12-31", "2027-01-01")).toBe(false);
  });

  it("builds a six-week calendar grid with today marked", () => {
    const weeks = buildCalendarMonth(2026, 4, "2026-05-19");

    expect(weeks).toHaveLength(6);
    expect(weeks[0].days[0].dateString).toBe("2026-04-26");
    expect(weeks[5].days[6].dateString).toBe("2026-06-06");
    expect(weeks.flatMap((week) => week.days).find((day) => day.dateString === "2026-05-19")?.isToday).toBe(true);
  });

  it("sorts tasks into Eisenhower matrix sections", () => {
    const sections = groupTasksByMatrix([
      task("urgent-important", { dueDate: "2026-05-20", isImportant: true, isUrgent: true }),
      task("future-urgent-important", { dueDate: "2026-05-26", isImportant: true, isUrgent: true }),
      task("no-date-urgent-important", { isImportant: true, isUrgent: true }),
      task("urgent-sooner", { isImportant: false, isUrgent: true, startDate: "2026-05-20", startTimeMinutes: 720 }),
      task("urgent", { isImportant: false, isUrgent: true, startDate: "2026-05-21", startTimeMinutes: 600 }),
      task("urgent-earlier", { isImportant: false, isUrgent: true, startDate: "2026-05-21", startTimeMinutes: 540 }),
      task("important", { isImportant: true, isUrgent: false }),
      task("waiting-old", { createdAt: timestamp("2026-05-18T08:00:00Z") }),
      task("waiting-new", { createdAt: timestamp("2026-05-19T08:00:00Z") }),
      task("done", { status: "completed", isImportant: true, isUrgent: true })
    ], "2026-05-20");

    expect(matrixQuadrantForTask({ isImportant: true, isUrgent: false })).toBe("importantNotUrgent");
    expect(sections.map((section) => [section.key, section.tasks.map((item) => item.id)])).toEqual([
      ["urgentImportant", ["urgent-important"]],
      ["firstPriority", ["future-urgent-important", "no-date-urgent-important"]],
      ["urgentNotImportant", ["urgent-sooner", "urgent-earlier", "urgent"]],
      ["importantNotUrgent", ["important"]],
      ["notUrgentNotImportant", ["waiting-new", "waiting-old"]]
    ]);
    expect(sections.find((section) => section.key === "firstPriority")?.dateGroups.map((group) => [group.key, group.tasks.map((item) => item.id)])).toEqual([
      ["next3", []],
      ["later", ["future-urgent-important"]],
      ["noDate", ["no-date-urgent-important"]]
    ]);
  });

  it("groups non-primary matrix sections by next three days, later, and no date", () => {
    const groups = groupMatrixTasksByDate(
      [
        task("overdue", { dueDate: "2026-05-19" }),
        task("three-day-end", { dueDate: "2026-05-23" }),
        task("later", { dueDate: "2026-05-24" }),
        task("none")
      ],
      "2026-05-20"
    );

    expect(groups.map((group) => [group.key, group.tasks.map((item) => item.id)])).toEqual([
      ["next3", ["overdue", "three-day-end"]],
      ["later", ["later"]],
      ["noDate", ["none"]]
    ]);
  });

  it("calculates matrix section progress from checklist items", () => {
    expect(
      calculateMatrixSectionProgress([
        task("a", {
          details: {
            description: "",
            checklist: [
              { id: "a-1", text: "첫 항목", checked: true },
              { id: "a-2", text: "둘째 항목", checked: false }
            ]
          }
        }),
        task("b", {
          details: {
            description: "",
            checklist: [{ id: "b-1", text: "셋째 항목", checked: true }]
          }
        })
      ])
    ).toEqual({ checked: 2, percent: 67, total: 3 });
    expect(calculateMatrixSectionProgress([task("empty")])).toEqual({ checked: 0, percent: 0, total: 0 });
  });

  it("converts time input to minutes and back", () => {
    expect(timeInputToMinutes("16:30")).toBe(990);
    expect(timeInputToMinutes("")).toBeNull();
    expect(formatTaskTime(990)).toBe("16:30");
    expect(formatTaskTime(null)).toBe("");
  });
});
