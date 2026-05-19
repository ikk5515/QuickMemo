import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

interface FirestoreFieldOverride {
  collectionGroup: string;
  fieldPath: string;
  indexes?: unknown[];
  ttl?: boolean;
}

interface FirestoreIndexesConfig {
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
  it("keeps server-side TTL enabled for temporary public shares and copied attachments", () => {
    expect(fieldOverride("publicNoteShares", "expiresAt")).toMatchObject({
      ttl: true,
      indexes: []
    });
    expect(fieldOverride("attachments", "expiresAt")).toMatchObject({
      ttl: true,
      indexes: []
    });
  });
});
