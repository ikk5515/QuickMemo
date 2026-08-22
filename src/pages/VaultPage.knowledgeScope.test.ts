import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { NoteSnapshot } from "../services/notes";
import type { DecryptedVaultNote } from "../features/vault/vaultData";
import { createDefaultVaultWorkspaceState } from "../features/vault/workspaceState";
import {
  decryptedVaultNotesForScope,
  knowledgeAccessScopeRequiresReset,
  knowledgeAccessScopeSignature,
  vaultOwnerScopeRequiresReset,
  vaultPlaintextScopeSignature,
  vaultWorkspaceForEntryIds,
  visibleVaultOwnerIds,
  workspaceTabsForVaultNotes
} from "./VaultPage";
import type { UserProfile } from "../types";

const encrypted = { algorithm: "AES-GCM", cipherText: "cipher", iv: "iv", version: 1 } as const;

function note(overrides: Partial<NoteSnapshot> = {}): NoteSnapshot {
  return {
    encryptedBody: encrypted,
    encryptedTitle: encrypted,
    id: "note-1",
    isDeleted: false,
    ownerUid: "owner",
    participantUids: ["owner", "reader"],
    type: "shared",
    updatedBy: "owner",
    wrappedKeys: {
      reader: { algorithm: "RSA-OAEP", version: 1, wrappedKey: "reader-key" }
    },
    ...overrides
  };
}

