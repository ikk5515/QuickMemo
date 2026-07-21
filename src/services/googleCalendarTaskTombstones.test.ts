import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GoogleCalendarTaskTombstoneError,
  beginGoogleCalendarTaskDeletion,
  cancelGoogleCalendarTaskDeletion,
  getGoogleCalendarTaskTombstone,
  listGoogleCalendarTaskTombstones,
  validateGoogleCalendarTaskTombstone
} from "./googleCalendarTaskTombstones";

const firestoreMocks = vi.hoisted(() => {
  class Timestamp {
    nanoseconds: number;
    seconds: number;

    constructor(seconds: number, nanoseconds: number) {
      this.seconds = seconds;
      this.nanoseconds = nanoseconds;
    }

    static fromMillis(milliseconds: number) {
      const seconds = Math.floor(milliseconds / 1000);
      return new Timestamp(seconds, Math.floor((milliseconds - seconds * 1000) * 1_000_000));
    }
  }
  const timestamp = { __type: "serverTimestamp" };
  const transaction = {
    delete: vi.fn(),
    get: vi.fn(),
    set: vi.fn()
  };

  return {
    db: { __type: "firestore" },
    collection: vi.fn((...parts: unknown[]) => ({ collectionParts: parts })),
    doc: vi.fn((...parts: unknown[]) => ({ parts })),
    getDocFromServer: vi.fn(),
    getDocsFromServer: vi.fn(),
    query: vi.fn((...parts: unknown[]) => ({ queryParts: parts })),
    runTransaction: vi.fn(),
    serverTimestamp: vi.fn(() => timestamp),
    Timestamp,
    timestamp,
    transaction,
    where: vi.fn((...parts: unknown[]) => ({ whereParts: parts }))
  };
});

vi.mock("../lib/firebase", () => ({
  db: firestoreMocks.db
}));

vi.mock("firebase/firestore", () => ({
  collection: firestoreMocks.collection,
  doc: firestoreMocks.doc,
  getDocFromServer: firestoreMocks.getDocFromServer,
  getDocsFromServer: firestoreMocks.getDocsFromServer,
  query: firestoreMocks.query,
  runTransaction: firestoreMocks.runTransaction,
  serverTimestamp: firestoreMocks.serverTimestamp,
  Timestamp: firestoreMocks.Timestamp,
  where: firestoreMocks.where
}));

function snapshot(exists: boolean, data: Record<string, unknown> = {}) {
  return {
    data: () => data,
    exists: () => exists
  };
}

const revision = { seconds: 1_753_142_400, nanoseconds: 123_000_000 };
const attemptId = "ab".repeat(16);
const now = 1_753_142_400_000;
const leaseExpiresAt = firestoreMocks.Timestamp.fromMillis(now + 4 * 60 * 1000);
const connectionGeneration = "g".repeat(43);

