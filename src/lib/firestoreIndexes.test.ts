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
    fields: Array<{ fieldPath: string; order?: string }>;
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
  it("keeps TTL safety nets and cleanup indexes for temporary public shares and copied attachments", () => {
    expect(fieldOverride("publicNoteShares", "expiresAt")).toMatchObject({
      ttl: true,
      indexes: [{ order: "ASCENDING", queryScope: "COLLECTION" }]
    });
    expect(fieldOverride("attachments", "expiresAt")).toMatchObject({
      ttl: true,
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
});
