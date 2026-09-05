import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteFolderSnapshot, NoteSnapshot } from "../../services/notes";
import type { EncryptedPayload } from "../../types";
import { decryptVaultFolders, decryptVaultNotes } from "./vaultData";
import { VaultDecryptionSession } from "./vaultDecryptionSession";

const mocks = vi.hoisted(() => ({ decryptText: vi.fn(), unwrapNoteKey: vi.fn() }));
vi.mock("../../lib/crypto", async (original) => ({
  ...await original<typeof import("../../lib/crypto")>(),
  decryptText: mocks.decryptText,
  unwrapNoteKey: mocks.unwrapNoteKey
}));

const uid = "owner-a";
const key = {} as CryptoKey;
const payload = (value: string): EncryptedPayload => ({ version: 1, algorithm: "AES-GCM", iv: `iv:${value}`, cipherText: value });
const wrappedKey = { version: 1 as const, algorithm: "RSA-OAEP" as const, wrappedKey: "wrapped-note" };
function note(overrides: Partial<NoteSnapshot> = {}): NoteSnapshot {
  return {
    id: "note-a", ownerUid: uid, participantUids: [uid], type: "personal", revision: 1,
    contentFormat: "markdown-v1", entryKind: "markdown", updatedBy: uid,
    encryptedTitle: payload("title-a"), encryptedBody: payload("body-a"), wrappedKeys: { [uid]: wrappedKey },
    ...overrides
  };
}
function folder(overrides: Partial<NoteFolderSnapshot> = {}): NoteFolderSnapshot {
  return {
    id: "folder-a", ownerUid: uid, name: "암호화 폴더", color: "#ffffff", revision: 1,
    encryptedName: payload("folder-name"), wrappedKey, ...overrides
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  mocks.decryptText.mockReset().mockImplementation(async (value: EncryptedPayload) => `plain:${value.cipherText}`);
  mocks.unwrapNoteKey.mockReset().mockResolvedValue({ kind: "aes-note-key" } as unknown as CryptoKey);
});

