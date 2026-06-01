import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateRecurringHabitDayState } from "./recurringHabits";

const firestoreMocks = vi.hoisted(() => {
  const timestamp = { __type: "serverTimestamp" };

  return {
    collection: vi.fn(),
    db: { __type: "firestore" },
    deleteDoc: vi.fn(),
    doc: vi.fn((...parts: unknown[]) => ({ parts })),
    getDocs: vi.fn(),
    onSnapshot: vi.fn(),
    query: vi.fn(),
    serverTimestamp: vi.fn(() => timestamp),
    setDoc: vi.fn(),
    timestamp,
    updateDoc: vi.fn(),
    where: vi.fn(),
    writeBatch: vi.fn()
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
  onSnapshot: firestoreMocks.onSnapshot,
  query: firestoreMocks.query,
  serverTimestamp: firestoreMocks.serverTimestamp,
  setDoc: firestoreMocks.setDoc,
  updateDoc: firestoreMocks.updateDoc,
  where: firestoreMocks.where,
  writeBatch: firestoreMocks.writeBatch
}));

describe("updateRecurringHabitDayState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates an existing recurring check-in without a preflight read", async () => {
    firestoreMocks.updateDoc.mockResolvedValueOnce(undefined);

    await updateRecurringHabitDayState("user-a", "habit-a", "2026-06-02", {
      completed: false,
      progressPercent: 40
    });

    expect(firestoreMocks.doc).toHaveBeenCalledWith(
      firestoreMocks.db,
      "recurringHabitCheckIns",
      "habit-a_2026-06-02"
    );
    expect(firestoreMocks.updateDoc).toHaveBeenCalledWith(
      { parts: [firestoreMocks.db, "recurringHabitCheckIns", "habit-a_2026-06-02"] },
      {
        checkedAt: null,
        completed: false,
        progressPercent: 40,
        updatedAt: firestoreMocks.timestamp
      }
    );
    expect(firestoreMocks.setDoc).not.toHaveBeenCalled();
  });

  it("creates the recurring check-in when the first update is denied for a missing document", async () => {
    firestoreMocks.updateDoc.mockRejectedValueOnce({ code: "permission-denied" });
    firestoreMocks.setDoc.mockResolvedValueOnce(undefined);

    await updateRecurringHabitDayState("user-a", "habit-a", "2026-06-02", {
      progressPercent: 60
    });

    expect(firestoreMocks.setDoc).toHaveBeenCalledWith(
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

  it("does not hide unrelated Firestore errors", async () => {
    const error = { code: "unavailable" };
    firestoreMocks.updateDoc.mockRejectedValueOnce(error);

    await expect(
      updateRecurringHabitDayState("user-a", "habit-a", "2026-06-02", {
        progressPercent: 60
      })
    ).rejects.toBe(error);
    expect(firestoreMocks.setDoc).not.toHaveBeenCalled();
  });
});
