import type { ScheduleCategoryFilter, ScheduleTaskCategory } from "../types";

export const defaultScheduleTaskCategory: ScheduleTaskCategory = "work";
export const defaultScheduleCategoryFilter: ScheduleCategoryFilter = "all";

const scheduleCategoryLabels: Record<ScheduleTaskCategory, string> = {
  work: "업무",
  personal: "개인"
};
const encryptedScheduleCategoryValues: Record<ScheduleTaskCategory, string> = {
  work: "work____",
  personal: "personal"
};

export function normalizeScheduleTaskCategory(value: unknown): ScheduleTaskCategory {
  return value === "personal" ? "personal" : defaultScheduleTaskCategory;
}

export function normalizeScheduleCategoryFilter(value: unknown): ScheduleCategoryFilter {
  return value === "work" || value === "personal" ? value : defaultScheduleCategoryFilter;
}

export function scheduleCategoryEncryptionValue(category: unknown) {
  return encryptedScheduleCategoryValues[normalizeScheduleTaskCategory(category)];
}

export function scheduleCategoryFromEncryptionValue(value: unknown) {
  if (value === encryptedScheduleCategoryValues.personal) {
    return "personal" satisfies ScheduleTaskCategory;
  }

  return defaultScheduleTaskCategory;
}

export function scheduleCategoryLabel(category: unknown) {
  return scheduleCategoryLabels[normalizeScheduleTaskCategory(category)];
}

export function scheduleTaskMatchesCategory(
  task: { details?: { category?: unknown } | null },
  filter: unknown
) {
  const normalizedFilter = normalizeScheduleCategoryFilter(filter);

  return normalizedFilter === "all"
    || normalizeScheduleTaskCategory(task.details?.category) === normalizedFilter;
}
