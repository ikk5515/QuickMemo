import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "src/pages/VaultPage.tsx"), "utf8");

describe("Vault deferred name-collision recovery wiring", () => {
  it("uses the claimless entry recovery transaction for both move and rename", () => {
    expect(source).toContain("async function resolveDeferredVaultEntryCollision(");
    expect(source).toContain('"../features/vault/vaultEntryCollisionRecovery"');
    expect(source.match(/await resolveDeferredVaultEntryCollision\(/gu)).toHaveLength(2);
    expect(source).toContain("{ folderId, title: submittedDraft.title }");
    expect(source).toContain("{ folderId: rewrittenDraft.folderId, title }");
  });

  it("uses the claimless folder recovery transaction in empty and linked paths", () => {
    expect(source).toContain("async function resolveDeferredVaultFolderCollision(");
    expect(source).toContain('"../features/vault/vaultFolderCollisionRecovery"');
    expect(source.match(/await resolveDeferredVaultFolderCollision\(/gu)).toHaveLength(4);
    expect(source).toContain("{ name: folder.displayName, parentId }");
    expect(source).toContain("{ name, parentId: folder.parentId ?? null }");
    expect(source).toContain("if ((!folder.encryptedName || !folder.wrappedKey) && !resolvingNameCollision)");
  });

  it("allows the two historical deferred-entry repairs without broadening normal mutations", () => {
    expect(source).toContain('note.contentFormat === "legacy-html-v1" && !resolvingNameCollision');
    expect(source).toContain("const repairsHistoricalSharedFolder = Boolean(");
    expect(source).toContain('note?.type === "shared"');
    expect(source).toContain("&& folderId === null");
    expect(source).toContain('(note.type !== "personal" && !repairsHistoricalSharedFolder)');
    expect(source).toContain("const collisionRepairFolderId = resolvingNameCollision");
    expect(source).toContain('&& note.type === "shared"');
    expect(source).toContain("folderId: collisionRepairFolderId");
    expect(source).toContain("folderId: rewrittenDraft.folderId,");
  });

  it("keeps every locally known conflict target actionable when migration throws", () => {
    expect(source).toContain('caught.name === "VaultNameReservationMigrationConflictError"');
    expect(source).toContain("...notesRef.current.map((note) => note.id)");
    expect(source).toContain("...foldersRef.current.map((folder) => folder.id)");
    expect(source).toContain("setVaultNameCollisionTargetIds(new Set(knownCollisionTargets))");
  });

  it("preserves dirty buffers while a blocked target is being renamed or moved", () => {
    expect(source.match(/if \(!resolvingNameCollision\) await flushOwnedRewriteDrafts/gu))
      .toHaveLength(4);
  });

  it("reconciles stale claims before migration and conditionally again before sealing", () => {
    expect(source).toContain("const initialReconciliation = await reconcilePendingClaims()");
    expect(source).toContain("if (initialReconciliation.observedClaimCount > 0)");
    expect(source).toContain("const finalReconciliation = await reconcilePendingClaims()");
    expect(source.indexOf("const initialReconciliation"))
      .toBeLessThan(source.indexOf("const result = await migrateVaultNameReservations"));
    expect(source.indexOf("const finalReconciliation"))
      .toBeLessThan(source.indexOf("await sealVaultIntegrityCutover"));
    expect(source).toContain("for (let attempt = 0; attempt < 2; attempt += 1)");
    expect(source).toContain('&& caught.code === "vault_cutover_changed"\n                && attempt < 1');
  });
});
