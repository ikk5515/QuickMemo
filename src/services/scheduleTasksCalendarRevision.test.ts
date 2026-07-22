import { beforeEach, describe, expect, it, vi } from "vitest";
import { Timestamp } from "firebase/firestore";
import {
  createScheduleTask,
  ScheduleTaskRevisionConflictError,
  updateScheduleTask
} from "./scheduleTasks";

const firestoreMocks = vi.hoisted(() => {
  const transaction = {
    get: vi.fn(),
    update: vi.fn()
  };

  return {
    addDoc: vi.fn(),
    collection: vi.fn((...parts: unknown[]) => ({ parts })),
    db: { __type: "firestore" },
    doc: vi.fn((...parts: unknown[]) => ({ parts })),
    getDocFromServer: vi.fn(),
    onSnapshot: vi.fn(),
    query: vi.fn(),
    runTransaction: vi.fn(),
    serverTimestamp: vi.fn(() => ({ __type: "serverTimestamp" })),
    Timestamp: class Timestamp {
      constructor(readonly seconds: number, readonly nanoseconds: number) {}
    },
    transaction,
    updateDoc: vi.fn(),
    where: vi.fn(),
    writeBatch: vi.fn()
  };
});

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
    firestoreMocks.runTransaction.mockImplementation(async (_db, updateFunction) =>
      updateFunction(firestoreMocks.transaction)
    );
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

  it("updates in a transaction when the expected updatedAt revision matches exactly", async () => {
    const expectedUpdatedAt = new Timestamp(1_753_142_400, 7);
    firestoreMocks.transaction.get.mockResolvedValue({
      data: () => ({ ownerUid: "user-a", updatedAt: new Timestamp(1_753_142_400, 7) }),
      exists: () => true
    });

    await updateScheduleTask(
      "task-a",
      "user-a",
      { startDate: "2026-07-23" },
      { expectedUpdatedAt }
    );

    expect(firestoreMocks.updateDoc).not.toHaveBeenCalled();
    expect(firestoreMocks.transaction.get).toHaveBeenCalledWith({
      parts: [firestoreMocks.db, "scheduleTasks", "task-a"]
    });
    expect(firestoreMocks.transaction.update).toHaveBeenCalledWith(
      { parts: [firestoreMocks.db, "scheduleTasks", "task-a"] },
      expect.objectContaining({
        calendarUpdatedAt: { __type: "serverTimestamp" },
        startDate: "2026-07-23",
        updatedAt: { __type: "serverTimestamp" },
        updatedBy: "user-a"
      })
    );
  });

  it("rejects a stale expected revision without writing", async () => {
    firestoreMocks.transaction.get.mockResolvedValue({
      data: () => ({ ownerUid: "user-a", updatedAt: new Timestamp(1_753_142_401, 0) }),
      exists: () => true
    });

    await expect(updateScheduleTask(
      "task-a",
      "user-a",
      { progressPercent: 75 },
      { expectedUpdatedAt: new Timestamp(1_753_142_400, 999_999_999) }
    )).rejects.toEqual(expect.objectContaining<Partial<ScheduleTaskRevisionConflictError>>({
      code: "schedule-task/revision-conflict",
      reason: "revision-mismatch"
    }));

    expect(firestoreMocks.transaction.update).not.toHaveBeenCalled();
    expect(firestoreMocks.updateDoc).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "missing",
      snapshot: { exists: (): boolean => false }
    },
    {
      label: "owned by another user",
      snapshot: {
        data: () => ({ ownerUid: "user-b", updatedAt: new Timestamp(1_753_142_400, 0) }),
        exists: (): boolean => true
      }
    }
  ])("rejects a $label task without writing", async ({ snapshot }) => {
    firestoreMocks.transaction.get.mockResolvedValue(snapshot);

    await expect(updateScheduleTask(
      "task-a",
      "user-a",
      { progressPercent: 75 },
      { expectedUpdatedAt: new Timestamp(1_753_142_400, 0) }
    )).rejects.toEqual(expect.objectContaining<Partial<ScheduleTaskRevisionConflictError>>({
      code: "schedule-task/revision-conflict",
      reason: "missing-or-forbidden"
    }));

    expect(firestoreMocks.transaction.update).not.toHaveBeenCalled();
    expect(firestoreMocks.updateDoc).not.toHaveBeenCalled();
  });

  it("preserves Calendar revision override semantics in the guarded transaction", async () => {
    const expectedUpdatedAt = new Timestamp(1_753_142_400, 0);
    firestoreMocks.transaction.get.mockResolvedValue({
      data: () => ({ ownerUid: "user-a", updatedAt: expectedUpdatedAt }),
      exists: () => true
    });

    await updateScheduleTask(
      "task-a",
      "user-a",
      { encryptedTitle: encrypted, progressPercent: 25 },
      { expectedUpdatedAt, googleCalendarChanged: false }
    );

    expect(firestoreMocks.transaction.update).toHaveBeenLastCalledWith(
      { parts: [firestoreMocks.db, "scheduleTasks", "task-a"] },
      expect.not.objectContaining({ calendarUpdatedAt: expect.anything() })
    );

    await updateScheduleTask(
      "task-a",
      "user-a",
      { progressPercent: 50 },
      { expectedUpdatedAt, googleCalendarChanged: true }
    );

    expect(firestoreMocks.transaction.update).toHaveBeenLastCalledWith(
      { parts: [firestoreMocks.db, "scheduleTasks", "task-a"] },
      expect.objectContaining({ calendarUpdatedAt: { __type: "serverTimestamp" } })
    );
  });
});
