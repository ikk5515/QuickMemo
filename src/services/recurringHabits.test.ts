import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteRecurringHabit,
  setRecurringHabitCheckIn,
  subscribeRecurringHabitCheckIns,
  updateRecurringHabitFromLatest,
  updateRecurringHabitDayState
} from "./recurringHabits";

const firestoreMocks = vi.hoisted(() => {
  const timestamp = { __type: "serverTimestamp" };
  const transaction = {
    delete: vi.fn(),
    get: vi.fn(),
    set: vi.fn(),
    update: vi.fn()
  };
  const batch = {
    commit: vi.fn(),
    delete: vi.fn(),
    update: vi.fn()
  };

  return {
    batch,
    collection: vi.fn((...parts: unknown[]) => ({ collectionParts: parts })),
    db: { __type: "firestore" },
    deleteDoc: vi.fn(),
    doc: vi.fn((...parts: unknown[]) => ({ parts })),
    getDocs: vi.fn(),
    limit: vi.fn((count: number) => ({ count, type: "limit" })),
    onSnapshot: vi.fn(() => vi.fn()),
    query: vi.fn((...parts: unknown[]) => ({ queryParts: parts })),
    runTransaction: vi.fn(),
    serverTimestamp: vi.fn(() => timestamp),
    setDoc: vi.fn(),
    timestamp,
    transaction,
    where: vi.fn((...parts: unknown[]) => ({ parts, type: "where" })),
    writeBatch: vi.fn(() => batch)
  };
});

vi.mock("../lib/firebase", () => ({
  db: firestoreMocks.db
}));

vi.mock("firebase/firestore", () => ({
  collection: firestoreMocks.collection,
  deleteDoc: firestoreMocks.deleteDoc,
  doc: firestoreMocks.doc,
  getDocs: firestoreMocks.getDocs,
  limit: firestoreMocks.limit,
  onSnapshot: firestoreMocks.onSnapshot,
  query: firestoreMocks.query,
  runTransaction: firestoreMocks.runTransaction,
  serverTimestamp: firestoreMocks.serverTimestamp,
  setDoc: firestoreMocks.setDoc,
  where: firestoreMocks.where,
  writeBatch: firestoreMocks.writeBatch
}));

function transactionSnapshot(exists: boolean, data: Record<string, unknown> = {}) {
  return {
    data: () => data,
    exists: () => exists,
    id: "document-a"
  };
}

