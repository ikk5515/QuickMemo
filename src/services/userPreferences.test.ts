import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultMatrixLabels } from "../lib/matrixLabels";
import {
  encryptedMatrixLabelsFormat,
  getCachedUserPreferences,
  getUserPreferences,
  saveUserPreferences,
  subscribeUserPreferences,
  type UserPreferencesCryptoContext
} from "./userPreferences";

const firestoreMocks = vi.hoisted(() => ({
  deleteField: vi.fn(() => ({ __type: "deleteField" })),
  getDoc: vi.fn(),
  onSnapshot: vi.fn(),
  runTransaction: vi.fn(),
  setDoc: vi.fn(),
  updateDoc: vi.fn()
}));

const cryptoMocks = vi.hoisted(() => ({
  decryptText: vi.fn(),
  encryptText: vi.fn(),
  generateNoteKey: vi.fn(),
  unwrapNoteKey: vi.fn(),
  wrapNoteKey: vi.fn()
}));

vi.mock("../lib/firebase", () => ({ db: { name: "test-db" } }));

vi.mock("../lib/crypto", () => cryptoMocks);

vi.mock("firebase/firestore", () => ({
  deleteField: firestoreMocks.deleteField,
  doc: vi.fn((_db, collectionName: string, documentId: string) => ({ collectionName, documentId })),
  getDoc: firestoreMocks.getDoc,
  onSnapshot: firestoreMocks.onSnapshot,
  runTransaction: firestoreMocks.runTransaction,
  serverTimestamp: vi.fn(() => ({ __type: "serverTimestamp" })),
  setDoc: firestoreMocks.setDoc,
  updateDoc: firestoreMocks.updateDoc
}));

const uid = "user-preferences-cache-test";
const cacheKey = `quickmemo:userPreferences:${uid}`;
const privateKey = { kind: "private" } as unknown as CryptoKey;
const labelsKey = { kind: "labels" } as unknown as CryptoKey;
const wrappedKey = {
  algorithm: "RSA-OAEP" as const,
  version: 1 as const,
  wrappedKey: "W".repeat(512)
};
const encryptedLabels = {
  algorithm: "AES-GCM" as const,
  cipherText: "encrypted-matrix-labels",
  iv: "1234567890123456",
  version: 1 as const
};
const cryptoContext: UserPreferencesCryptoContext = {
  privateKey,
  profile: {
    publicKeyJwk: { e: "AQAB", kty: "RSA", n: "public" },
    uid
  }
};
const customLabels = {
  todayOverdue: "오늘 처리",
  importantUrgent: "바로 처리",
  urgent: "위임 업무",
  important: "집중 업무",
  waiting: "대기 목록"
};
const storedPreferences = {
  defaultHome: "notes",
  scheduleDefaultCategory: "work",
  scheduleDefaultView: "calendar",
  theme: "system"
};

function snapshot(data: Record<string, unknown> | null) {
  return {
    data: () => data,
    exists: () => data !== null
  };
}