describe("Google Calendar task deletion tombstones", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(now);
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => bytes.fill(0xab)
    });
    firestoreMocks.runTransaction.mockImplementation(async (_db, updateFunction) =>
      updateFunction(firestoreMocks.transaction)
    );
    firestoreMocks.transaction.get
      .mockResolvedValueOnce(snapshot(true, { ownerUid: "user-a", updatedAt: revision }))
      .mockResolvedValueOnce(snapshot(false));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates one task-id tombstone after verifying owner and exact updatedAt revision", async () => {
    await expect(beginGoogleCalendarTaskDeletion(
      "user-a",
      "task-a",
      revision,
      connectionGeneration
    )).resolves.toEqual({
      ownerUid: "user-a",
      taskId: "task-a",
      deletionAttemptId: attemptId,
      connectionGeneration,
      createdAt: null,
      leaseExpiresAt
    });

    expect(firestoreMocks.transaction.get).toHaveBeenNthCalledWith(
      1,
      { parts: [firestoreMocks.db, "scheduleTasks", "task-a"] }
    );
    expect(firestoreMocks.transaction.get).toHaveBeenNthCalledWith(
      2,
      { parts: [firestoreMocks.db, "googleCalendarTaskTombstones", "task-a"] }
    );
    expect(firestoreMocks.transaction.set).toHaveBeenCalledWith(
      { parts: [firestoreMocks.db, "googleCalendarTaskTombstones", "task-a"] },
      {
        ownerUid: "user-a",
        taskId: "task-a",
        deletionAttemptId: attemptId,
        connectionGeneration,
        createdAt: firestoreMocks.timestamp,
        leaseExpiresAt
      }
    );
  });

  it("anchors the deletion lease to authenticated server time instead of a skewed browser clock", async () => {
    const serverNow = now + 10 * 60 * 1000;
    const serverTime = new Date(serverNow).toISOString();
    const serverLeaseExpiresAt = firestoreMocks.Timestamp.fromMillis(serverNow + 4 * 60 * 1000);

    await expect(beginGoogleCalendarTaskDeletion(
      "user-a",
      "task-a",
      revision,
      connectionGeneration,
      serverTime
    )).resolves.toMatchObject({ leaseExpiresAt: serverLeaseExpiresAt });
    expect(firestoreMocks.transaction.set).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ leaseExpiresAt: serverLeaseExpiresAt })
    );
  });

  it("blocks a concurrent deletion while the existing lease is active", async () => {
    firestoreMocks.transaction.get
      .mockReset()
      .mockResolvedValueOnce(snapshot(true, { ownerUid: "user-a", updatedAt: revision }))
      .mockResolvedValueOnce(snapshot(true, {
        ownerUid: "user-a",
        taskId: "task-a",
        deletionAttemptId: "cd".repeat(16),
        createdAt: revision,
        leaseExpiresAt
      }));

    await expect(beginGoogleCalendarTaskDeletion("user-a", "task-a", revision)).rejects.toMatchObject({
      code: "deletion_in_progress"
    });
    expect(firestoreMocks.transaction.set).not.toHaveBeenCalled();
  });

  it("takes over an expired deletion lease with a new attempt id", async () => {
    firestoreMocks.transaction.get
      .mockReset()
      .mockResolvedValueOnce(snapshot(true, { ownerUid: "user-a", updatedAt: revision }))
      .mockResolvedValueOnce(snapshot(true, {
        ownerUid: "user-a",
        taskId: "task-a",
        deletionAttemptId: "cd".repeat(16),
        createdAt: revision,
        leaseExpiresAt: firestoreMocks.Timestamp.fromMillis(now - 1)
      }));

    await expect(beginGoogleCalendarTaskDeletion("user-a", "task-a", revision)).resolves.toMatchObject({
      ownerUid: "user-a",
      taskId: "task-a",
      deletionAttemptId: attemptId,
      connectionGeneration: null,
      leaseExpiresAt
    });
    expect(firestoreMocks.transaction.set).toHaveBeenCalledOnce();
  });

  it("takes over a lease expired by server time even when the browser clock is far behind", async () => {
    const serverNow = now + 60 * 60 * 1000;
    const serverTime = new Date(serverNow).toISOString();
    const serverLeaseExpiresAt = firestoreMocks.Timestamp.fromMillis(serverNow + 4 * 60 * 1000);

    firestoreMocks.transaction.get
      .mockReset()
      .mockResolvedValueOnce(snapshot(true, { ownerUid: "user-a", updatedAt: revision }))
      .mockResolvedValueOnce(snapshot(true, {
        ownerUid: "user-a",
        taskId: "task-a",
        deletionAttemptId: "cd".repeat(16),
        createdAt: revision,
        leaseExpiresAt: firestoreMocks.Timestamp.fromMillis(serverNow - 1)
      }));

    await expect(beginGoogleCalendarTaskDeletion(
      "user-a",
      "task-a",
      revision,
      null,
      serverTime
    )).resolves.toMatchObject({
      deletionAttemptId: attemptId,
      leaseExpiresAt: serverLeaseExpiresAt
    });
    expect(firestoreMocks.transaction.set).toHaveBeenCalledOnce();
  });

  it("blocks an active lease by server time even when the browser clock is far ahead", async () => {
    const serverNow = now;
    const browserNow = serverNow + 60 * 60 * 1000;
    const serverTime = new Date(serverNow).toISOString();

    vi.mocked(Date.now).mockReturnValue(browserNow);
    firestoreMocks.transaction.get
      .mockReset()
      .mockResolvedValueOnce(snapshot(true, { ownerUid: "user-a", updatedAt: revision }))
      .mockResolvedValueOnce(snapshot(true, {
        ownerUid: "user-a",
        taskId: "task-a",
        deletionAttemptId: "cd".repeat(16),
        createdAt: revision,
        leaseExpiresAt: firestoreMocks.Timestamp.fromMillis(serverNow + 1)
      }));

    await expect(beginGoogleCalendarTaskDeletion(
      "user-a",
      "task-a",
      revision,
      null,
      serverTime
    )).rejects.toMatchObject({ code: "deletion_in_progress" });
    expect(firestoreMocks.transaction.set).not.toHaveBeenCalled();
  });

  it("rejects missing, foreign-owned, or concurrently revised schedule tasks before writing", async () => {
    firestoreMocks.transaction.get.mockReset().mockResolvedValueOnce(snapshot(false)).mockResolvedValueOnce(snapshot(false));
    await expect(beginGoogleCalendarTaskDeletion("user-a", "task-a", revision)).rejects.toMatchObject({
      code: "schedule_task_not_found"
    });

    firestoreMocks.transaction.get.mockReset()
      .mockResolvedValueOnce(snapshot(true, { ownerUid: "user-b", updatedAt: revision }))
      .mockResolvedValueOnce(snapshot(false));
    await expect(beginGoogleCalendarTaskDeletion("user-a", "task-a", revision)).rejects.toMatchObject({
      code: "schedule_task_owner_mismatch"
    });

    firestoreMocks.transaction.get.mockReset()
      .mockResolvedValueOnce(snapshot(true, {
        ownerUid: "user-a",
        updatedAt: { ...revision, nanoseconds: revision.nanoseconds + 1 }
      }))
      .mockResolvedValueOnce(snapshot(false));
    await expect(beginGoogleCalendarTaskDeletion("user-a", "task-a", revision)).rejects.toMatchObject({
      code: "schedule_task_revision_changed"
    });
    expect(firestoreMocks.transaction.set).not.toHaveBeenCalled();
  });

  it("fails closed for a foreign-owned or malformed existing tombstone", async () => {
    firestoreMocks.transaction.get.mockReset()
      .mockResolvedValueOnce(snapshot(true, { ownerUid: "user-a", updatedAt: revision }))
      .mockResolvedValueOnce(snapshot(true, {
        ownerUid: "user-b",
        taskId: "task-a",
        deletionAttemptId: "cd".repeat(16),
        createdAt: revision,
        leaseExpiresAt
      }));
    await expect(beginGoogleCalendarTaskDeletion("user-a", "task-a", revision)).rejects.toMatchObject({
      code: "tombstone_owner_mismatch"
    });

    firestoreMocks.transaction.get.mockReset()
      .mockResolvedValueOnce(snapshot(true, { ownerUid: "user-a", updatedAt: revision }))
      .mockResolvedValueOnce(snapshot(true, {
        ownerUid: "user-a",
        taskId: "task-a",
        deletionAttemptId: "not-valid"
      }));
    await expect(beginGoogleCalendarTaskDeletion("user-a", "task-a", revision)).rejects.toMatchObject({
      code: "invalid_tombstone"
    });
  });

  it("cancels only the matching deletion attempt inside a transaction", async () => {
    firestoreMocks.transaction.get.mockReset().mockResolvedValue(snapshot(true, {
      ownerUid: "user-a",
      taskId: "task-a",
      deletionAttemptId: attemptId,
      createdAt: revision,
      leaseExpiresAt
    }));

    await expect(cancelGoogleCalendarTaskDeletion("user-a", "task-a", attemptId)).resolves.toBe(true);
    expect(firestoreMocks.transaction.delete).toHaveBeenCalledWith({
      parts: [firestoreMocks.db, "googleCalendarTaskTombstones", "task-a"]
    });

    vi.clearAllMocks();
    firestoreMocks.runTransaction.mockImplementation(async (_db, updateFunction) =>
      updateFunction(firestoreMocks.transaction)
    );
    firestoreMocks.transaction.get.mockResolvedValue(snapshot(true, {
      ownerUid: "user-a",
      taskId: "task-a",
      deletionAttemptId: attemptId,
      createdAt: revision,
      leaseExpiresAt
    }));
    await expect(cancelGoogleCalendarTaskDeletion("user-a", "task-a", "cd".repeat(16))).resolves.toBe(false);
    expect(firestoreMocks.transaction.delete).not.toHaveBeenCalled();

    firestoreMocks.transaction.get.mockResolvedValue(snapshot(false));
    await expect(cancelGoogleCalendarTaskDeletion("user-a", "task-a", "cd".repeat(16))).resolves.toBe(false);
  });

  it("reads authoritative server state and validates the active attempt", async () => {
    firestoreMocks.getDocFromServer.mockResolvedValue(snapshot(true, {
      ownerUid: "user-a",
      taskId: "task-a",
      deletionAttemptId: attemptId,
      createdAt: revision,
      leaseExpiresAt
    }));

    await expect(getGoogleCalendarTaskTombstone("user-a", "task-a")).resolves.toEqual({
      ownerUid: "user-a",
      taskId: "task-a",
      deletionAttemptId: attemptId,
      connectionGeneration: null,
      createdAt: revision,
      leaseExpiresAt
    });
    await expect(validateGoogleCalendarTaskTombstone("user-a", "task-a", attemptId)).resolves.toBe(true);
    await expect(validateGoogleCalendarTaskTombstone("user-a", "task-a", "cd".repeat(16))).resolves.toBe(false);
    expect(firestoreMocks.getDocFromServer).toHaveBeenCalledWith({
      parts: [firestoreMocks.db, "googleCalendarTaskTombstones", "task-a"]
    });

    firestoreMocks.getDocFromServer.mockResolvedValue(snapshot(false));
    await expect(getGoogleCalendarTaskTombstone("user-a", "task-a")).resolves.toBeNull();
  });

  it("lists only the owner's tombstones through the Rules-compatible owner query", async () => {
    firestoreMocks.getDocsFromServer.mockResolvedValue({
      docs: [{
        id: "task-a",
        data: () => ({
          ownerUid: "user-a",
          taskId: "task-a",
          deletionAttemptId: attemptId,
          connectionGeneration,
          createdAt: revision,
          leaseExpiresAt
        })
      }]
    });

    await expect(listGoogleCalendarTaskTombstones("user-a")).resolves.toEqual([{
      ownerUid: "user-a",
      taskId: "task-a",
      deletionAttemptId: attemptId,
      connectionGeneration,
      createdAt: revision,
      leaseExpiresAt
    }]);
    expect(firestoreMocks.getDocsFromServer).toHaveBeenCalledWith({
      queryParts: [
        { collectionParts: [firestoreMocks.db, "googleCalendarTaskTombstones"] },
        { whereParts: ["ownerUid", "==", "user-a"] }
      ]
    });
  });

  it("rejects malformed identifiers and revisions before touching Firestore", async () => {
    await expect(beginGoogleCalendarTaskDeletion("user/a", "task-a", revision)).rejects.toBeInstanceOf(
      GoogleCalendarTaskTombstoneError
    );
    await expect(beginGoogleCalendarTaskDeletion("user-a", "task-a", {
      seconds: revision.seconds,
      nanoseconds: 1_000_000_000
    })).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(cancelGoogleCalendarTaskDeletion("user-a", "task-a", "short")).rejects.toMatchObject({
      code: "invalid_argument"
    });
    await expect(beginGoogleCalendarTaskDeletion(
      "user-a",
      "task-a",
      revision,
      "short"
    )).rejects.toMatchObject({ code: "invalid_argument" });
    expect(firestoreMocks.runTransaction).not.toHaveBeenCalled();
  });
});
