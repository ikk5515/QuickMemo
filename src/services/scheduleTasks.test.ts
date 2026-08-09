import { describe, expect, it } from "vitest";
import { defaultScheduleDetails, normalizeScheduleTaskDocument } from "./scheduleTasks";

const encryptedPayload = { version: 1, algorithm: "AES-GCM", cipherText: "cipher", iv: "iv" };

describe("normalizeScheduleTaskDocument", () => {
  it("defaults encrypted task details to the legacy work category", () => {
    expect(defaultScheduleDetails).toEqual({
      category: "work",
      description: "",
      checklist: []
    });
  });

  it("normalizes legacy priority fields without reviving archived tasks", () => {
    const task = normalizeScheduleTaskDocument({
      ownerUid: "user-a",
      status: "archived",
      dueDate: null,
      dueTimeMinutes: null,
      priority: "important-urgent",
      encryptedTitle: encryptedPayload,
      encryptedDetails: encryptedPayload,
      wrappedKeys: {},
      createdBy: "user-a",
      updatedBy: "user-a"
    });

    expect(task).toMatchObject({
      isImportant: true,
      isUrgent: true,
      status: "archived"
    });
  });
});
