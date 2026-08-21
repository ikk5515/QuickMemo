import { bytesToBase64 } from "../../lib/crypto";
import type { VaultEntryKind } from "../../types";
import { normalizeVaultPath } from "./interop/path";

export const VAULT_NAME_INDEX_VERSION = 1 as const;
export const VAULT_ANCESTRY_VERSION = 1 as const;
export const MAX_VAULT_FOLDER_DEPTH = 64;

const encoder = new TextEncoder();
const fingerprintKeyCache = new WeakMap<CryptoKey, Promise<CryptoKey>>();
const base64Url = (value: string) => value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

export type VaultNameTargetType = "entry" | "folder";

export interface VaultNameClaimV1 {
  fingerprint: string;
  indexVersion: typeof VAULT_NAME_INDEX_VERSION;
  parentId: string | null;
  targetId: string;
  targetType: VaultNameTargetType;
}

export interface VaultAncestorMetadataV1 {
  ancestorIds: string[];
  depth: number;
  version: typeof VAULT_ANCESTRY_VERSION;
}

export interface VaultFolderIntegritySource {
  id: string;
  parentId?: string | null;
}

export interface VaultFolderIntegrityIssue {
  folderId: string;
  kind: "cycle" | "depth-limit" | "duplicate-id" | "missing-parent";
  relatedId?: string;
}

export interface VaultFolderIntegrityAudit {
  ancestryById: Map<string, VaultAncestorMetadataV1>;
  issues: VaultFolderIntegrityIssue[];
  valid: boolean;
}

export interface VaultNameMigrationSource {
  id: string;
  kind?: VaultEntryKind;
  name: string;
  parentId: string | null;
  targetType: VaultNameTargetType;
}

export interface VaultNameMigrationPlan {
  claims: VaultNameClaimV1[];
  collisions: Array<{
    fingerprint: string;
    firstTargetId: string;
    duplicateTargetId: string;
  }>;
}

export class VaultFolderIntegrityError extends Error {
  readonly code = "vault/folder-integrity";
  readonly issues: VaultFolderIntegrityIssue[];

  constructor(issues: VaultFolderIntegrityIssue[]) {
    super("폴더 트리 무결성을 확인할 수 없습니다.");
    this.name = "VaultFolderIntegrityError";
    this.issues = issues;
  }
}

function assertIdentifier(value: string, label: string) {
  if (!value || value.length > 120 || value.includes("/")) {
    throw new Error(`${label} 식별자가 올바르지 않습니다.`);
  }
}

function entryExtension(kind: VaultEntryKind) {
  if (kind === "canvas") {
    return ".canvas";
  }
  if (kind === "base") {
    return ".base";
  }
  if (kind === "asset") {
    return null;
  }
  return ".md";
}

/**
 * Matches the Vault's case-insensitive path collision semantics without
 * persisting the resulting plaintext. NFC prevents canonically equivalent
 * Unicode spellings from receiving different reservations.
 */
export function canonicalVaultName(
  value: string,
  targetType: VaultNameTargetType,
  kind: VaultEntryKind = "markdown"
) {
  const trimmed = value.trim().normalize("NFC");
  if (!trimmed || trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error("Vault 이름이 올바르지 않습니다.");
  }
  try {
    // Reuse the ZIP/search path contract so percent-encoded separators,
    // control characters and double-encoded traversal names cannot enter the
    // live Vault and later collapse to a different path during export.
    if (normalizeVaultPath(trimmed).includes("/")) {
      throw new Error("invalid-segment");
    }
  } catch {
    throw new Error("Vault 이름이 올바르지 않습니다.");
  }

  const extension = entryExtension(kind);
  const fileName = targetType === "entry" && extension
    ? `${trimmed.replace(new RegExp(`${extension.replace(".", "\\.")}$`, "iu"), "")}${extension}`
    : trimmed;

  return fileName.toLocaleLowerCase("en-US");
}

async function fingerprintKey(vaultKey: CryptoKey) {
  let pending = fingerprintKeyCache.get(vaultKey);
  if (!pending) {
    pending = crypto.subtle.exportKey("raw", vaultKey).then((rawKey) => crypto.subtle.importKey(
      "raw",
      rawKey,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    ));
    fingerprintKeyCache.set(vaultKey, pending);
  }

  try {
    return await pending;
  } catch (error) {
    fingerprintKeyCache.delete(vaultKey);
    throw error;
  }
}

/**
 * Produces a parent-scoped, keyed equality token. The server can detect a
 * duplicate reservation but cannot run an offline dictionary attack without
 * the wrapped client-only Vault key. Parent scope is inside the MAC so the
 * same name in two folders is unlinkable to the server.
 */
