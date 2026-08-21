import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  VaultWorkspaceRevisionConflictError,
  assertJsonSafeWorkspaceState,
  loadVaultWorkspace,
  loadVaultWorkspaceRecord,
  saveVaultWorkspace
} from "./vaultWorkspace";

const firestoreMocks = vi.hoisted(() => {
  const transaction = {
    get: vi.fn(),
    set: vi.fn(),
    update: vi.fn()
  };
  return {
    db: { __type: "firestore" },
    doc: vi.fn((...parts: unknown[]) => ({ id: String(parts.at(-1)), parts })),
    getDoc: vi.fn(),
    runTransaction: vi.fn(),
    serverTimestamp: vi.fn(() => ({ __type: "serverTimestamp" })),
    transaction
  };
});

const cryptoMocks = vi.hoisted(() => ({
  decryptText: vi.fn(),
  encryptText: vi.fn(),
  generateNoteKey: vi.fn(),
  unwrapNoteKey: vi.fn(),
  wrapNoteKey: vi.fn()
}));

vi.mock("../lib/firebase", () => ({ db: firestoreMocks.db }));
vi.mock("firebase/firestore", () => ({
  doc: firestoreMocks.doc,
  getDoc: firestoreMocks.getDoc,
  runTransaction: firestoreMocks.runTransaction,
  serverTimestamp: firestoreMocks.serverTimestamp
}));
vi.mock("../lib/crypto", () => ({
  decryptText: cryptoMocks.decryptText,
  encryptText: cryptoMocks.encryptText,
  generateNoteKey: cryptoMocks.generateNoteKey,
  unwrapNoteKey: cryptoMocks.unwrapNoteKey,
  wrapNoteKey: cryptoMocks.wrapNoteKey
}));

const privateKey = { __type: "private-key" } as unknown as CryptoKey;
const workspaceKey = { __type: "workspace-key" } as unknown as CryptoKey;
const profile = { uid: "user-a", publicKeyJwk: { kty: "RSA", n: "public", e: "AQAB" } };
const encryptedState = {
  version: 1 as const,
  algorithm: "AES-GCM" as const,
  cipherText: "encrypted-state",
  iv: "state-iv"
};
const wrappedKey = {
  version: 1 as const,
  algorithm: "RSA-OAEP" as const,
  wrappedKey: "wrapped-workspace-key"
};

function existingSnapshot(revision = 3, ownerUid = "user-a") {
  return {
    exists: () => true,
    data: () => ({ ownerUid, encryptedState, wrappedKey, revision })
  };
}