describe("user preference persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.localStorage.setItem(cacheKey, JSON.stringify(storedPreferences));
    firestoreMocks.getDoc.mockResolvedValue(snapshot({ uid, ...storedPreferences }));
    firestoreMocks.onSnapshot.mockReturnValue(vi.fn());
    firestoreMocks.updateDoc.mockResolvedValue(undefined);
    firestoreMocks.setDoc.mockResolvedValue(undefined);
    cryptoMocks.generateNoteKey.mockResolvedValue(labelsKey);
    cryptoMocks.encryptText.mockResolvedValue(encryptedLabels);
    cryptoMocks.wrapNoteKey.mockResolvedValue(wrappedKey);
    cryptoMocks.unwrapNoteKey.mockResolvedValue(labelsKey);
    cryptoMocks.decryptText.mockResolvedValue(JSON.stringify({ labels: customLabels, version: 1 }));
  });

  it("updates the non-sensitive local cache only after Firestore accepts a saved category", async () => {
    await saveUserPreferences(uid, { scheduleDefaultCategory: "personal" });

    expect(firestoreMocks.updateDoc).toHaveBeenCalledOnce();
    expect(getCachedUserPreferences(uid)?.scheduleDefaultCategory).toBe("personal");
    expect(JSON.parse(window.localStorage.getItem(cacheKey) ?? "{}")).not.toHaveProperty("matrixLabels");
  });

  it("preserves the previous cache when Firestore rejects a saved category", async () => {
    firestoreMocks.updateDoc.mockRejectedValueOnce(new Error("permission-denied"));

    await expect(saveUserPreferences(uid, { scheduleDefaultCategory: "personal" })).rejects.toThrow("permission-denied");

    expect(getCachedUserPreferences(uid)?.scheduleDefaultCategory).toBe("work");
  });

  it("purges legacy plaintext labels from browser storage and returns defaults until unlock", () => {
    window.localStorage.setItem(cacheKey, JSON.stringify({
      ...storedPreferences,
      matrixLabels: customLabels
    }));
    window.sessionStorage.setItem(cacheKey, JSON.stringify({ matrixLabels: customLabels }));

    expect(getCachedUserPreferences(uid)?.matrixLabels).toEqual(defaultMatrixLabels);
    const persisted = JSON.parse(window.localStorage.getItem(cacheKey) ?? "{}");
    expect(persisted).not.toHaveProperty("matrixLabels");
    expect(JSON.stringify(persisted)).not.toContain("바로 처리");
    expect(window.sessionStorage.getItem(cacheKey)).toBeNull();
  });

  it("stores custom labels only as an AES envelope with an RSA-wrapped key", async () => {
    await saveUserPreferences(uid, { matrixLabels: customLabels }, cryptoContext);

    expect(cryptoMocks.encryptText).toHaveBeenCalledWith(
      JSON.stringify({ labels: customLabels, version: 1 }),
      labelsKey
    );
    expect(cryptoMocks.wrapNoteKey).toHaveBeenCalledWith(labelsKey, cryptoContext.profile.publicKeyJwk);
    const payload = firestoreMocks.updateDoc.mock.calls[0][1];
    expect(payload).toMatchObject({
      encryptedMatrixLabels: encryptedLabels,
      matrixLabelsFormat: encryptedMatrixLabelsFormat,
      matrixLabelsWrappedKey: wrappedKey
    });
    expect(payload.matrixLabels).toEqual({ __type: "deleteField" });
    expect(JSON.stringify(payload)).not.toContain("바로 처리");
    expect(JSON.parse(window.localStorage.getItem(cacheKey) ?? "{}")).not.toHaveProperty("matrixLabels");
  });

  it("refuses to save custom labels while the profile key is locked", async () => {
    await expect(saveUserPreferences(uid, { matrixLabels: customLabels })).rejects.toThrow("암호화 키");

    expect(firestoreMocks.updateDoc).not.toHaveBeenCalled();
    expect(firestoreMocks.setDoc).not.toHaveBeenCalled();
  });

  it("rejects invalid custom labels before encryption or persistence", async () => {
    await expect(saveUserPreferences(uid, {
      matrixLabels: { ...customLabels, urgent: "" }
    }, cryptoContext)).rejects.toThrow("형식이 올바르지 않습니다");

    expect(cryptoMocks.generateNoteKey).not.toHaveBeenCalled();
    expect(firestoreMocks.updateDoc).not.toHaveBeenCalled();
    expect(firestoreMocks.setDoc).not.toHaveBeenCalled();
  });

  it("decrypts encrypted labels only with the matching unlocked account scope", async () => {
    firestoreMocks.getDoc.mockResolvedValueOnce(snapshot({
      uid,
      ...storedPreferences,
      encryptedMatrixLabels: encryptedLabels,
      matrixLabelsFormat: encryptedMatrixLabelsFormat,
      matrixLabelsWrappedKey: wrappedKey
    }));

    await expect(getUserPreferences(uid, cryptoContext)).resolves.toMatchObject({ matrixLabels: customLabels });
    expect(cryptoMocks.unwrapNoteKey).toHaveBeenCalledWith(wrappedKey, privateKey);
    expect(JSON.parse(window.localStorage.getItem(cacheKey) ?? "{}")).not.toHaveProperty("matrixLabels");
  });

  it("rejects decrypted envelopes with unexpected label fields", async () => {
    firestoreMocks.getDoc.mockResolvedValueOnce(snapshot({
      uid,
      ...storedPreferences,
      encryptedMatrixLabels: encryptedLabels,
      matrixLabelsFormat: encryptedMatrixLabelsFormat,
      matrixLabelsWrappedKey: wrappedKey
    }));
    cryptoMocks.decryptText.mockResolvedValueOnce(JSON.stringify({
      labels: { ...customLabels, unexpected: "평문" },
      version: 1
    }));

    await expect(getUserPreferences(uid, cryptoContext)).rejects.toThrow("형식이 올바르지 않습니다");
    expect(firestoreMocks.runTransaction).not.toHaveBeenCalled();
  });

  it("dual-reads and atomically migrates a legacy plaintext Firestore label", async () => {
    const legacyDocument = { uid, ...storedPreferences, matrixLabels: customLabels };
    firestoreMocks.getDoc.mockResolvedValueOnce(snapshot(legacyDocument));
    const transactionUpdate = vi.fn();
    firestoreMocks.runTransaction.mockImplementationOnce(async (_db, callback) => callback({
      get: vi.fn().mockResolvedValue(snapshot(legacyDocument)),
      update: transactionUpdate
    }));

    await expect(getUserPreferences(uid, cryptoContext)).resolves.toMatchObject({ matrixLabels: customLabels });

    const migration = transactionUpdate.mock.calls[0][1];
    expect(migration).toMatchObject({
      encryptedMatrixLabels: encryptedLabels,
      matrixLabelsFormat: encryptedMatrixLabelsFormat,
      matrixLabelsWrappedKey: wrappedKey
    });
    expect(migration.matrixLabels).toEqual({ __type: "deleteField" });
    expect(JSON.stringify(migration)).not.toContain("바로 처리");
  });

  it("keeps an existing encrypted envelope canonical while removing a stale legacy field", async () => {
    const staleLegacyLabels = { ...customLabels, urgent: "예전 명칭" };
    const mixedDocument = {
      uid,
      ...storedPreferences,
      encryptedMatrixLabels: encryptedLabels,
      matrixLabels: staleLegacyLabels,
      matrixLabelsFormat: encryptedMatrixLabelsFormat,
      matrixLabelsWrappedKey: wrappedKey
    };
    firestoreMocks.getDoc.mockResolvedValueOnce(snapshot(mixedDocument));
    const transactionUpdate = vi.fn();
    firestoreMocks.runTransaction.mockImplementationOnce(async (_db, callback) => callback({
      get: vi.fn().mockResolvedValue(snapshot(mixedDocument)),
      update: transactionUpdate
    }));

    await expect(getUserPreferences(uid, cryptoContext)).resolves.toMatchObject({ matrixLabels: customLabels });

    expect(transactionUpdate).toHaveBeenCalledWith(expect.anything(), {
      matrixLabels: { __type: "deleteField" },
      updatedAt: { __type: "serverTimestamp" }
    });
  });

  it("does not normalize or overwrite malformed legacy plaintext during migration", async () => {
    const malformedLegacyDocument = {
      uid,
      ...storedPreferences,
      matrixLabels: { ...customLabels, unexpected: "보존해야 하는 값" }
    };
    firestoreMocks.getDoc.mockResolvedValueOnce(snapshot(malformedLegacyDocument));

    await expect(getUserPreferences(uid, cryptoContext)).rejects.toThrow("자동 이전하지 않았습니다");

    expect(firestoreMocks.runTransaction).not.toHaveBeenCalled();
    expect(firestoreMocks.updateDoc).not.toHaveBeenCalled();
  });

  it("keeps non-sensitive preferences readable without exposing a legacy label while locked", async () => {
    firestoreMocks.getDoc.mockResolvedValueOnce(snapshot({
      uid,
      ...storedPreferences,
      matrixLabels: customLabels
    }));

    await expect(getUserPreferences(uid)).resolves.toMatchObject({
      matrixLabels: defaultMatrixLabels,
      scheduleDefaultCategory: "work"
    });
    expect(firestoreMocks.runTransaction).not.toHaveBeenCalled();
    expect(cryptoMocks.encryptText).not.toHaveBeenCalled();
  });

  it("clears decrypted labels immediately when the authorized listener errors", async () => {
    const callback = vi.fn();
    const onError = vi.fn();
    const encryptedDocument = {
      uid,
      ...storedPreferences,
      encryptedMatrixLabels: encryptedLabels,
      matrixLabelsFormat: encryptedMatrixLabelsFormat,
      matrixLabelsWrappedKey: wrappedKey
    };

    subscribeUserPreferences(uid, callback, onError, cryptoContext);
    const snapshotHandler = firestoreMocks.onSnapshot.mock.calls[0][1];
    const errorHandler = firestoreMocks.onSnapshot.mock.calls[0][2];

    snapshotHandler(snapshot(encryptedDocument));
    await vi.waitFor(() => expect(callback).toHaveBeenLastCalledWith(
      expect.objectContaining({ matrixLabels: customLabels })
    ));

    const listenerError = new Error("permission-denied");
    errorHandler(listenerError);

    expect(callback).toHaveBeenLastCalledWith(expect.objectContaining({ matrixLabels: defaultMatrixLabels }));
    expect(onError).toHaveBeenCalledWith(listenerError);
  });
});
