import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteScheduleTask } from "./scheduleTasks";

const firestoreMocks = vi.hoisted(() => {
  const transaction = {
    delete: vi.fn(),
    get: vi.fn()
  };

  return {
    addDoc: vi.fn(),
    collection: vi.fn(),
    db: { __type: "firestore" },
    doc: vi.fn((...parts: unknown[]) => ({ parts })),
    getDocFromServer: vi.fn(),
    onSnapshot: vi.fn(),
    query: vi.fn(),
    runTransaction: vi.fn(),
    serverTimestamp: vi.fn(),
    Timestamp: class Timestamp {},
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

describe("schedule task deletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    firestoreMocks.runTransaction.mockImplementation(async (_db, updateFunction) =>
      updateFunction(firestoreMocks.transaction)
    );
  });

  it("deletes the durable Google sync receipt in the same transaction", async () => {
    firestoreMocks.transaction.get.mockResolvedValue({ exists: () => true });

    await deleteScheduleTask("task-a");

    expect(firestoreMocks.transaction.get).toHaveBeenCalledWith({
      parts: [firestoreMocks.db, "googleCalendarTaskSyncReceipts", "task-a"]
    });
    expect(firestoreMocks.transaction.delete).toHaveBeenNthCalledWith(1, {
      parts: [firestoreMocks.db, "scheduleTasks", "task-a"]
    });
    expect(firestoreMocks.transaction.delete).toHaveBeenNthCalledWith(2, {
      parts: [firestoreMocks.db, "googleCalendarTaskSyncReceipts", "task-a"]
    });
  });

  it("deletes only the task when it has no sync receipt", async () => {
    firestoreMocks.transaction.get.mockResolvedValue({ exists: () => false });

    await deleteScheduleTask("task-a");

    expect(firestoreMocks.transaction.delete).toHaveBeenCalledOnce();
    expect(firestoreMocks.transaction.delete).toHaveBeenCalledWith({
      parts: [firestoreMocks.db, "scheduleTasks", "task-a"]
    });
  });
});
