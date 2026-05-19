import { describe, expect, it } from "vitest";
import type { ScheduleTaskDetails } from "../types";
import { decryptText, encryptText, generateNoteKey } from "./crypto";
import { normalizeScheduleDetails } from "./scheduleHelpers";

describe("schedule task encryption", () => {
  it("encrypts and decrypts schedule title and details", async () => {
    const key = await generateNoteKey();
    const details: ScheduleTaskDetails = {
      description: "오후 회의 준비",
      checklist: [{ id: "item-1", text: "자료 확인", checked: false }]
    };

    const encryptedTitle = await encryptText("회의 준비", key);
    const encryptedDetails = await encryptText(JSON.stringify(details), key);

    await expect(decryptText(encryptedTitle, key)).resolves.toBe("회의 준비");
    await expect(decryptText(encryptedDetails, key).then((value) => normalizeScheduleDetails(JSON.parse(value)))).resolves.toEqual(details);
  });
});