describe("Vault knowledge ACL scope invalidation", () => {
  it("queries only self and active owners who explicitly allow this participant", () => {
    const profile = {
      uid: "reader",
      isAdmin: false
    } as UserProfile;
    const owner = (uid: string, allowedShareTargetUids?: string[], isActive = true) => ({
      uid,
      isActive,
      allowedShareTargetUids
    }) as UserProfile;

    expect(visibleVaultOwnerIds(profile, [
      owner("allowed", ["reader"]),
      owner("revoked", []),
      owner("legacy-without-allowlist"),
      owner("inactive", ["reader"], false)
    ])).toEqual(["allowed", "reader"]);
    expect(visibleVaultOwnerIds({ ...profile, isAdmin: true }, [])).toBeNull();
  });

  it("invalidates immediately when a visible note is revoked", () => {
    const previous = knowledgeAccessScopeSignature([note()], "reader");
    const current = knowledgeAccessScopeSignature([], "reader");
    expect(knowledgeAccessScopeRequiresReset(previous, current)).toBe(true);
  });

  it("invalidates same-ID access replacement but not an additive grant", () => {
    const previous = knowledgeAccessScopeSignature([note()], "reader");
    const replaced = knowledgeAccessScopeSignature([
      note({ ownerUid: "new-owner", wrappedKeys: {
        reader: { algorithm: "RSA-OAEP", version: 1, wrappedKey: "replacement-key" }
      } })
    ], "reader");
    expect(knowledgeAccessScopeRequiresReset(previous, replaced)).toBe(true);
    expect(knowledgeAccessScopeRequiresReset(previous, [
      ...previous,
      ...knowledgeAccessScopeSignature([note({ id: "note-2" })], "reader")
    ])).toBe(false);
  });

  it("fails closed before paint when the owner allowlist contracts", () => {
    expect(vaultOwnerScopeRequiresReset("allowed\nreader", "reader")).toBe(true);
    expect(vaultOwnerScopeRequiresReset("reader", "allowed\nreader")).toBe(false);
    expect(vaultOwnerScopeRequiresReset("admin", "reader")).toBe(true);
    expect(vaultOwnerScopeRequiresReset("reader", "admin")).toBe(false);
  });

  it("hides old title, body, and entry tabs on ACL changes without blanking normal revisions", () => {
    const raw = note({ revision: 1 });
    const decrypted = {
      body: "revoked secret body",
      entryKind: "markdown",
      id: raw.id,
      ownerUid: raw.ownerUid,
      title: "revoked secret title"
    } as DecryptedVaultNote;
    const previousScope = vaultPlaintextScopeSignature([raw], "reader", "owner\nreader");
    const removedScope = vaultPlaintextScopeSignature([], "reader", "reader");
    const revisedScope = vaultPlaintextScopeSignature([note({ revision: 2 })], "reader", "owner\nreader");
    const replacedKeyScope = vaultPlaintextScopeSignature([
      note({ wrappedKeys: {
        reader: { algorithm: "RSA-OAEP", version: 1, wrappedKey: "replacement-key" }
      } })
    ], "reader", "owner\nreader");

    expect(decryptedVaultNotesForScope(
      [decrypted],
      ["owner", "reader"],
      previousScope,
      previousScope,
      true
    )).toEqual([decrypted]);
    expect(revisedScope).toBe(previousScope);
    expect(decryptedVaultNotesForScope(
      [decrypted],
      ["owner", "reader"],
      previousScope,
      revisedScope,
      true
    )).toEqual([decrypted]);

    for (const currentScope of [removedScope, replacedKeyScope]) {
      const visibleNotes = decryptedVaultNotesForScope(
        [decrypted],
        ["owner", "reader"],
        previousScope,
        currentScope,
        true
      );
      expect(visibleNotes).toEqual([]);
      expect(workspaceTabsForVaultNotes([
        { entryId: raw.id, id: `entry:${raw.id}`, kind: "entry", label: decrypted.title },
        { id: "global-graph", kind: "global-graph", label: "그래프 보기" }
      ], visibleNotes)).toEqual([
        { id: "global-graph", kind: "global-graph", label: "그래프 보기" }
      ]);
    }
  });

  it("invalidates stale subscription/decrypt continuations and gates stale search and graph output", () => {
    const source = readFileSync("src/pages/VaultPage.tsx", "utf8");
    const layoutBoundary = source.indexOf("useLayoutEffect(() => {");
    const subscription = source.indexOf("const unsubscribe = subscribeVisibleNotes(");
    const clearBoundary = source.match(
      /const clearVaultPlaintextForAccessScope = useCallback\(\(\) => \{[\s\S]*?\n\s{2}\}, \[\]\);/u
    )?.[0] ?? "";

    expect(layoutBoundary).toBeGreaterThan(-1);
    expect(subscription).toBeGreaterThan(layoutBoundary);
    expect(clearBoundary).toContain("setDecryptedVaultScopeKey(null)");
    expect(clearBoundary).toContain("setRawNotes([])");
    expect(clearBoundary).toContain("setDecryptedNotes([])");
    expect(clearBoundary).toContain("setDrafts({})");
    expect(clearBoundary).toContain("setTabs([])");
    expect(clearBoundary).toContain("setActiveTabId(null)");
    expect(clearBoundary).toContain("decodedAssetCacheRef.current.clear()");
    expect(clearBoundary).toContain("setWorkerSearchEntryIds(null)");
    expect(clearBoundary).toContain("setWorkerGlobalSnapshot(null)");
    expect(clearBoundary).toContain("setWorkerLocalSnapshot(null)");
    expect(source).toContain("noteSubscriptionGenerationRef.current !== subscriptionGeneration");
    expect(source).toContain("setDecryptedVaultScopeKey(decryptScopeKey)");
    expect(source).toMatch(/const globalSnapshot = vaultPlaintextScopeReady[\s\S]*?emptyGraphSnapshot\("global"\)/u);
    expect(source).toMatch(/const visibleTags = vaultPlaintextScopeReady/u);
  });

  it("drops revoked entry references before a decrypted workspace is restored", () => {
    const workspace = createDefaultVaultWorkspaceState();
    workspace.tabs = [
      { entryId: "allowed", kind: "entry" },
      { entryId: "revoked", kind: "entry" },
      { kind: "global-graph" }
    ];
    workspace.activeTab = { entryId: "revoked", kind: "entry" };
    workspace.bookmarks = [
      { createdAt: 1, entryId: "allowed", id: "allowed-bookmark", kind: "entry", label: "Allowed", path: "Allowed.md" },
      { createdAt: 2, entryId: "revoked", id: "revoked-bookmark", kind: "entry", label: "Revoked secret", path: "Revoked.md" }
    ];

    const safe = vaultWorkspaceForEntryIds(workspace, new Set(["allowed"]));
    expect(safe.tabs).toEqual([
      { entryId: "allowed", kind: "entry" },
      { kind: "global-graph" }
    ]);
    expect(safe.activeTab).toBeNull();
    expect(safe.bookmarks).toEqual([
      { createdAt: 1, entryId: "allowed", id: "allowed-bookmark", kind: "entry", label: "Allowed", path: "Allowed.md" }
    ]);
    expect(JSON.stringify(safe)).not.toContain("Revoked secret");
  });

  it("terminates the stale worker before starting the replacement path", () => {
    const source = readFileSync("src/pages/VaultPage.tsx", "utf8");
    const dispose = source.indexOf("void staleClient.dispose();");
    const restart = source.indexOf("setKnowledgeClientGeneration((current) => current + 1);", dispose);
    expect(dispose).toBeGreaterThan(-1);
    expect(restart).toBeGreaterThan(dispose);
  });
});