describe("recurring habit persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    firestoreMocks.batch.commit.mockResolvedValue(undefined);
    firestoreMocks.runTransaction.mockImplementation(async (_db, updateFunction) =>
      updateFunction(firestoreMocks.transaction)
    );
    firestoreMocks.transaction.get.mockResolvedValue(transactionSnapshot(true, {
      ownerUid: "user-a",
      status: "active"
    }));
  });

  it("updates an existing day state atomically and normalizes completion", async () => {
    firestoreMocks.transaction.get.mockResolvedValueOnce(transactionSnapshot(true, {
      checkedItemIds: ["first"],
      completed: false,
      progressPercent: 40
    }));

    const result = await updateRecurringHabitDayState("user-a", "habit-a", "2026-06-02", {
      progressPercent: 60
    });

    expect(result).toEqual({ checkedItemIds: ["first"], completed: false, progressPercent: 60 });
    expect(firestoreMocks.transaction.update).toHaveBeenCalledWith(
      { parts: [firestoreMocks.db, "recurringHabitCheckIns", "habit-a_2026-06-02"] },
      {
        checkedAt: null,
        checkedItemIds: ["first"],
        completed: false,
        progressPercent: 60,
        updatedAt: firestoreMocks.timestamp
      }
    );
    expect(firestoreMocks.transaction.set).not.toHaveBeenCalled();
  });

  it("creates the first day state in the same transaction", async () => {
    firestoreMocks.transaction.get.mockResolvedValueOnce(transactionSnapshot(false));

    await updateRecurringHabitDayState("user-a", "habit-a", "2026-06-02", {
      progressPercent: 60
    });

    expect(firestoreMocks.transaction.set).toHaveBeenCalledWith(
      { parts: [firestoreMocks.db, "recurringHabitCheckIns", "habit-a_2026-06-02"] },
      {
        checkedAt: null,
        checkedItemIds: [],
        completed: false,
        createdAt: firestoreMocks.timestamp,
        date: "2026-06-02",
        habitId: "habit-a",
        ownerUid: "user-a",
        progressPercent: 60,
        updatedAt: firestoreMocks.timestamp
      }
    );
  });

  it("reapplies a checklist toggle to the latest transaction snapshot", async () => {
    firestoreMocks.transaction.get.mockResolvedValueOnce(transactionSnapshot(true, {
      checkedItemIds: ["first"],
      completed: false,
      progressPercent: 50
    }));

    const result = await updateRecurringHabitDayState("user-a", "habit-a", "2026-06-02", {
      checkedItemIds: ["second"],
      completed: false,
      progressPercent: 50,
      toggleCheckedItem: {
        allowedItemIds: ["first", "second"],
        itemId: "second"
      }
    });

    expect(result).toEqual({
      checkedItemIds: ["first", "second"],
      completed: true,
      progressPercent: 100
    });
    expect(firestoreMocks.transaction.update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        checkedItemIds: ["first", "second"],
        completed: true,
        progressPercent: 100
      })
    );
  });

  it("builds encrypted habit updates from the latest transactional snapshot", async () => {
    firestoreMocks.transaction.get.mockResolvedValueOnce(transactionSnapshot(true, {
      ownerUid: "user-a",
      status: "active"
    }));
    const buildUpdate = vi.fn(async (habit) => ({
      input: { color: "#123456" },
      result: habit.id
    }));

    const result = await updateRecurringHabitFromLatest("habit-a", "user-a", buildUpdate);

    expect(result).toBe("document-a");
    expect(buildUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: "document-a", ownerUid: "user-a" }));
    expect(firestoreMocks.transaction.update).toHaveBeenCalledWith(
      { parts: [firestoreMocks.db, "recurringHabits", "habit-a"] },
      expect.objectContaining({ color: "#123456", updatedBy: "user-a" })
    );
  });

  it("deletes an existing check-in atomically when unchecked", async () => {
    firestoreMocks.transaction.get.mockResolvedValueOnce(transactionSnapshot(true));

    await setRecurringHabitCheckIn("user-a", "habit-a", "2026-06-02", false);

    expect(firestoreMocks.transaction.delete).toHaveBeenCalledWith(
      { parts: [firestoreMocks.db, "recurringHabitCheckIns", "habit-a_2026-06-02"] }
    );
  });

  it("limits the lightweight today-panel subscription to one date", () => {
    subscribeRecurringHabitCheckIns("user-a", vi.fn(), vi.fn(), { date: "2026-06-02" });

    expect(firestoreMocks.where).toHaveBeenCalledWith("ownerUid", "==", "user-a");
    expect(firestoreMocks.where).toHaveBeenCalledWith("date", "==", "2026-06-02");
  });

  it("applies recurring check-in snapshot changes incrementally", () => {
    const callback = vi.fn();

    subscribeRecurringHabitCheckIns("user-a", callback);
    const lastSubscriptionCall = firestoreMocks.onSnapshot.mock.calls.at(-1) as unknown[] | undefined;
    const snapshotCallback = lastSubscriptionCall?.[1] as ((snapshot: unknown) => void) | undefined;

    if (!snapshotCallback) {
      throw new Error("Expected recurring check-in snapshot callback.");
    }

    snapshotCallback({
      docChanges: () => [
        {
          doc: {
            data: () => ({ habitId: "habit-a", ownerUid: "user-a", date: "2026-06-02" }),
            id: "habit-a_2026-06-02"
          },
          type: "added"
        }
      ]
    });
    snapshotCallback({
      docChanges: () => [
        {
          doc: {
            data: () => ({ habitId: "habit-b", ownerUid: "user-a", date: "2026-06-03" }),
            id: "habit-b_2026-06-03"
          },
          type: "added"
        },
        {
          doc: { data: vi.fn(), id: "habit-a_2026-06-02" },
          type: "removed"
        }
      ]
    });

    expect(callback).toHaveBeenNthCalledWith(1, [
      expect.objectContaining({ id: "habit-a_2026-06-02" })
    ]);
    expect(callback).toHaveBeenNthCalledWith(2, [
      expect.objectContaining({ id: "habit-b_2026-06-03" })
    ]);
  });

  it("archives before deleting bounded batches for one habit", async () => {
    const checkInRef = { id: "check-in-a" };
    firestoreMocks.getDocs
      .mockResolvedValueOnce({ docs: [{ ref: checkInRef }], empty: false })
      .mockResolvedValueOnce({ docs: [], empty: true });
    firestoreMocks.deleteDoc.mockResolvedValueOnce(undefined);

    await deleteRecurringHabit("habit-a", "user-a");

    expect(firestoreMocks.transaction.update).toHaveBeenCalledWith(
      { parts: [firestoreMocks.db, "recurringHabits", "habit-a"] },
      expect.objectContaining({ status: "archived", updatedBy: "user-a" })
    );
    expect(firestoreMocks.where).toHaveBeenCalledWith("habitId", "==", "habit-a");
    expect(firestoreMocks.limit).toHaveBeenCalledWith(450);
    expect(firestoreMocks.batch.delete).toHaveBeenCalledWith(checkInRef);
    expect(firestoreMocks.deleteDoc).toHaveBeenCalledWith(
      { parts: [firestoreMocks.db, "recurringHabits", "habit-a"] }
    );
  });

  it("keeps an archived deletion pending when cleanup fails before the first batch", async () => {
    const cleanupError = { code: "failed-precondition" };
    firestoreMocks.getDocs.mockRejectedValueOnce(cleanupError);

    await expect(deleteRecurringHabit("habit-a", "user-a")).rejects.toThrow(
      "반복 업무 삭제 정리가 중단됐습니다."
    );

    expect(firestoreMocks.transaction.update).toHaveBeenCalledWith(
      { parts: [firestoreMocks.db, "recurringHabits", "habit-a"] },
      expect.objectContaining({ status: "archived" })
    );
    expect(firestoreMocks.transaction.update).toHaveBeenCalledTimes(1);
    expect(firestoreMocks.deleteDoc).not.toHaveBeenCalled();
  });

  it("keeps a durable archived state after a partial cleanup so deletion can resume", async () => {
    const cleanupError = { code: "unavailable" };
    firestoreMocks.getDocs
      .mockResolvedValueOnce({ docs: [{ ref: { id: "first-batch" } }], empty: false })
      .mockRejectedValueOnce(cleanupError);

    await expect(deleteRecurringHabit("habit-a", "user-a")).rejects.toThrow(
      "반복 업무 삭제 정리가 중단됐습니다."
    );

    expect(firestoreMocks.batch.commit).toHaveBeenCalledTimes(1);
    expect(firestoreMocks.transaction.update).toHaveBeenCalledTimes(1);
    expect(firestoreMocks.transaction.update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "archived" })
    );
    expect(firestoreMocks.deleteDoc).not.toHaveBeenCalled();
  });

  it("resumes an already archived deletion without restoring it on failure", async () => {
    firestoreMocks.transaction.get.mockResolvedValueOnce(transactionSnapshot(true, {
      ownerUid: "user-a",
      status: "archived"
    }));
    firestoreMocks.getDocs.mockResolvedValueOnce({ docs: [], empty: true });
    firestoreMocks.deleteDoc.mockResolvedValueOnce(undefined);

    await deleteRecurringHabit("habit-a", "user-a");

    expect(firestoreMocks.transaction.update).not.toHaveBeenCalled();
    expect(firestoreMocks.deleteDoc).toHaveBeenCalledTimes(1);
  });

  it("continues when another tab already removed the same check-in batch", async () => {
    firestoreMocks.getDocs
      .mockResolvedValueOnce({ docs: [{ ref: { id: "concurrent-check-in" } }], empty: false })
      .mockResolvedValueOnce({ docs: [], empty: true });
    firestoreMocks.batch.commit.mockRejectedValueOnce({ code: "permission-denied" });
    firestoreMocks.deleteDoc.mockResolvedValueOnce(undefined);

    await deleteRecurringHabit("habit-a", "user-a");

    expect(firestoreMocks.batch.commit).toHaveBeenCalledTimes(1);
    expect(firestoreMocks.deleteDoc).toHaveBeenCalledTimes(1);
  });

  it("treats a concurrently removed archived parent as a completed deletion", async () => {
    firestoreMocks.getDocs
      .mockResolvedValueOnce({ docs: [], empty: true })
      .mockResolvedValueOnce({ docs: [], empty: true });
    firestoreMocks.deleteDoc.mockRejectedValueOnce({ code: "permission-denied" });

    await deleteRecurringHabit("habit-a", "user-a");

    expect(firestoreMocks.where).toHaveBeenCalledWith("ownerUid", "==", "user-a");
  });

  it("does not hide transaction failures", async () => {
    const error = { code: "unavailable" };
    firestoreMocks.runTransaction.mockRejectedValueOnce(error);

    await expect(
      updateRecurringHabitDayState("user-a", "habit-a", "2026-06-02", { progressPercent: 60 })
    ).rejects.toBe(error);
  });
});
