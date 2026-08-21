import { vaultPathCollisionKey } from "./interop/path";
import {
  MAX_VAULT_FOLDER_DEPTH,
  requireValidVaultFolderTree,
  type VaultFolderIntegritySource
} from "./vaultIntegrity";

export interface ExistingVaultFolderPreflightSource extends VaultFolderIntegritySource {
  path: string;
}

export interface ProposedVaultFolderPreflightSource {
  parentPath: string | null;
  path: string;
}

/**
 * Audits the complete current + proposed tree without writing. Root folders
 * have depth 0; the deepest accepted folder has 64 ancestors.
 */
export function requireValidProposedVaultFolderTree(
  existingFolders: readonly ExistingVaultFolderPreflightSource[],
  proposedFolders: readonly ProposedVaultFolderPreflightSource[]
) {
  const sources: VaultFolderIntegritySource[] = existingFolders.map((folder) => ({
    id: folder.id,
    parentId: folder.parentId ?? null
  }));
  const usedIds = new Set(sources.map((source) => source.id));
  const idByPathKey = new Map<string, string>();

  for (const folder of existingFolders) {
    const key = vaultPathCollisionKey(folder.path);
    const duplicateId = idByPathKey.get(key);
    if (duplicateId && duplicateId !== folder.id) {
      throw new Error("기존 Vault 폴더 경로가 서로 충돌합니다.");
    }
    idByPathKey.set(key, folder.id);
  }

  for (const folder of existingFolders) {
    const separator = folder.path.lastIndexOf("/");
    const expectedParentPath = separator < 0 ? null : folder.path.slice(0, separator);
    const expectedParentId = expectedParentPath
      ? idByPathKey.get(vaultPathCollisionKey(expectedParentPath))
      : null;
    if ((folder.parentId ?? null) !== (expectedParentId ?? null)) {
      throw new Error("기존 Vault 폴더 경로와 상위 폴더 관계가 일치하지 않습니다.");
    }
  }

  const orderedProposals = [...proposedFolders].sort((left, right) => (
    left.path.split("/").length - right.path.split("/").length
    || left.path.localeCompare(right.path, "ko")
  ));
  for (const [index, folder] of orderedProposals.entries()) {
    const key = vaultPathCollisionKey(folder.path);
    if (idByPathKey.has(key)) {
      continue;
    }
    const parentId = folder.parentPath
      ? idByPathKey.get(vaultPathCollisionKey(folder.parentPath))
      : null;
    if (folder.parentPath && !parentId) {
      throw new Error("새 Vault 폴더의 상위 경로를 확인할 수 없습니다.");
    }
    let id = `pending-vault-folder-${index}`;
    while (usedIds.has(id)) {
      id = `${id}-next`;
    }
    usedIds.add(id);
    idByPathKey.set(key, id);
    sources.push({ id, parentId: parentId ?? null });
  }

  return requireValidVaultFolderTree(sources, MAX_VAULT_FOLDER_DEPTH);
}
