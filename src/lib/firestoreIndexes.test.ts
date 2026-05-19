import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

interface FirestoreFieldOverride {
  collectionGroup: string;
  fieldPath: string;
  indexes?: Array<{
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
  it("keeps no-billing server cleanup indexes for temporary public shares and copied attachments", () => {
    expect(fieldOverride("publicNoteShares", "expiresAt")).toMatchObject({
      indexes: [{ order: "ASCENDING", queryScope: "COLLECTION" }]
    });
    expect(fieldOverride("attachments", "expiresAt")).toMatchObject({
      indexes: [{ order: "ASCENDING", queryScope: "COLLECTION_GROUP" }]
    });
    expect(fieldOverride("publicNoteShares", "expiresAt")?.ttl).toBeUndefined();
    expect(fieldOverride("attachments", "expiresAt")?.ttl).toBeUndefined();
    expect(fieldOverride("publicShareCleanupQueue", "expiresAt")).toBeUndefined();
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
  });
});
