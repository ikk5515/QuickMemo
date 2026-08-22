export interface VaultFolderTreeNode {
  active: boolean;
  generation: number;
  parentId: string | null;
  selfActive: boolean;
}

export interface VaultFolderTree {
  folderCount: number;
  nodes: Record<string, VaultFolderTreeNode>;
  revision: number;
  schemaVersion: 1;
}

export const VAULT_FOLDER_TREE_SCHEMA_VERSION: 1;
export const VAULT_FOLDER_TREE_MAX_FOLDERS: 2000;
export const VAULT_FOLDER_TREE_MAX_DEPTH: 32;
export const VAULT_FOLDER_TREE_MAX_JSON_BYTES: 700000;
export function assertVaultFolderId(value: unknown, fieldName?: string): string;
export function validateVaultFolderTree(candidate: unknown): VaultFolderTree;
export function assertVaultFolderTreeSize(tree: VaultFolderTree): number;
export function buildVaultFolderTree(folders: unknown[], revision?: number): VaultFolderTree;
export function vaultFolderAncestors(tree: VaultFolderTree, folderId: string): string[];
export function createVaultFolderNode(
  tree: VaultFolderTree,
  input: { folderId: string; parentId: string | null }
): VaultFolderTree;
export function moveVaultFolderNode(
  tree: VaultFolderTree,
  input: { folderId: string; parentId: string | null }
): VaultFolderTree;
export function setVaultFolderLifecycle(
  tree: VaultFolderTree,
  input: { folderId: string; active: boolean }
): VaultFolderTree;
export function vaultFolderTreeMatchesFolders(tree: VaultFolderTree, folders: unknown[]): boolean;
export function vaultFolderTreeFirestoreFields(
  ownerUid: string,
  tree: VaultFolderTree,
  createdAt: Date,
  updatedAt: Date
): { nodes: { mapValue: { fields: Record<string, unknown> } } } & Record<string, unknown>;
