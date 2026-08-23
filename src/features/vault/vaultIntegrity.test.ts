import { describe, expect, it } from "vitest";
import { generateNoteKey } from "../../lib/crypto";
import {
  MAX_VAULT_FOLDER_DEPTH,
  VaultFolderIntegrityError,
  auditVaultFolderTree,
  canonicalVaultName,
  planVaultNameMigration,
  requireValidVaultFolderTree,
  vaultNameFingerprint
} from "./vaultIntegrity";

describe("vault integrity primitives", () => {
  it("canonicalizes Unicode, case and Obsidian file extensions consistently", () => {
    expect(canonicalVaultName("  RÉSUMÉ.MD  ", "entry", "markdown"))
      .toBe("résumé.md");
    expect(canonicalVaultName("Roadmap.canvas", "entry", "canvas"))
      .toBe("roadmap.canvas");
    expect(canonicalVaultName(" Project ", "folder"))
      .toBe("project");
    expect(() => canonicalVaultName("../private", "folder")).toThrow("올바르지");
    for (const unsafe of ["bad\\name", "bad%2Fname", "bad%252Fname", "bad\u0000name"]) {
      expect(() => canonicalVaultName(unsafe, "folder")).toThrow("올바르지");
    }
  });

  it("preserves asset file extensions instead of rewriting them as Markdown", () => {
    expect(canonicalVaultName("Diagram.PNG", "entry", "asset")).toBe("diagram.png");
  });

  it("creates stable parent-scoped HMAC fingerprints without embedding plaintext", async () => {
    const key = await generateNoteKey();
    const first = await vaultNameFingerprint(key, {
      kind: "markdown",
      name: "비밀 계획",
      parentId: "folder-a",
      targetType: "entry"
    });
    const equivalent = await vaultNameFingerprint(key, {
      kind: "markdown",
      name: "비밀 계획.md",
      parentId: "folder-a",
      targetType: "entry"
    });
    const otherParent = await vaultNameFingerprint(key, {
      kind: "markdown",
      name: "비밀 계획",
      parentId: "folder-b",
      targetType: "entry"
    });

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(first).toBe(equivalent);
    expect(first).not.toBe(otherParent);
    expect(first).not.toContain("비밀");
  });

  it("plans a dual-read migration and reports existing sibling collisions", async () => {
    const key = await generateNoteKey();
    const plan = await planVaultNameMigration(key, [
      { id: "a", kind: "markdown", name: "Note", parentId: null, targetType: "entry" },
      { id: "b", kind: "markdown", name: "note.md", parentId: null, targetType: "entry" },
      { id: "c", kind: "markdown", name: "Note", parentId: "folder-a", targetType: "entry" },
      { id: "d", name: "Note", parentId: null, targetType: "folder" }
    ]);

    expect(plan.claims.map((claim) => claim.targetId)).toEqual(["a", "c", "d"]);
    expect(plan.collisions).toEqual([expect.objectContaining({
      duplicateTargetId: "b",
      firstTargetId: "a"
    })]);
    expect(JSON.stringify(plan)).not.toContain("Note");
  });

  it("plans 5,000 deterministic claims within the bounded fingerprint worker ceiling", async () => {
    const key = await generateNoteKey();
    const sources = Array.from({ length: 5_000 }, (_, index) => ({
      id: `note-${index}`,
      kind: "markdown" as const,
      name: `Note ${index}`,
      parentId: null,
      targetType: "entry" as const
    }));
    const startedAt = performance.now();
    const plan = await planVaultNameMigration(key, sources);

    expect(plan.claims).toHaveLength(5_000);
    expect(plan.collisions).toEqual([]);
    expect(plan.claims.map((claim) => claim.targetId)).toEqual(sources.map((source) => source.id));
    expect(performance.now() - startedAt).toBeLessThan(10_000);
  }, 15_000);

  it("builds deterministic ancestry metadata for the server-verifiable depth", () => {
    const audit = auditVaultFolderTree([
      { id: "root", parentId: null },
      { id: "one", parentId: "root" }
    ]);

    expect(audit.valid).toBe(true);
    expect(audit.ancestryById.get("one")).toEqual({
      ancestorIds: ["root"],
      depth: 1,
      version: 3
    });
  });

  it("detects three-node cycles, missing parents, duplicate ids and depth overflow", () => {
    const cyclic = auditVaultFolderTree([
      { id: "a", parentId: "c" },
      { id: "b", parentId: "a" },
      { id: "c", parentId: "b" }
    ]);
    expect(cyclic.valid).toBe(false);
    expect(cyclic.issues).toContainEqual(expect.objectContaining({ kind: "cycle" }));

    const malformed = auditVaultFolderTree([
      { id: "same", parentId: null },
      { id: "same", parentId: null },
      { id: "orphan", parentId: "missing" }
    ]);
    expect(malformed.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "duplicate-id" }),
      expect.objectContaining({ kind: "missing-parent" })
    ]));

    const tooDeep = Array.from({ length: MAX_VAULT_FOLDER_DEPTH + 2 }, (_, index) => ({
      id: `folder-${index}`,
      parentId: index === 0 ? null : `folder-${index - 1}`
    }));
    expect(auditVaultFolderTree(tooDeep).issues).toContainEqual(expect.objectContaining({
      kind: "depth-limit",
      folderId: `folder-${MAX_VAULT_FOLDER_DEPTH + 1}`
    }));
  });

  it("fails closed with structured issues before a migration or move continues", () => {
    expect(() => requireValidVaultFolderTree([
      { id: "a", parentId: "b" },
      { id: "b", parentId: "a" }
    ])).toThrow(VaultFolderIntegrityError);
  });
});
