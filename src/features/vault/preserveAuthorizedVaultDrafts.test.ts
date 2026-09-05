import { describe, expect, it } from "vitest";
import type { NoteSnapshot } from "../../services/notes";
import { preserveAuthorizedVaultDrafts } from "./preserveAuthorizedVaultDrafts";

const uid = "owner-a";
const privateKey = {} as CryptoKey;
const scope = { uid, privateKey };
const wrappedKey = { version: 1 as const, algorithm: "RSA-OAEP" as const, wrappedKey: "wrapped-note" };
const payload = { version: 1 as const, algorithm: "AES-GCM" as const, iv: "iv", cipherText: "ciphertext" };
function note(id: string, overrides: Partial<NoteSnapshot> = {}): NoteSnapshot {
  return {
    id, ownerUid: uid, participantUids: [uid], type: "personal", revision: 1,
    contentFormat: "markdown-v1", entryKind: "markdown", updatedBy: uid,
    encryptedTitle: payload, encryptedBody: payload, wrappedKeys: { [uid]: wrappedKey }, ...overrides
  };
}
const draft = (body: string, dirty = true) => ({ title: "제목", body, folderId: null, baseRevision: 1, dirty });
const base = (body: string, baseRevision = 1) => ({ title: "원래 제목", body, baseRevision });
const own = note("own");
const shared = note("shared", { ownerUid: "other-owner", type: "shared", participantUids: [uid, "other-owner"] });

describe("authorized dirty drafts across folder contraction", () => {
  it("preserves unrelated owned and shared edits while dropping the hidden subtree and clean buffers", () => {
    const hidden = note("hidden", { folderId: "deleted-folder" });
    const clean = note("clean");
    const drafts = { own: draft("local own"), shared: draft("local shared"), hidden: draft("hidden private"), clean: draft("clean", false) };
    const baseSnapshots = new Map(Object.keys(drafts).map((id) => [id, base(`original ${id}`)]));
    const preserved = preserveAuthorizedVaultDrafts({
      previousScope: scope, currentScope: scope, previousNotes: [own, shared, hidden, clean], nextNotes: [own, shared, clean],
      drafts, baseSnapshots
    });

    expect([...preserved.entryIds]).toEqual(["own", "shared"]);
    expect(preserved.drafts).toEqual({ own: drafts.own, shared: drafts.shared });
    expect([...preserved.baseSnapshots.keys()]).toEqual(["own", "shared"]);
    expect(preserved.drafts.own).not.toBe(drafts.own);
    expect(preserved.baseSnapshots.get("own")).not.toBe(baseSnapshots.get("own"));
    expect(Object.keys(drafts)).toEqual(["own", "shared", "hidden", "clean"]);
    expect(baseSnapshots.size).toBe(4);
  });

  it.each([
    ["UID change", { uid: "other-owner", privateKey }],
    ["key replacement", { uid, privateKey: {} as CryptoKey }],
    ["lock or disposed session", { uid, privateKey: null }]
  ])("drops all plaintext on %s", (_label, currentScope) => {
    const preserved = preserveAuthorizedVaultDrafts({
      previousScope: scope, currentScope, previousNotes: [own], nextNotes: [own],
      drafts: { own: draft("private edit") }, baseSnapshots: new Map([["own", base("private original")]])
    });
    expect(Object.keys(preserved.drafts)).toEqual([]);
    expect(preserved.baseSnapshots.size).toBe(0);
    expect(preserved.entryIds.size).toBe(0);
  });

  it.each([
    ["owner", { ownerUid: "different-owner" }],
    ["viewer removed", { participantUids: ["other-owner"] }],
    ["personal sharing type", { type: "personal" }],
    ["new participant", { participantUids: [uid, "other-owner", "new-reader"] }],
    ["viewer key rotation", { wrappedKeys: { [uid]: { ...wrappedKey, wrappedKey: "rotated" } } }],
    ["other participant key rotation", { wrappedKeys: { [uid]: wrappedKey, "other-owner": wrappedKey } }],
    ["missing wrapped key", { wrappedKeys: {} }],
    ["storage format", { contentFormat: "legacy-html-v1", entryKind: "legacy-html" }],
    ["deleted", { isDeleted: true }],
    ["purged", { isPurged: true }]
  ] as const)("never carries an edit across a changed %s authority", (_label, overrides) => {
    const preserved = preserveAuthorizedVaultDrafts({
      previousScope: scope, currentScope: scope, previousNotes: [shared],
      nextNotes: [{ ...shared, ...overrides } as NoteSnapshot],
      drafts: { shared: draft("private edit") }, baseSnapshots: new Map([["shared", base("private original")]])
    });
    expect(Object.keys(preserved.drafts)).toEqual([]);
    expect(preserved.baseSnapshots.size).toBe(0);
    expect(preserved.entryIds.size).toBe(0);
  });

  it("keeps the local draft and original merge base across same-authority remote body and metadata revisions", () => {
    const originalDraft = draft("unsaved local");
    const originalBase = base("original body");
    const preserved = preserveAuthorizedVaultDrafts({
      previousScope: scope, currentScope: scope, previousNotes: [own],
      nextNotes: [{ ...own, revision: 2, folderId: "moved", encryptedBody: { ...payload, cipherText: "remote edit" } }],
      drafts: { own: originalDraft }, baseSnapshots: new Map([["own", originalBase]])
    });
    expect(preserved.drafts.own).toEqual(originalDraft);
    expect(preserved.baseSnapshots.get("own")).toEqual(originalBase);
    expect(preserved.drafts.own.baseRevision).toBe(1);
  });

  it("does not invent authority for absent or newly visible notes, or reuse a mismatched merge base", () => {
    const preserved = preserveAuthorizedVaultDrafts({
      previousScope: scope, currentScope: scope, previousNotes: [own, note("removed")], nextNotes: [own, note("new")],
      drafts: { own: draft("own edit"), removed: draft("removed edit"), new: draft("unproven edit") },
      baseSnapshots: new Map([["own", base("wrong revision", 0)], ["removed", base("removed base")]])
    });
    expect([...preserved.entryIds]).toEqual(["own"]);
    expect(preserved.drafts.own.body).toBe("own edit");
    expect(preserved.baseSnapshots.size).toBe(0);
  });
});
