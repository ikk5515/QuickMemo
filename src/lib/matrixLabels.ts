import type { MatrixLabelKey, MatrixLabels } from "../types";

export const matrixLabelMaxLength = 16;

export const defaultMatrixLabels: MatrixLabels = {
  todayOverdue: "오늘/지연",
  importantUrgent: "중요·긴급",
  urgent: "긴급 업무",
  important: "중요 업무",
  waiting: "대기 업무"
};

export const matrixLabelFields: Array<{ key: MatrixLabelKey; label: string; description: string }> = [
  {
    key: "todayOverdue",
    label: defaultMatrixLabels.todayOverdue,
    description: "오늘 진행 중이거나 지연된 중요·긴급 업무"
  },
  {
    key: "importantUrgent",
    label: defaultMatrixLabels.importantUrgent,
    description: "오늘 이후로 예정된 중요·긴급 업무"
  },
  {
    key: "urgent",
    label: defaultMatrixLabels.urgent,
    description: "긴급하지만 중요도는 낮은 업무"
  },
  {
    key: "important",
    label: defaultMatrixLabels.important,
    description: "중요하지만 당장 급하지 않은 업무"
  },
  {
    key: "waiting",
    label: defaultMatrixLabels.waiting,
    description: "대기하거나 나중에 처리할 업무"
  }
];

export function normalizeMatrixLabel(value: unknown, fallback: string) {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmedValue = value.trim();

  return trimmedValue.length > 0 && trimmedValue.length <= matrixLabelMaxLength ? trimmedValue : fallback;
}

export function normalizeMatrixLabels(value: Partial<MatrixLabels> | null | undefined): MatrixLabels {
  return {
    todayOverdue: normalizeMatrixLabel(value?.todayOverdue, defaultMatrixLabels.todayOverdue),
    importantUrgent: normalizeMatrixLabel(value?.importantUrgent, defaultMatrixLabels.importantUrgent),
    urgent: normalizeMatrixLabel(value?.urgent, defaultMatrixLabels.urgent),
    important: normalizeMatrixLabel(value?.important, defaultMatrixLabels.important),
    waiting: normalizeMatrixLabel(value?.waiting, defaultMatrixLabels.waiting)
  };
}

export function sanitizeMatrixLabelsForSave(value: Partial<MatrixLabels>): MatrixLabels {
  return {
    todayOverdue: (value.todayOverdue ?? "").trim(),
    importantUrgent: (value.importantUrgent ?? "").trim(),
    urgent: (value.urgent ?? "").trim(),
    important: (value.important ?? "").trim(),
    waiting: (value.waiting ?? "").trim()
  };
}

export function validateMatrixLabels(value: Partial<MatrixLabels>) {
  const labels = sanitizeMatrixLabelsForSave(value);
  const invalidField = matrixLabelFields.find(({ key }) => labels[key].length === 0);

  if (invalidField) {
    return `${invalidField.label} 명칭을 입력해 주세요.`;
  }

  const longField = matrixLabelFields.find(({ key }) => labels[key].length > matrixLabelMaxLength);

  if (longField) {
    return `${longField.label} 명칭은 ${matrixLabelMaxLength}자 이내로 입력해 주세요.`;
  }

  return null;
}

export function matrixLabelForSectionKey(sectionKey: string, labelsInput?: Partial<MatrixLabels>) {
  const labels = normalizeMatrixLabels(labelsInput);

  if (sectionKey === "urgentImportant") {
    return labels.todayOverdue;
  }

  if (sectionKey === "firstPriority") {
    return labels.importantUrgent;
  }

  if (sectionKey === "urgentNotImportant") {
    return labels.urgent;
  }

  if (sectionKey === "importantNotUrgent") {
    return labels.important;
  }

  return labels.waiting;
}
