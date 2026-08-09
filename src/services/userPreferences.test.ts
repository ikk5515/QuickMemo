import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultMatrixLabels } from "../lib/matrixLabels";
import { getCachedUserPreferences, saveUserPreferences } from "./userPreferences";

const firestoreMocks = vi.hoisted(() => ({
  getDoc: vi.fn(),
  setDoc: vi.fn(),
  updateDoc: vi.fn()
}));

vi.mock("../lib/firebase", () => ({ db: { name: "test-db" } }));

vi.mock("firebase/firestore", () => ({
  doc: vi.fn((_db, collectionName: string, documentId: string) => ({ collectionName, documentId })),
  getDoc: firestoreMocks.getDoc,
  onSnapshot: vi.fn(),
  serverTimestamp: vi.fn(() => ({ __type: "serverTimestamp" })),
  setDoc: firestoreMocks.setDoc,
  updateDoc: firestoreMocks.updateDoc
}));

const uid = "user-preferences-cache-test";
const cacheKey = `quickmemo:userPreferences:${uid}`;
const storedPreferences = {
  defaultHome: "notes",
  matrixLabels: defaultMatrixLabels,
  scheduleDefaultCategory: "work",
  scheduleDefaultView: "todo",
  theme: "system"
};

describe("user preference persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    window.localStorage.setItem(cacheKey, JSON.stringify(storedPreferences));
    firestoreMocks.getDoc.mockResolvedValue({
      data: () => ({ uid, ...storedPreferences }),
      exists: () => true
    });
    firestoreMocks.updateDoc.mockResolvedValue(undefined);
    firestoreMocks.setDoc.mockResolvedValue(undefined);
  });

  it("updates the local cache only after Firestore accepts the saved category", async () => {
    await saveUserPreferences(uid, { scheduleDefaultCategory: "personal" });

    expect(firestoreMocks.updateDoc).toHaveBeenCalledOnce();
    expect(getCachedUserPreferences(uid)?.scheduleDefaultCategory).toBe("personal");
  });

  it("preserves the previous cache when Firestore rejects the saved category", async () => {
    firestoreMocks.updateDoc.mockRejectedValueOnce(new Error("permission-denied"));

    await expect(saveUserPreferences(uid, { scheduleDefaultCategory: "personal" })).rejects.toThrow("permission-denied");

    expect(getCachedUserPreferences(uid)?.scheduleDefaultCategory).toBe("work");
  });
});
