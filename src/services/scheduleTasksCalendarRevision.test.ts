import { beforeEach, describe, expect, it, vi } from "vitest";
import { createScheduleTask, updateScheduleTask } from "./scheduleTasks";

const firestoreMocks = vi.hoisted(() => ({
  addDoc: vi.fn(),
  collection: vi.fn((...parts: unknown[]) => ({ parts })),
  db: { __type: "firestore" },
  doc: vi.fn((...parts: unknown[]) => ({ parts })),
  getDocFromServer: vi.fn(),
  onSnapshot: vi.fn(),
  query: vi.fn(),
  runTransaction: vi.fn(),
  serverTimestamp: vi.fn(() => ({ __type: "serverTimestamp" })),
  Timestamp: class Timestamp {},
  updateDoc: vi.fn(),
  where: vi.fn(),
  writeBatch: vi.fn()
}));

vi.mock("../lib/firebase", () => ({ db: firestoreMocks.db }));
vi.mock("firebase/firestore", () => ({
  addDoc: firestoreMocks.addDoc,
  collection: firestoreMocks.collection,
  doc: firestoreMocks.doc,
  getDocFromServer: firestoreMocks.getDocFromServer,
  onSnapshot: firestoreMocks.onSnapshot,
  query: firestoreMocks.query,
  runTransaction: firestoreMocks.runTransaction,
  serverTimestamp: firestoreMocks.serverTimestamp,
  Timestamp: firestoreMocks.Timestamp,
  updateDoc: firestoreMocks.updateDoc,
  where: firestoreMocks.where,
  writeBatch: firestoreMocks.writeBatch
}));

const encrypted = { version: 1 as const, algorithm: "AES-GCM" as const, cipherText: "cipher", iv: "iv" };
const wrapped = { version: 1 as const, algorithm: "RSA-OAEP" as const, wrappedKey: "wrapped" };

describe("schedule task Google Calendar revisions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    firestoreMocks.addDoc.mockResolvedValue({ id: "task-a" });
    firestoreMocks.updateDoc.mockResolvedValue(undefined);
  });

  it("creates a dedicated Calendar projection revision", async () => {
    await createScheduleTask({
      ownerUid: "user-a",
      title: encrypted,
      details: encrypted,
      wrappedKey: wrapped,
      dueDate: "2026-07-22",
      dueTimeMinutes: null,
      isImportant: false,
      isUrgent: false
    });

    expect(firestoreMocks.addDoc).toHaveBeenCalledWith(
      { parts: [firestoreMocks.db, "scheduleTasks"] },
      expect.objectContaining({
        calendarUpdatedAt: { __type: "serverTimestamp" },
        updatedAt: { __type: "serverTimestamp" }
      })
    );
  });

  it("advances the Calendar revision only for fields sent to Google", async () => {
    await updateScheduleTask("task-a", "user-a", { encryptedDetails: encrypted, progressPercent: 50 });
    expect(firestoreMocks.updateDoc).toHaveBeenLastCalledWith(
      { parts: [firestoreMocks.db, "scheduleTasks", "task-a"] },
      expect.not.objectContaining({ calendarUpdatedAt: expect.anything() })
    );

    await updateScheduleTask("task-a", "user-a", { startDate: "2026-07-23" });
    expect(firestoreMocks.updateDoc).toHaveBeenLastCalledWith(
      { parts: [firestoreMocks.db, "scheduleTasks", "task-a"] },
      expect.objectContaining({ calendarUpdatedAt: { __type: "serverTimestamp" } })
    );
  });

  it("lets a caller suppress a no-op Calendar revision during a full form save", async () => {
    await updateScheduleTask(
      "task-a",
      "user-a",
      { encryptedTitle: encrypted, startDate: "2026-07-22" },
      { googleCalendarChanged: false }
    );

    expect(firestoreMocks.updateDoc).toHaveBeenCalledWith(
      { parts: [firestoreMocks.db, "scheduleTasks", "task-a"] },
      expect.not.objectContaining({ calendarUpdatedAt: expect.anything() })
    );
  });
});
