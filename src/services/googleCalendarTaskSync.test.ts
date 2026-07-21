import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  listGoogleCalendarTaskSyncReceipts,
  googleCalendarTaskRevisionTimestamp,
  markScheduleTaskGoogleCalendarSynced,
  scheduleTaskNeedsGoogleCalendarRecovery
} from "./googleCalendarTaskSync";

const firestoreMocks = vi.hoisted(() => ({
  collection: vi.fn((...parts: unknown[]) => ({ collectionParts: parts })),
  db: { __type: "firestore" },
  doc: vi.fn((...parts: unknown[]) => ({ parts })),
  getDocsFromServer: vi.fn(),
  query: vi.fn((...parts: unknown[]) => ({ queryParts: parts })),
  serverTimestamp: vi.fn(() => ({ __type: "serverTimestamp" })),
  setDoc: vi.fn(),
  where: vi.fn((...parts: unknown[]) => ({ whereParts: parts }))
}));

vi.mock("../lib/firebase", () => ({ db: firestoreMocks.db }));
vi.mock("firebase/firestore", () => ({
  collection: firestoreMocks.collection,
  doc: firestoreMocks.doc,
  getDocsFromServer: firestoreMocks.getDocsFromServer,
  query: firestoreMocks.query,
  serverTimestamp: firestoreMocks.serverTimestamp,
  setDoc: firestoreMocks.setDoc,
  where: firestoreMocks.where
}));

const generation = "g".repeat(43);
const updatedAt = { seconds: 1_753_142_400, nanoseconds: 123_000_000 };
const receipt = {
  connectionGeneration: generation,
  ownerUid: "user-a",
  syncedAt: updatedAt,
  taskId: "task-a",
  taskUpdatedAt: updatedAt
};

describe("Google Calendar task sync receipts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    firestoreMocks.setDoc.mockResolvedValue(undefined);
  });

  it("requires recovery only for post-connection tasks without an exact generation and revision receipt", () => {
    const task = { updatedAt };
    const connectedAt = "2025-07-21T23:59:59.000Z";

    expect(scheduleTaskNeedsGoogleCalendarRecovery(task, null, generation, connectedAt)).toBe(true);
    expect(scheduleTaskNeedsGoogleCalendarRecovery(task, receipt as never, generation, connectedAt)).toBe(false);
    expect(scheduleTaskNeedsGoogleCalendarRecovery(task, {
      ...receipt,
      connectionGeneration: "h".repeat(43)
    } as never, generation, connectedAt)).toBe(true);
    expect(scheduleTaskNeedsGoogleCalendarRecovery(
      task,
      null,
      generation,
      "2025-07-23T00:00:00.000Z"
    )).toBe(false);
    expect(scheduleTaskNeedsGoogleCalendarRecovery(task, null, generation, "not-a-date")).toBe(false);
  });

  it("keeps legacy task revisions stable across local-only updates", () => {
    const createdAt = { seconds: 1_753_142_300, nanoseconds: 0 };
    const localOnlyUpdatedAt = { seconds: 1_753_142_500, nanoseconds: 0 };
    const calendarUpdatedAt = { seconds: 1_753_142_450, nanoseconds: 0 };

    expect(googleCalendarTaskRevisionTimestamp({ createdAt, updatedAt: localOnlyUpdatedAt })).toEqual(createdAt);
    expect(googleCalendarTaskRevisionTimestamp({ calendarUpdatedAt, createdAt, updatedAt: localOnlyUpdatedAt }))
      .toEqual(calendarUpdatedAt);
    expect(googleCalendarTaskRevisionTimestamp({ updatedAt: localOnlyUpdatedAt })).toEqual(localOnlyUpdatedAt);
  });

  it("does not recover a legacy pre-connection task after only its local metadata changes", () => {
    const createdAt = { seconds: 1_753_142_300, nanoseconds: 0 };
    const localOnlyUpdatedAt = { seconds: 1_753_142_500, nanoseconds: 0 };

    expect(scheduleTaskNeedsGoogleCalendarRecovery(
      { createdAt, updatedAt: localOnlyUpdatedAt },
      null,
      generation,
      "2025-07-22T00:00:00.000Z"
    )).toBe(false);
  });

  it("writes only owner, generation, and revision metadata", async () => {
    await markScheduleTaskGoogleCalendarSynced("task-a", "user-a", generation, updatedAt);

    expect(firestoreMocks.setDoc).toHaveBeenCalledWith(
      { parts: [firestoreMocks.db, "googleCalendarTaskSyncReceipts", "task-a"] },
      {
        ownerUid: "user-a",
        taskId: "task-a",
        connectionGeneration: generation,
        taskUpdatedAt: updatedAt,
        syncedAt: { __type: "serverTimestamp" }
      }
    );
  });

  it("lists the owner's strict receipts through an owner-filtered query", async () => {
    firestoreMocks.getDocsFromServer.mockResolvedValue({
      docs: [{ id: "task-a", data: () => receipt }]
    });

    await expect(listGoogleCalendarTaskSyncReceipts("user-a")).resolves.toEqual([receipt]);
    expect(firestoreMocks.getDocsFromServer).toHaveBeenCalledWith({
      queryParts: [
        { collectionParts: [firestoreMocks.db, "googleCalendarTaskSyncReceipts"] },
        { whereParts: ["ownerUid", "==", "user-a"] }
      ]
    });
  });

  it("rejects malformed receipt identifiers before writing", async () => {
    await expect(markScheduleTaskGoogleCalendarSynced(
      "task/a",
      "user-a",
      generation,
      updatedAt
    )).rejects.toThrow(/형식/);
    expect(firestoreMocks.setDoc).not.toHaveBeenCalled();
  });
});