describe("explicit Vault decryption session", () => {
  it("decrypts a filename alone and later decrypts only its requested body", async () => {
    const session = new VaultDecryptionSession(uid, key);
    const asset = note({ contentFormat: "asset-v1", entryKind: "asset" });
    expect(await session.decryptNoteTitle(asset)).toBe("plain:title-a");
    expect(mocks.unwrapNoteKey).toHaveBeenCalledOnce();
    expect(mocks.decryptText).toHaveBeenCalledExactlyOnceWith(asset.encryptedTitle, expect.anything());
    mocks.decryptText.mockClear();
    await session.decryptNote(asset);
    expect(mocks.unwrapNoteKey).toHaveBeenCalledOnce();
    expect(mocks.decryptText).toHaveBeenCalledExactlyOnceWith(asset.encryptedBody, expect.anything());
  });

  it("deduplicates title-only consumers and cancels them at the session boundary", async () => {
    const session = new VaultDecryptionSession(uid, key);
    const pending = deferred<string>();
    mocks.decryptText.mockReturnValue(pending.promise);
    const first = session.decryptNoteTitle(note());
    const second = session.decryptNoteTitle(note());
    const cancelled = Promise.all([
      expect(first).rejects.toMatchObject({ name: "AbortError" }),
      expect(second).rejects.toMatchObject({ name: "AbortError" })
    ]);
    await vi.waitFor(() => expect(mocks.decryptText).toHaveBeenCalledOnce());
    session.clear();
    await cancelled;
    pending.resolve("late filename");
    expect(session.stats.entries).toBe(0);
  });

  it("does no crypto for revision, folder, and attachment metadata updates", async () => {
    const session = new VaultDecryptionSession(uid, key);
    const first = await decryptVaultNotes([note()], uid, key, { session });
    const second = await decryptVaultNotes([note({ revision: 8, folderId: "moved", attachmentRevision: 5 })], uid, key, { session });

    expect(second[0]).toMatchObject({ title: first[0].title, body: first[0].body, revision: 8, folderId: "moved", attachmentRevision: 5 });
    expect(mocks.unwrapNoteKey).toHaveBeenCalledTimes(1);
    expect(mocks.decryptText).toHaveBeenCalledTimes(2);
  });

  it.each(["encryptedTitle", "encryptedBody"] as const)("decrypts only the changed %s with the cached note key", async (field) => {
    const session = new VaultDecryptionSession(uid, key);
    await decryptVaultNotes([note()], uid, key, { session });
    mocks.decryptText.mockClear();
    mocks.unwrapNoteKey.mockClear();

    const changed = note({ revision: 2, [field]: payload("changed") });
    const result = await decryptVaultNotes([changed], uid, key, { session });
    expect(result[0][field === "encryptedTitle" ? "title" : "body"]).toBe("plain:changed");
    expect(mocks.unwrapNoteKey).not.toHaveBeenCalled();
    expect(mocks.decryptText).toHaveBeenCalledExactlyOnceWith(changed[field], expect.anything());
  });

  it.each([
    ["key", { wrappedKeys: { [uid]: { ...wrappedKey, wrappedKey: "rotated" } } }],
    ["ACL", { type: "shared", participantUids: [uid, "reader"], wrappedKeys: { [uid]: wrappedKey, reader: wrappedKey } }],
    ["storage format", { contentFormat: "legacy-html-v1", entryKind: "legacy-html" }],
    ["trash boundary", { isDeleted: true }]
  ] as const)("never reuses a key or plaintext across a changed %s", async (_reason, overrides) => {
    const session = new VaultDecryptionSession(uid, key);
    await decryptVaultNotes([note()], uid, key, { session });
    mocks.decryptText.mockClear();
    mocks.unwrapNoteKey.mockClear();

    await decryptVaultNotes([note(overrides as Partial<NoteSnapshot>)], uid, key, { session });
    expect(mocks.unwrapNoteKey).toHaveBeenCalledOnce();
    expect(mocks.decryptText).toHaveBeenCalledTimes(2);
  });

  it("drops revoked shared-note access even when the old wrapped key remains present", async () => {
    const session = new VaultDecryptionSession(uid, key);
    const shared = note({ type: "shared", ownerUid: "other-owner", participantUids: [uid, "other-owner"] });
    await decryptVaultNotes([shared], uid, key, { session });
    expect(session.stats.entries).toBe(1);

    expect(await decryptVaultNotes([{ ...shared, participantUids: ["other-owner"] }], uid, key, { session })).toEqual([]);
    expect(session.stats.entries).toBe(0);
  });

  it("isolates owner changes even when the viewer and wrapped bytes remain unchanged", async () => {
    const session = new VaultDecryptionSession(uid, key);
    await decryptVaultNotes([note()], uid, key, { session });
    await decryptVaultNotes([note({ ownerUid: "other-owner", type: "shared", participantUids: [uid, "other-owner"] })], uid, key, { session });
    expect(mocks.unwrapNoteKey).toHaveBeenCalledTimes(2);
    expect(mocks.decryptText).toHaveBeenCalledTimes(4);
  });

  it("shares in-flight key and field work between simultaneous consumers", async () => {
    const session = new VaultDecryptionSession(uid, key);
    const pending = deferred<CryptoKey>();
    mocks.unwrapNoteKey.mockReturnValue(pending.promise);
    const first = decryptVaultNotes([note()], uid, key, { session });
    const second = decryptVaultNotes([note({ revision: 2 })], uid, key, { session });
    await vi.waitFor(() => expect(mocks.unwrapNoteKey).toHaveBeenCalledOnce());
    pending.resolve({} as CryptoKey);

    const [a, b] = await Promise.all([first, second]);
    expect(a[0].revision).toBe(1);
    expect(b[0].revision).toBe(2);
    expect(mocks.decryptText).toHaveBeenCalledTimes(2);
  });

  it("aborting one consumer leaves shared work available to the other", async () => {
    const session = new VaultDecryptionSession(uid, key);
    const pending = deferred<CryptoKey>();
    const controller = new AbortController();
    mocks.unwrapNoteKey.mockReturnValue(pending.promise);
    const first = decryptVaultNotes([note()], uid, key, { session, signal: controller.signal });
    const cancelled = expect(first).rejects.toMatchObject({ name: "AbortError" });
    const second = decryptVaultNotes([note()], uid, key, { session });
    controller.abort();
    await cancelled;
    pending.resolve({} as CryptoKey);

    expect(await second).toHaveLength(1);
    expect(mocks.unwrapNoteKey).toHaveBeenCalledOnce();
    expect(mocks.decryptText).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["key", "before"], ["body", "before"], ["key", "after"], ["body", "after"]
  ] as const)("isolates orphaned pending %s work completing %s its replacement while retaining completed fields", async (stage, completion) => {
    const session = new VaultDecryptionSession(uid, key);
    const validNoteKey = {} as CryptoKey;
    const pendingKey = deferred<CryptoKey>();
    const pendingBody = deferred<string>();
    mocks.unwrapNoteKey.mockResolvedValue(validNoteKey);
    if (stage === "key") {
      mocks.unwrapNoteKey.mockReturnValueOnce(pendingKey.promise);
    } else {
      await session.decryptNoteTitle(note());
      mocks.decryptText.mockImplementationOnce(() => pendingBody.promise);
    }
    const controller = new AbortController();
    const first = session.decryptNote(note(), controller.signal);
    const cancelled = expect(first).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => stage === "key"
      ? expect(mocks.unwrapNoteKey).toHaveBeenCalledOnce()
      : expect(mocks.decryptText).toHaveBeenCalledTimes(2));
    controller.abort();
    await cancelled;

    // The old crypto completion can reject after its last waiter has left,
    // while a new caller arrives before that failure's cache cleanup settles.
    const finishOldWork = () => {
      pendingKey.resolve({} as CryptoKey);
      pendingBody.resolve("discarded old body");
    };
    if (completion === "before") {
      finishOldWork();
      for (let turn = 0; turn < 3; turn += 1) await Promise.resolve();
    }
    const nextController = new AbortController();
    expect(nextController.signal.aborted).toBe(false);
    expect(session.matches(uid, key)).toBe(true);
    await expect(session.decryptNote(note(), nextController.signal)).resolves.toEqual({
      title: "plain:title-a", body: "plain:body-a"
    });
    expect(mocks.unwrapNoteKey).toHaveBeenCalledTimes(stage === "key" ? 2 : 1);
    expect(mocks.decryptText.mock.calls.filter(([value]) => value.cipherText === "title-a")).toHaveLength(1);
    const cachedSize = [session.stats.entries, session.stats.estimatedBytes];
    finishOldWork();
    await vi.waitFor(() => expect(session.stats.activeCrypto).toBe(0));
    expect([session.stats.entries, session.stats.estimatedBytes]).toEqual(cachedSize);
    await expect(session.getNoteKey(note(), uid, key)).resolves.toBe(validNoteKey);
    const cryptoCalls = [mocks.unwrapNoteKey.mock.calls.length, mocks.decryptText.mock.calls.length];
    await expect(session.decryptNote(note())).resolves.toEqual({ title: "plain:title-a", body: "plain:body-a" });
    expect([mocks.unwrapNoteKey.mock.calls.length, mocks.decryptText.mock.calls.length]).toEqual(cryptoCalls);
  });

  it("stops a cancelled long list before starting queued fields or further entries", async () => {
    const session = new VaultDecryptionSession(uid, key);
    const pending = deferred<CryptoKey>();
    const controller = new AbortController();
    mocks.unwrapNoteKey.mockReturnValue(pending.promise);
    const result = decryptVaultNotes(Array.from({ length: 120 }, (_, index) => note({ id: `note-${index}` })), uid, key, {
      session, signal: controller.signal
    });
    const cancelled = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(mocks.unwrapNoteKey).toHaveBeenCalledTimes(4));
    controller.abort();
    await cancelled;
    pending.resolve({} as CryptoKey);
    await vi.waitFor(() => expect(session.stats.activeCrypto).toBe(0));
    expect(mocks.decryptText).not.toHaveBeenCalled();
    expect(mocks.unwrapNoteKey).toHaveBeenCalledTimes(4);
  });

  it("releases abandoned noncached work without retaining plaintext or blocking its replacement", async () => {
    const session = new VaultDecryptionSession(uid, key, { maxBytes: 1 });
    const pending = deferred<CryptoKey>();
    mocks.unwrapNoteKey.mockReturnValueOnce(pending.promise);
    const controller = new AbortController();
    const cancelled = expect(session.decryptNote(note(), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(mocks.unwrapNoteKey).toHaveBeenCalledOnce());
    controller.abort();
    await cancelled;
    await expect(session.decryptNote(note())).resolves.toEqual({ title: "plain:title-a", body: "plain:body-a" });
    pending.resolve({} as CryptoKey);
    await vi.waitFor(() => expect(session.stats).toMatchObject({ activeCrypto: 0, pendingCrypto: 0 }));
    expect(session.stats).toMatchObject({ entries: 0, estimatedBytes: 0 });
    expect(mocks.unwrapNoteKey).toHaveBeenCalledTimes(2);
  });

  it("keeps the four-active and 128-queued limits while reclaiming cancelled crypto slots", async () => {
    const session = new VaultDecryptionSession(uid, key);
    const pending = deferred<CryptoKey>();
    const controller = new AbortController();
    mocks.unwrapNoteKey.mockReturnValue(pending.promise);
    const requests = Array.from({ length: 133 }, (_, index) => session.getNoteKey(
      note({ id: `queued-${index}` }), uid, key, controller.signal
    ).then(() => "resolved", (error: Error) => error.name));
    await vi.waitFor(() => expect(mocks.unwrapNoteKey).toHaveBeenCalledTimes(4));
    expect(session.stats).toMatchObject({ activeCrypto: 4, pendingCrypto: 128 });
    await expect(requests[132]).resolves.toBe("Error");
    controller.abort();
    expect((await Promise.all(requests)).slice(0, 132)).toEqual(Array.from({ length: 132 }, () => "AbortError"));
    pending.resolve({} as CryptoKey);
    await vi.waitFor(() => expect(session.stats).toMatchObject({ activeCrypto: 0, pendingCrypto: 0 }));
    expect(mocks.unwrapNoteKey).toHaveBeenCalledTimes(4);
    expect(mocks.decryptText).not.toHaveBeenCalled();
    expect(session.stats.estimatedBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    await expect(session.decryptNote(note())).resolves.toEqual({ title: "plain:title-a", body: "plain:body-a" });
  });

  it.each(["clear", "dispose"] as const)("%s immediately invalidates pending plaintext and prevents late cache resurrection", async (action) => {
    const session = new VaultDecryptionSession(uid, key);
    const pending = deferred<string>();
    mocks.decryptText.mockReturnValue(pending.promise);
    const result = decryptVaultNotes([note()], uid, key, { session });
    const cancelled = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(mocks.decryptText).toHaveBeenCalledTimes(2));
    session[action]();
    await cancelled;
    expect(session.stats.entries).toBe(0);
    expect(session.stats.estimatedBytes).toBe(0);
    pending.resolve("late plaintext");
    await vi.waitFor(() => expect(session.stats.activeCrypto).toBe(0));
    expect(session.stats.entries).toBe(0);
    expect(session.matches(uid, key)).toBe(action === "clear");
  });

  it("rejects another UID, another CryptoKey, and disposed sessions before reading plaintext", async () => {
    const session = new VaultDecryptionSession(uid, key);
    await decryptVaultNotes([note()], uid, key, { session });
    await expect(decryptVaultNotes([note()], "other", key, { session })).rejects.toMatchObject({ name: "AbortError" });
    await expect(decryptVaultNotes([note()], uid, {} as CryptoKey, { session })).rejects.toMatchObject({ name: "AbortError" });
    session.dispose();
    await expect(decryptVaultFolders([folder()], uid, key, { session })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("ignores external reusable plaintext when a session is supplied", async () => {
    const session = new VaultDecryptionSession(uid, key);
    const snapshot = note();
    const result = await decryptVaultNotes([snapshot], uid, key, {
      session, reusableNotes: [{ ...snapshot, contentFormat: "markdown-v1", entryKind: "markdown", title: "untrusted", body: "untrusted" }]
    });
    expect(result[0]).toMatchObject({ title: "plain:title-a", body: "plain:body-a" });
    expect(mocks.unwrapNoteKey).toHaveBeenCalledOnce();
  });

  it("caches immutable ciphertext values so later object mutation cannot reuse stale plaintext", async () => {
    const session = new VaultDecryptionSession(uid, key);
    const snapshot = note();
    await decryptVaultNotes([snapshot], uid, key, { session });
    snapshot.encryptedBody.cipherText = "mutated";
    expect((await decryptVaultNotes([snapshot], uid, key, { session }))[0].body).toBe("plain:mutated");
    expect(mocks.decryptText).toHaveBeenCalledTimes(3);
  });

  it("does not cache failures and retries only the failed encrypted field", async () => {
    const session = new VaultDecryptionSession(uid, key);
    mocks.decryptText.mockRejectedValueOnce(new Error("corrupt title"));
    expect(await decryptVaultNotes([note()], uid, key, { session })).toEqual([]);
    expect(await decryptVaultNotes([note()], uid, key, { session })).toHaveLength(1);
    expect(mocks.unwrapNoteKey).toHaveBeenCalledOnce();
    expect(mocks.decryptText).toHaveBeenCalledTimes(3);
  });

  it("bounds retained entries with LRU eviction and separately enforces the byte budget", async () => {
    const session = new VaultDecryptionSession(uid, key, { maxEntries: 2 });
    for (const id of ["a", "b", "a", "c", "a", "b"]) await decryptVaultNotes([note({ id })], uid, key, { session });
    expect(mocks.unwrapNoteKey).toHaveBeenCalledTimes(4);
    expect(session.stats.entries).toBe(2);

    const small = new VaultDecryptionSession(uid, key, { maxBytes: 1_500 });
    mocks.decryptText.mockResolvedValue("large".repeat(1_000));
    expect(await decryptVaultNotes([note()], uid, key, { session: small })).toHaveLength(1);
    expect(small.stats.estimatedBytes).toBeLessThanOrEqual(1_500);
    expect(small.stats.entries).toBe(0);
  });

  it("shares the four-operation crypto ceiling across concurrent note and folder callers", async () => {
    const session = new VaultDecryptionSession(uid, key);
    let active = 0;
    let maximum = 0;
    const work = async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
    };
    mocks.unwrapNoteKey.mockImplementation(async () => { await work(); return {} as CryptoKey; });
    mocks.decryptText.mockImplementation(async (value: EncryptedPayload) => { await work(); return value.cipherText; });
    await Promise.all([
      decryptVaultNotes(Array.from({ length: 20 }, (_, index) => note({ id: `note-${index}` })), uid, key, { session }),
      decryptVaultFolders(Array.from({ length: 20 }, (_, index) => folder({ id: `folder-${index}` })), uid, key, { session })
    ]);
    expect(maximum).toBe(4);
  });

  it("reuses folder names through metadata updates and decrypts only renamed encrypted names", async () => {
    const session = new VaultDecryptionSession(uid, key);
    await decryptVaultFolders([folder()], uid, key, { session });
    await decryptVaultFolders([folder({ revision: 2, color: "#000000", parentId: "moved" })], uid, key, { session });
    const result = await decryptVaultFolders([folder({ encryptedName: payload("renamed") })], uid, key, { session });
    expect(result[0].displayName).toBe("plain:renamed");
    expect(mocks.unwrapNoteKey).toHaveBeenCalledOnce();
    expect(mocks.decryptText).toHaveBeenCalledTimes(2);
  });

  it("fails closed on incomplete encrypted folders and excludes foreign legacy plaintext", async () => {
    const session = new VaultDecryptionSession(uid, key);
    const result = await decryptVaultFolders([
      folder({ encryptedName: undefined }), folder({ id: "foreign", ownerUid: "other", name: "foreign secret", encryptedName: undefined, wrappedKey: undefined })
    ], uid, key, { session });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ nameDecryptionFailed: true, displayName: "복호화할 수 없는 폴더" });
    expect(mocks.decryptText).not.toHaveBeenCalled();
  });

  it("rejects unsupported payload formats instead of reusing their otherwise matching bytes", async () => {
    const session = new VaultDecryptionSession(uid, key);
    await decryptVaultNotes([note()], uid, key, { session });
    expect(await decryptVaultNotes([note({ encryptedBody: { ...payload("body-a"), version: 2 } as unknown as EncryptedPayload })], uid, key, { session })).toEqual([]);
    expect(mocks.decryptText).toHaveBeenCalledTimes(2);
  });

  it("pre-aborted calls perform no cryptographic work", async () => {
    const session = new VaultDecryptionSession(uid, key);
    const controller = new AbortController();
    controller.abort();
    await expect(decryptVaultNotes([note()], uid, key, { session, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.unwrapNoteKey).not.toHaveBeenCalled();
  });

  it("reuses an already decrypted key for saving and unwraps only after key rotation or clear", async () => {
    const session = new VaultDecryptionSession(uid, key);
    await decryptVaultNotes([note()], uid, key, { session });
    expect(await session.getNoteKey(note(), uid, key)).toBe(await mocks.unwrapNoteKey.mock.results[0].value);
    expect(mocks.unwrapNoteKey).toHaveBeenCalledOnce();
    expect(mocks.decryptText).toHaveBeenCalledTimes(2);

    await session.getNoteKey(note({ wrappedKeys: { [uid]: { ...wrappedKey, wrappedKey: "rotated" } } }), uid, key);
    expect(mocks.unwrapNoteKey).toHaveBeenCalledTimes(2);
    session.clear();
    await session.getNoteKey(note(), uid, key);
    expect(mocks.unwrapNoteKey).toHaveBeenCalledTimes(3);
    expect(mocks.decryptText).toHaveBeenCalledTimes(2);
  });

  it("shares a pending unwrap between decryption and save key requests", async () => {
    const session = new VaultDecryptionSession(uid, key);
    const pending = deferred<CryptoKey>();
    mocks.unwrapNoteKey.mockReturnValue(pending.promise);
    const read = decryptVaultNotes([note()], uid, key, { session });
    const saveKey = session.getNoteKey(note(), uid, key);
    const aesKey = {} as CryptoKey;
    pending.resolve(aesKey);
    expect(await saveKey).toBe(aesKey);
    expect(await read).toHaveLength(1);
    expect(mocks.unwrapNoteKey).toHaveBeenCalledOnce();
  });

  it("rejects save key requests for mismatched sessions and revoked notes", async () => {
    const session = new VaultDecryptionSession(uid, key);
    const shared = note({ type: "shared", ownerUid: "other-owner", participantUids: [uid, "other-owner"] });
    await session.getNoteKey(shared, uid, key);
    await expect(session.getNoteKey(shared, "another-user", key)).rejects.toMatchObject({ name: "AbortError" });
    await expect(session.getNoteKey(shared, uid, {} as CryptoKey)).rejects.toMatchObject({ name: "AbortError" });
    await expect(session.getNoteKey({ ...shared, participantUids: ["other-owner"] }, uid, key)).rejects.toThrow("읽기 권한");
    expect(session.stats.entries).toBe(0);
    expect(mocks.unwrapNoteKey).toHaveBeenCalledOnce();
  });

  it("revoking an in-flight note prevents both its plaintext and save key from resolving", async () => {
    const session = new VaultDecryptionSession(uid, key);
    const shared = note({ type: "shared", ownerUid: "other-owner", participantUids: [uid, "other-owner"] });
    const pending = deferred<CryptoKey>();
    mocks.unwrapNoteKey.mockReturnValue(pending.promise);
    const read = decryptVaultNotes([shared], uid, key, { session });
    const saveKey = session.getNoteKey(shared, uid, key);
    const rejectedRead = expect(read).rejects.toMatchObject({ name: "AbortError" });
    const rejectedKey = expect(saveKey).rejects.toMatchObject({ name: "AbortError" });
    await expect(session.getNoteKey({ ...shared, participantUids: ["other-owner"] }, uid, key)).rejects.toThrow("읽기 권한");
    await Promise.all([rejectedRead, rejectedKey]);
    pending.resolve({} as CryptoKey);
    await vi.waitFor(() => expect(session.stats.activeCrypto).toBe(0));
    expect(mocks.decryptText).not.toHaveBeenCalled();
    expect(session.stats.entries).toBe(0);
  });
});
