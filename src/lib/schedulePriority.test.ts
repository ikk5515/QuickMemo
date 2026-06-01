import { describe, expect, it } from "vitest";
import { normalizeSchedulePriorityFlags } from "./schedulePriority";

describe("normalizeSchedulePriorityFlags", () => {
  it("keeps explicit current priority flags authoritative", () => {
    expect(normalizeSchedulePriorityFlags({ isImportant: false, isUrgent: false, priority: "important-urgent" })).toEqual({
      isImportant: false,
      isUrgent: false
    });
  });

  it("recovers legacy important and urgent values when current flags are missing", () => {
    expect(normalizeSchedulePriorityFlags({ priority: "important-urgent" })).toEqual({
      isImportant: true,
      isUrgent: true
    });
    expect(normalizeSchedulePriorityFlags({ important: true, urgency: "high" })).toEqual({
      isImportant: true,
      isUrgent: true
    });
    expect(normalizeSchedulePriorityFlags({ importance: "high", priority: "normal" })).toEqual({
      isImportant: true,
      isUrgent: false
    });
  });
});
