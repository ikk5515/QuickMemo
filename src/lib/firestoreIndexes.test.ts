import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

interface FirestoreFieldOverride {
  collectionGroup: string;
  fieldPath: string;
  indexes?: Array<{
    arrayConfig?: string;
    order?: string;
    queryScope?: string;
  }>;
  ttl?: boolean;
}

interface FirestoreIndexesConfig {
  indexes: Array<{
    collectionGroup: string;
    fields: Array<{ arrayConfig?: string; fieldPath: string; order?: string }>;
    queryScope: string;
  }>;
  fieldOverrides: FirestoreFieldOverride[];
}

const firestoreIndexes = JSON.parse(
  readFileSync(join(process.cwd(), "firestore.indexes.json"), "utf8")
) as FirestoreIndexesConfig;

function fieldOverride(collectionGroup: string, fieldPath: string) {
  return firestoreIndexes.fieldOverrides.find(
    (override) => override.collectionGroup === collectionGroup && override.fieldPath === fieldPath
  );
}

describe("Firestore index retention policies", () => {
  it("keeps cleanup indexes without billing-only TTL metadata deletion", () => {
    expect(fieldOverride("publicNoteShares", "expiresAt")).toMatchObject({
      indexes: [{ order: "ASCENDING", queryScope: "COLLECTION" }]
    });
    expect(fieldOverride("publicNoteShares", "expiresAt")?.ttl).toBeUndefined();
    expect(fieldOverride("attachments", "expiresAt")).toMatchObject({
      indexes: [{ order: "ASCENDING", queryScope: "COLLECTION_GROUP" }]
    });
    expect(fieldOverride("attachments", "expiresAt")?.ttl).toBeUndefined();
    expect(fieldOverride("attachments", "reservationExpiresAt")).toMatchObject({
      indexes: [{ order: "ASCENDING", queryScope: "COLLECTION_GROUP" }]
    });
    expect(fieldOverride("attachments", "deletionStartedAt")).toMatchObject({
      indexes: [{ order: "ASCENDING", queryScope: "COLLECTION_GROUP" }]
    });
    expect(fieldOverride("publicShareCleanupQueue", "expiresAt")).toBeUndefined();
  });

  it("keeps collection-group indexes used by managed user deletion cleanup", () => {
    expect(fieldOverride("attachments", "uploadedBy")).toMatchObject({
      indexes: [{ order: "ASCENDING", queryScope: "COLLECTION_GROUP" }]
    });
    expect(fieldOverride("history", "actorUid")).toMatchObject({
      indexes: [{ order: "ASCENDING", queryScope: "COLLECTION_GROUP" }]
    });
    expect(fieldOverride("history", "readerUids")).toMatchObject({
      indexes: [{ arrayConfig: "CONTAINS", queryScope: "COLLECTION_GROUP" }]
    });
    expect(fieldOverride("users", "uid")).toMatchObject({
      indexes: [{ order: "ASCENDING", queryScope: "COLLECTION_GROUP" }]
    });
  });

  it("indexes Google Calendar OAuth state expiry for no-billing cron cleanup", () => {
    expect(fieldOverride("googleCalendarOAuthStates", "expiresAt")).toEqual({
      collectionGroup: "googleCalendarOAuthStates",
      fieldPath: "expiresAt",
      indexes: [
        {
          order: "ASCENDING",
          queryScope: "COLLECTION"
        }
      ]
    });
  });

  it("keeps the bounded legacy Blob reservation cleanup query indexed", () => {
    expect(
      firestoreIndexes.indexes.some(
        (index) =>
          index.collectionGroup === "attachments"
          && index.queryScope === "COLLECTION_GROUP"
          && index.fields.some((field) => field.fieldPath === "storageProvider" && field.order === "ASCENDING")
          && index.fields.some((field) => field.fieldPath === "isReady" && field.order === "ASCENDING")
          && index.fields.some((field) => field.fieldPath === "createdAt" && field.order === "ASCENDING")
      )
    ).toBe(true);
  });

  it("keeps participant note history reads ordered and server-bounded", () => {
    expect(
      firestoreIndexes.indexes.some(
        (index) =>
          index.collectionGroup === "history"
          && index.queryScope === "COLLECTION"
          && index.fields.some((field) => field.fieldPath === "readerUids" && field.arrayConfig === "CONTAINS")
          && index.fields.some((field) => field.fieldPath === "createdAt" && field.order === "DESCENDING")
      )
    ).toBe(true);
  });

  it("keeps schedule task query indexes and disables encrypted payload indexing", () => {
    expect(
      firestoreIndexes.indexes.some(
        (index) =>
          index.collectionGroup === "scheduleTasks"
          && index.fields.some((field) => field.fieldPath === "ownerUid")
          && index.fields.some((field) => field.fieldPath === "updatedAt" && field.order === "DESCENDING")
      )
    ).toBe(true);
    expect(
      firestoreIndexes.indexes.some(
        (index) =>
          index.collectionGroup === "scheduleTasks"
          && index.fields.some((field) => field.fieldPath === "ownerUid")
          && index.fields.some((field) => field.fieldPath === "startDate")
          && index.fields.some((field) => field.fieldPath === "startTimeMinutes")
      )
    ).toBe(true);
    expect(fieldOverride("scheduleTasks", "encryptedTitle")).toMatchObject({ indexes: [] });
    expect(fieldOverride("scheduleTasks", "encryptedDetails")).toMatchObject({ indexes: [] });
    expect(fieldOverride("scheduleTasks", "wrappedKeys")).toMatchObject({ indexes: [] });
    expect(fieldOverride("recurringHabits", "encryptedTitle")).toMatchObject({ indexes: [] });
    expect(fieldOverride("recurringHabits", "encryptedDetails")).toMatchObject({ indexes: [] });
    expect(fieldOverride("recurringHabits", "wrappedKeys")).toMatchObject({ indexes: [] });
  });

  it("indexes bounded recurring check-in queries without indexing checklist arrays", () => {
    for (const fieldPath of ["date", "habitId"]) {
      expect(
        firestoreIndexes.indexes.some(
          (index) =>
            index.collectionGroup === "recurringHabitCheckIns"
            && index.fields.some((field) => field.fieldPath === "ownerUid")
            && index.fields.some((field) => field.fieldPath === fieldPath)
        )
      ).toBe(true);
    }

    expect(fieldOverride("recurringHabitCheckIns", "checkedItemIds")).toMatchObject({ indexes: [] });
  });
});