export async function vaultNameFingerprint(
  vaultKey: CryptoKey,
  input: {
    kind?: VaultEntryKind;
    name: string;
    parentId: string | null;
    targetType: VaultNameTargetType;
  }
) {
  if (input.parentId !== null) {
    assertIdentifier(input.parentId, "상위 폴더");
  }
  const canonicalName = canonicalVaultName(input.name, input.targetType, input.kind);
  const payload = JSON.stringify([
    "quickmemo/vault-name",
    VAULT_NAME_INDEX_VERSION,
    input.targetType,
    input.parentId,
    canonicalName
  ]);
  const signature = await crypto.subtle.sign(
    "HMAC",
    await fingerprintKey(vaultKey),
    encoder.encode(payload)
  );
  return base64Url(bytesToBase64(signature));
}

export async function planVaultNameMigration(
  vaultKey: CryptoKey,
  sources: readonly VaultNameMigrationSource[]
): Promise<VaultNameMigrationPlan> {
  const claims: VaultNameClaimV1[] = [];
  const collisions: VaultNameMigrationPlan["collisions"] = [];
  const firstByFingerprint = new Map<string, string>();

  for (const source of sources) {
    assertIdentifier(source.id, "Vault 항목");
    const fingerprint = await vaultNameFingerprint(vaultKey, source);
    const firstTargetId = firstByFingerprint.get(fingerprint);
    if (firstTargetId) {
      collisions.push({
        duplicateTargetId: source.id,
        fingerprint,
        firstTargetId
      });
      continue;
    }
    firstByFingerprint.set(fingerprint, source.id);
    claims.push({
      fingerprint,
      indexVersion: VAULT_NAME_INDEX_VERSION,
      parentId: source.parentId,
      targetId: source.id,
      targetType: source.targetType
    });
  }

  return { claims, collisions };
}

/**
 * Audits the complete decrypted folder snapshot. This is intentionally a
 * client-side validation primitive, not a claim that Firestore Rules can
 * recursively prove the same property.
 */
export function auditVaultFolderTree(
  folders: readonly VaultFolderIntegritySource[],
  maximumDepth = MAX_VAULT_FOLDER_DEPTH
): VaultFolderIntegrityAudit {
  if (!Number.isSafeInteger(maximumDepth) || maximumDepth < 1 || maximumDepth > MAX_VAULT_FOLDER_DEPTH) {
    throw new RangeError(`폴더 중첩 깊이는 1~${MAX_VAULT_FOLDER_DEPTH}여야 합니다.`);
  }

  const folderById = new Map<string, VaultFolderIntegritySource>();
  const issues: VaultFolderIntegrityIssue[] = [];
  for (const folder of folders) {
    if (folderById.has(folder.id)) {
      issues.push({ folderId: folder.id, kind: "duplicate-id" });
      continue;
    }
    folderById.set(folder.id, folder);
  }

  const ancestryById = new Map<string, VaultAncestorMetadataV1>();
  const visiting = new Set<string>();

  const ancestryFor = (folderId: string): VaultAncestorMetadataV1 | null => {
    const cached = ancestryById.get(folderId);
    if (cached) {
      return cached;
    }
    const folder = folderById.get(folderId);
    if (!folder) {
      return null;
    }
    if (visiting.has(folderId)) {
      issues.push({ folderId, kind: "cycle", relatedId: folderId });
      return null;
    }

    visiting.add(folderId);
    const parentId = folder.parentId ?? null;
    let ancestorIds: string[] = [];
    if (parentId !== null) {
      if (!folderById.has(parentId)) {
        issues.push({ folderId, kind: "missing-parent", relatedId: parentId });
        visiting.delete(folderId);
        return null;
      }
      if (visiting.has(parentId)) {
        issues.push({ folderId, kind: "cycle", relatedId: parentId });
        visiting.delete(folderId);
        return null;
      }
      const parentMetadata = ancestryFor(parentId);
      if (!parentMetadata) {
        visiting.delete(folderId);
        return null;
      }
      ancestorIds = [...parentMetadata.ancestorIds, parentId];
    }

    if (ancestorIds.length > maximumDepth) {
      issues.push({ folderId, kind: "depth-limit" });
      visiting.delete(folderId);
      return null;
    }

    const metadata: VaultAncestorMetadataV1 = {
      ancestorIds,
      depth: ancestorIds.length,
      version: VAULT_ANCESTRY_VERSION
    };
    ancestryById.set(folderId, metadata);
    visiting.delete(folderId);
    return metadata;
  };

  for (const folderId of folderById.keys()) {
    ancestryFor(folderId);
  }

  const deduplicatedIssues = Array.from(new Map(issues.map((issue) => [
    `${issue.kind}\n${issue.folderId}\n${issue.relatedId ?? ""}`,
    issue
  ])).values());
  return {
    ancestryById,
    issues: deduplicatedIssues,
    valid: deduplicatedIssues.length === 0 && ancestryById.size === folderById.size
  };
}

export function requireValidVaultFolderTree(
  folders: readonly VaultFolderIntegritySource[],
  maximumDepth = MAX_VAULT_FOLDER_DEPTH
) {
  const audit = auditVaultFolderTree(folders, maximumDepth);
  if (!audit.valid) {
    throw new VaultFolderIntegrityError(audit.issues);
  }
  return audit.ancestryById;
}