describe("vault workspace encrypted persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    firestoreMocks.runTransaction.mockImplementation(async (
      _db: unknown,
      operation: (transaction: typeof firestoreMocks.transaction) => unknown
    ) => operation(firestoreMocks.transaction));
    cryptoMocks.generateNoteKey.mockResolvedValue(workspaceKey);
    cryptoMocks.unwrapNoteKey.mockResolvedValue(workspaceKey);
    cryptoMocks.wrapNoteKey.mockResolvedValue(wrappedKey);
    cryptoMocks.encryptText.mockResolvedValue(encryptedState);
    cryptoMocks.decryptText.mockResolvedValue('{"graph":{"zoom":1.25},"tabs":["note-a"]}');
  });

  it("returns null without invoking crypto when the owner has no workspace document", async () => {
    firestoreMocks.getDoc.mockResolvedValue({ exists: () => false });

    await expect(loadVaultWorkspace("user-a", privateKey)).resolves.toBeNull();
    expect(firestoreMocks.doc).toHaveBeenCalledWith(firestoreMocks.db, "vaultWorkspaces", "user-a");
    expect(cryptoMocks.unwrapNoteKey).not.toHaveBeenCalled();
    expect(cryptoMocks.decryptText).not.toHaveBeenCalled();
  });

  it("unwraps and decrypts an owned document and exposes revision only through the record API", async () => {
    firestoreMocks.getDoc.mockResolvedValue(existingSnapshot(3));

    await expect(loadVaultWorkspaceRecord("user-a", privateKey)).resolves.toEqual({
      state: { graph: { zoom: 1.25 }, tabs: ["note-a"] },
      revision: 3
    });
    expect(cryptoMocks.unwrapNoteKey).toHaveBeenCalledWith(wrappedKey, privateKey);
    expect(cryptoMocks.decryptText).toHaveBeenCalledWith(encryptedState, workspaceKey);

    firestoreMocks.getDoc.mockResolvedValue(existingSnapshot(3));
    await expect(loadVaultWorkspace("user-a", privateKey)).resolves.toEqual({
      graph: { zoom: 1.25 },
      tabs: ["note-a"]
    });
  });

  it("fails closed before decryption when the stored owner does not match", async () => {
    firestoreMocks.getDoc.mockResolvedValue(existingSnapshot(3, "user-b"));

    await expect(loadVaultWorkspace("user-a", privateKey)).rejects.toThrow(
      "저장된 워크스페이스 암호화 문서를 확인할 수 없습니다."
    );
    expect(cryptoMocks.unwrapNoteKey).not.toHaveBeenCalled();
  });

  it("creates revision one with a fresh AES key wrapped by the profile public key", async () => {
    firestoreMocks.transaction.get.mockResolvedValue({ exists: () => false });
    const state = { graph: { zoom: 2 }, panels: ["backlinks"] };

    await expect(saveVaultWorkspace(profile, privateKey, state)).resolves.toEqual({ revision: 1 });

    expect(cryptoMocks.generateNoteKey).toHaveBeenCalledOnce();
    expect(cryptoMocks.encryptText).toHaveBeenCalledWith(JSON.stringify(state), workspaceKey);
    expect(cryptoMocks.wrapNoteKey).toHaveBeenCalledWith(workspaceKey, profile.publicKeyJwk);
    expect(firestoreMocks.transaction.set).toHaveBeenCalledWith(
      {
        id: "user-a",
        parts: [firestoreMocks.db, "vaultWorkspaces", "user-a"]
      },
      {
        ownerUid: "user-a",
        encryptedState,
        wrappedKey,
        revision: 1,
        createdAt: { __type: "serverTimestamp" },
        updatedAt: { __type: "serverTimestamp" }
      }
    );
    expect(firestoreMocks.transaction.update).not.toHaveBeenCalled();
  });

  it("updates only encrypted state and revision after an exact optimistic-concurrency match", async () => {
    firestoreMocks.transaction.get.mockResolvedValue(existingSnapshot(3));
    const state = { graph: { zoom: 3 } };

    await expect(saveVaultWorkspace(profile, privateKey, state, 3)).resolves.toEqual({ revision: 4 });

    expect(cryptoMocks.generateNoteKey).not.toHaveBeenCalled();
    expect(cryptoMocks.wrapNoteKey).not.toHaveBeenCalled();
    expect(cryptoMocks.unwrapNoteKey).toHaveBeenCalledWith(wrappedKey, privateKey);
    expect(cryptoMocks.encryptText).toHaveBeenCalledWith(JSON.stringify(state), workspaceKey);
    expect(firestoreMocks.transaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: "user-a" }),
      {
        encryptedState,
        revision: 4,
        updatedAt: { __type: "serverTimestamp" }
      }
    );
  });

  it("rejects stale and omitted update revisions before unwrapping or encrypting", async () => {
    firestoreMocks.transaction.get.mockResolvedValue(existingSnapshot(3));

    await expect(saveVaultWorkspace(profile, privateKey, { graph: {} }, 2)).rejects.toMatchObject({
      code: "vault-workspace/revision-conflict",
      expectedRevision: 2,
      actualRevision: 3
    });
    await expect(saveVaultWorkspace(profile, privateKey, { graph: {} })).rejects.toBeInstanceOf(
      VaultWorkspaceRevisionConflictError
    );
    expect(cryptoMocks.unwrapNoteKey).not.toHaveBeenCalled();
    expect(cryptoMocks.encryptText).not.toHaveBeenCalled();
    expect(firestoreMocks.transaction.update).not.toHaveBeenCalled();
  });

  it("rejects a nonzero create revision as a conflict before generating keys", async () => {
    firestoreMocks.transaction.get.mockResolvedValue({ exists: () => false });

    await expect(saveVaultWorkspace(profile, privateKey, { graph: {} }, 2)).rejects.toMatchObject({
      expectedRevision: 2,
      actualRevision: 0
    });
    expect(cryptoMocks.generateNoteKey).not.toHaveBeenCalled();
    expect(firestoreMocks.transaction.set).not.toHaveBeenCalled();
  });

  it("rejects non-JSON, cyclic, non-finite and oversized state before Firestore access", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const symbolState = { graph: {} } as Record<PropertyKey, unknown>;
    symbolState[Symbol("private")] = "not serialized";
    const accessorState = {};
    Object.defineProperty(accessorState, "graph", { enumerable: true, get: () => ({}) });

    expect(() => assertJsonSafeWorkspaceState({ missing: undefined })).toThrow("JSON이 아닌 값");
    expect(() => assertJsonSafeWorkspaceState({ value: Number.NaN })).toThrow("유한하지 않은 숫자");
    expect(() => assertJsonSafeWorkspaceState(cyclic)).toThrow("순환 참조");
    expect(() => assertJsonSafeWorkspaceState(symbolState)).toThrow("JSON으로 보존되지 않는 속성");
    expect(() => assertJsonSafeWorkspaceState(accessorState)).toThrow("열거 가능한 일반 값");
    await expect(
      saveVaultWorkspace(profile, privateKey, { content: "가".repeat(200_000) })
    ).rejects.toThrow("저장 가능한 크기");
    expect(firestoreMocks.runTransaction).not.toHaveBeenCalled();
  });

  it("rejects decrypted plaintext that is not a valid JSON object", async () => {
    firestoreMocks.getDoc.mockResolvedValue(existingSnapshot());
    cryptoMocks.decryptText.mockResolvedValue("[1,2,3]");

    await expect(loadVaultWorkspace("user-a", privateKey)).rejects.toThrow(
      "워크스페이스 상태는 JSON 객체여야 합니다."
    );
  });
});
