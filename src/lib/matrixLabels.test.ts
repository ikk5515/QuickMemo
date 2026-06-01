import { describe, expect, it } from "vitest";
import {
  defaultMatrixLabels,
  matrixLabelForSectionKey,
  matrixLabelMaxLength,
  normalizeMatrixLabels,
  sanitizeMatrixLabelsForSave,
  validateMatrixLabels
} from "./matrixLabels";

describe("matrix labels", () => {
  it("normalizes missing or unsafe labels to defaults", () => {
    expect(normalizeMatrixLabels(null)).toEqual(defaultMatrixLabels);
    expect(
      normalizeMatrixLabels({
        importantUrgent: "  바로 처리  ",
        urgent: "",
        important: "x".repeat(matrixLabelMaxLength + 1),
        waiting: "대기"
      })
    ).toEqual({
      importantUrgent: "바로 처리",
      urgent: defaultMatrixLabels.urgent,
      important: defaultMatrixLabels.important,
      waiting: "대기"
    });
  });

  it("validates trimmed labels before saving", () => {
    expect(
      sanitizeMatrixLabelsForSave({
        importantUrgent: "  바로 처리  ",
        urgent: "긴급",
        important: "중요",
        waiting: "대기"
      })
    ).toEqual({
      importantUrgent: "바로 처리",
      urgent: "긴급",
      important: "중요",
      waiting: "대기"
    });
    expect(validateMatrixLabels({ ...defaultMatrixLabels, urgent: "   " })).toBe("긴급 업무 명칭을 입력해 주세요.");
    expect(validateMatrixLabels({ ...defaultMatrixLabels, waiting: "가".repeat(matrixLabelMaxLength + 1) })).toBe(
      `대기 업무 명칭은 ${matrixLabelMaxLength}자 이내로 입력해 주세요.`
    );
  });

  it("maps both important-urgent matrix sections to the same user label", () => {
    const labels = { ...defaultMatrixLabels, importantUrgent: "최우선" };

    expect(matrixLabelForSectionKey("urgentImportant", labels)).toBe("최우선");
    expect(matrixLabelForSectionKey("firstPriority", labels)).toBe("최우선");
    expect(matrixLabelForSectionKey("urgentNotImportant", labels)).toBe(defaultMatrixLabels.urgent);
    expect(matrixLabelForSectionKey("importantNotUrgent", labels)).toBe(defaultMatrixLabels.important);
    expect(matrixLabelForSectionKey("notUrgentNotImportant", labels)).toBe(defaultMatrixLabels.waiting);
  });
});
