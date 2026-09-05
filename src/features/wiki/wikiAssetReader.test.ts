import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteSnapshot } from "../../services/notes";
import type { EncryptedPayload } from "../../types";
import type { MarkdownLinkReference } from "../markdown/types";
import { encodeVaultAsset } from "../vault/vaultAsset";
import { VaultDecryptionSession } from "../vault/vaultDecryptionSession";
import { WikiAssetReader } from "./wikiAssetReader";

const mocks = vi.hoisted(() => ({ decryptText: vi.fn(), unwrapNoteKey: vi.fn() }));
vi.mock("../../lib/crypto", async (original) => ({
  ...await original<typeof import("../../lib/crypto")>(), ...mocks
}));
const key = {} as CryptoKey;
const uid = "owner";
const payload = (cipherText: string): EncryptedPayload => ({ version: 1, algorithm: "AES-GCM", iv: "iv", cipherText });
const body = () => encodeVaultAsset(new Uint8Array([1, 2, 3]), "image/png");
function asset(id: string, extra: Partial<NoteSnapshot> = {}): NoteSnapshot {
  return { id, ownerUid: uid, participantUids: [uid], type: "personal", contentFormat: "asset-v1", entryKind: "asset",
    encryptedTitle: payload(`${id}.png`), encryptedBody: payload(`body:${id}`),
    wrappedKeys: { [uid]: { version: 1, algorithm: "RSA-OAEP", wrappedKey: `key:${id}` } }, updatedBy: uid, ...extra };
}
function reference(path: string, extra: Partial<MarkdownLinkReference> = {}): MarkdownLinkReference {
  return { path, raw: `![[${path}]]`, target: path, kind: "wikilink", subpath: null, display: path, embed: true, ...extra };
}
const source = { id: "text", path: "Text.md" };
const signal = () => new AbortController().signal;

beforeEach(() => {
  mocks.unwrapNoteKey.mockReset().mockResolvedValue({} as CryptoKey);
  mocks.decryptText.mockReset().mockImplementation(async (value: EncryptedPayload) => value.cipherText.startsWith("body:") ? body() : value.cipherText);
});

describe("WikiAssetReader", () => {
  it("shares a lazy title-only index and decrypts only referenced bodies, reusing warm session crypto", async () => {
    const session = new VaultDecryptionSession(uid, key);
    const snapshots = [asset("one"), asset("two"), asset("unreferenced")];
    const reader = new WikiAssetReader({ uid, privateKey: key, session, snapshots, folders: [] });
    expect(mocks.decryptText).not.toHaveBeenCalled();
    const [one, two] = await Promise.all([
      reader.resolve(reference("one.png"), source, signal()), reader.resolve(reference("two.png"), source, signal())
    ]);
    expect(one?.id).toBe("one");
    expect(two?.id).toBe("two");
    expect(mocks.unwrapNoteKey).toHaveBeenCalledTimes(3);
    expect(mocks.decryptText).toHaveBeenCalledTimes(3);
    expect(mocks.decryptText.mock.calls.every(([value]) => !value.cipherText.startsWith("body:"))).toBe(true);
    const first = await reader.load(one!, signal());
    const repeat = await reader.load(one!, signal());
    expect(repeat).toBe(first);
    expect(mocks.decryptText).toHaveBeenCalledTimes(4);
    expect(mocks.decryptText.mock.calls.filter(([value]) => value.cipherText.startsWith("body:")).map(([value]) => value.cipherText)).toEqual(["body:one"]);
    reader.dispose();
    const next = new WikiAssetReader({ uid, privateKey: key, session, snapshots, folders: [] });
    await next.resolve(reference("one.png"), source, signal());
    expect(mocks.decryptText).toHaveBeenCalledTimes(4);
    next.dispose();
  });

  it("never touches external links, out-of-scope assets, or bodies for missing targets", async () => {
    const session = new VaultDecryptionSession(uid, key);
    const reader = new WikiAssetReader({ uid, privateKey: key, session, folders: [], snapshots: [
      asset("own"), asset("other", { ownerUid: "other" }), asset("deleted", { isDeleted: true }),
      asset("hidden", { folderId: "missing" }), asset("markdown", { entryKind: "markdown", contentFormat: "markdown-v1" })
    ] });
    expect(await reader.resolve(reference("https://tracker.test/a.png", { kind: "external" }), source, signal())).toBeNull();
    expect(mocks.decryptText).not.toHaveBeenCalled();
    expect(await reader.resolve(reference("missing.png"), source, signal())).toBeNull();
    expect(mocks.decryptText).toHaveBeenCalledTimes(1);
    expect(mocks.decryptText.mock.calls[0][0].cipherText).toBe("own.png");
    reader.dispose();
  });

  it.each(["clear", "dispose"] as const)("cancels pending bodies on session %s and rejects their late results", async (action) => {
    const session = new VaultDecryptionSession(uid, key);
    const reader = new WikiAssetReader({ uid, privateKey: key, session, snapshots: [asset("one")], folders: [] });
    const resolved = await reader.resolve(reference("one.png"), source, signal());
    let finish!: (value: string) => void;
    mocks.decryptText.mockImplementation(() => new Promise<string>((resolve) => { finish = resolve; }));
    const pending = reader.load(resolved!, signal());
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    session[action]();
    await rejected;
    expect(reader.signal.aborted).toBe(true);
    finish(body());
    await expect(reader.load(resolved!, signal())).rejects.toMatchObject({ name: "AbortError" });
  });

  it("cancels a removed projection and rejects fabricated snapshots without body crypto", async () => {
    const session = new VaultDecryptionSession(uid, key);
    const original = asset("one");
    const reader = new WikiAssetReader({ uid, privateKey: key, session, snapshots: [original], folders: [] });
    const resolved = await reader.resolve(reference("one.png"), source, signal());
    expect(await reader.load({ ...resolved!, snapshot: { ...original } }, signal())).toBeNull();
    expect(mocks.decryptText).toHaveBeenCalledTimes(1);
    reader.dispose();
    await expect(reader.load(resolved!, signal())).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.decryptText).toHaveBeenCalledTimes(1);
  });

  it("rejects mismatched sessions and never resolves from a truncated filename index", async () => {
    const session = new VaultDecryptionSession(uid, key);
    expect(() => new WikiAssetReader({ uid: "other", privateKey: key, session, snapshots: [], folders: [] })).toThrow();
    const reader = new WikiAssetReader({ uid, privateKey: key, session, snapshots: Array.from({ length: 5_001 }, (_, index) => asset(`${index}`)), folders: [] });
    expect(await reader.resolve(reference("0.png"), source, signal())).toBeNull();
    expect(mocks.decryptText).not.toHaveBeenCalled();
    reader.dispose();
  });
});
