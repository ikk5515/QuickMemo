import type { VaultFolderTree } from "./_vault-folder-tree.js";

export const __vaultFolderTreeTesting: {
  folderQuery(uid: string): Record<string, unknown>;
  performAction(
    context: { accessToken: string; projectId: string },
    uid: string,
    body: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  treeFromDocument(document: unknown, uid: string): VaultFolderTree | null;
};

export default function handler(request: unknown, response: unknown): Promise<void>;
