import { describe, expect, it } from "vitest";
import {
  defaultScheduleCategoryFilter,
  defaultScheduleTaskCategory,
  normalizeScheduleCategoryFilter,
  normalizeScheduleTaskCategory,
  scheduleCategoryEncryptionValue,
  scheduleCategoryFromEncryptionValue,
  scheduleCategoryLabel,
  scheduleTaskMatchesCategory
} from "./scheduleCategory";

describe("schedule category", () => {
  it("normalizes legacy or invalid task categories to work", () => {
    expect(defaultScheduleTaskCategory).toBe("work");
    expect(normalizeScheduleTaskCategory("work")).toBe("work");
    expect(normalizeScheduleTaskCategory("personal")).toBe("personal");
    expect(normalizeScheduleTaskCategory(undefined)).toBe("work");
    expect(normalizeScheduleTaskCategory("private")).toBe("work");
  });

  it("normalizes invalid filters to all", () => {
    expect(defaultScheduleCategoryFilter).toBe("all");
    expect(normalizeScheduleCategoryFilter("all")).toBe("all");
    expect(normalizeScheduleCategoryFilter("work")).toBe("work");
    expect(normalizeScheduleCategoryFilter("personal")).toBe("personal");
    expect(normalizeScheduleCategoryFilter(undefined)).toBe("all");
    expect(normalizeScheduleCategoryFilter("private")).toBe("all");
  });

  it("provides Korean labels for normalized categories", () => {
    expect(scheduleCategoryLabel("work")).toBe("업무");
    expect(scheduleCategoryLabel("personal")).toBe("개인");
    expect(scheduleCategoryLabel("invalid")).toBe("업무");
  });

  it("uses fixed-length encrypted category plaintexts without accepting unknown values", () => {
    const workValue = scheduleCategoryEncryptionValue("work");
    const personalValue = scheduleCategoryEncryptionValue("personal");

    expect(workValue).toHaveLength(personalValue.length);
    expect(scheduleCategoryFromEncryptionValue(workValue)).toBe("work");
    expect(scheduleCategoryFromEncryptionValue(personalValue)).toBe("personal");
    expect(scheduleCategoryFromEncryptionValue("private")).toBe("work");
  });

  it("matches all, work, and personal filters with legacy compatibility", () => {
    const workTask = { details: { category: "work" } };
    const personalTask = { details: { category: "personal" } };
    const legacyTask = { details: {} };

    expect(scheduleTaskMatchesCategory(workTask, "all")).toBe(true);
    expect(scheduleTaskMatchesCategory(workTask, "work")).toBe(true);
    expect(scheduleTaskMatchesCategory(workTask, "personal")).toBe(false);
    expect(scheduleTaskMatchesCategory(personalTask, "personal")).toBe(true);
    expect(scheduleTaskMatchesCategory(personalTask, "work")).toBe(false);
    expect(scheduleTaskMatchesCategory(legacyTask, "work")).toBe(true);
    expect(scheduleTaskMatchesCategory(legacyTask, "personal")).toBe(false);
    expect(scheduleTaskMatchesCategory(personalTask, "invalid")).toBe(true);
  });
});
