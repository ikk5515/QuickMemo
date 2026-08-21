import { renamedDuplicateVaultPath, vaultPathCollisionKey } from "./path";
import type { ObsidianVaultEntryKind, ObsidianVaultManifest } from "./types";

const MAX_VAULT_TEXT_LENGTH = 500_000;
const MAX_VAULT_NAME_LENGTH = 180;
const MAX_VAULT_FOLDER_NAME_LENGTH = 120;

export interface ExistingVaultImportFolder {
  id: string;
  path: string;
}

export interface VaultImportFolderPlan {
  existingFolderId?: string;
  name: string;
  parentPath: string | null;
  path: string;
}

export interface VaultImportEntryPlan {
  body: string;
  destinationPath: string;
  folderPath: string | null;
  kind: Exclude<ObsidianVaultEntryKind, "asset">;
  sourcePath: string;
  title: string;
}

export interface VaultImportPlan {
  entries: VaultImportEntryPlan[];
  folders: VaultImportFolderPlan[];
  renamedEntries: number;
  skippedAssets: number;
}

export class VaultImportPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultImportPlanError";
  }
}

function parentPath(path: string) {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? null : path.slice(0, separator);
}

function baseName(path: string) {
  return path.slice(path.lastIndexOf("/") + 1);
}

function titleFromPath(path: string, kind: Exclude<ObsidianVaultEntryKind, "asset">) {
  const extension = kind === "canvas" ? /\.canvas$/i : kind === "base" ? /\.base$/i : /\.md$/i;
  return baseName(path).replace(extension, "");
}

function assertFolderNames(paths: readonly string[]) {
  for (const path of paths) {
    for (const segment of path.split("/")) {
      if (!segment || segment.length > MAX_VAULT_FOLDER_NAME_LENGTH) {
        throw new VaultImportPlanError("폴더 이름은 1~120자여야 합니다.");
      }
    }
  }
}

/**
 * Produces a write-free import plan. Every text entry is validated and every
 * collision is resolved before the first encrypted Firestore write begins.
 */
export function planObsidianVaultImport(
  manifest: ObsidianVaultManifest,
  existingFolders: readonly ExistingVaultImportFolder[],
  existingEntryPaths: readonly string[]
): VaultImportPlan {
  assertFolderNames(manifest.folders);

  const existingFolderByKey = new Map(existingFolders.map((folder) => [
    vaultPathCollisionKey(folder.path),
    folder
  ]));
  const occupiedFileKeys = new Set(existingEntryPaths.map(vaultPathCollisionKey));
  const occupiedFolderKeys = new Set(existingFolderByKey.keys());

  for (const folder of manifest.folders) {
    if (occupiedFileKeys.has(vaultPathCollisionKey(folder))) {
      throw new VaultImportPlanError("기존 파일과 가져올 폴더의 경로가 충돌합니다.");
    }
  }

  const folders = manifest.folders
    .slice()
    .sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right, "ko"))
    .map((path): VaultImportFolderPlan => {
      const existing = existingFolderByKey.get(vaultPathCollisionKey(path));
      occupiedFolderKeys.add(vaultPathCollisionKey(path));
      return {
        ...(existing ? { existingFolderId: existing.id } : {}),
        name: baseName(path),
        parentPath: parentPath(path),
        path
      };
    });

  const entries: VaultImportEntryPlan[] = [];
  let renamedEntries = 0;
  let skippedAssets = 0;

  for (const entry of manifest.entries) {
    if (entry.kind === "asset") {
      skippedAssets += 1;
      continue;
    }
    if (entry.text === undefined || entry.text.length > MAX_VAULT_TEXT_LENGTH) {
      throw new VaultImportPlanError("가져올 텍스트 항목은 500,000자 이하여야 합니다.");
    }

    let destinationPath = entry.path;
    let attempt = 2;
    while (occupiedFileKeys.has(vaultPathCollisionKey(destinationPath))) {
      destinationPath = renamedDuplicateVaultPath(entry.path, attempt);
      attempt += 1;
    }
    if (destinationPath !== entry.path) {
      renamedEntries += 1;
    }
    if (occupiedFolderKeys.has(vaultPathCollisionKey(destinationPath))) {
      throw new VaultImportPlanError("기존 폴더와 가져올 파일의 경로가 충돌합니다.");
    }

    const title = titleFromPath(destinationPath, entry.kind);
    if (!title || title.length > MAX_VAULT_NAME_LENGTH) {
      throw new VaultImportPlanError("가져올 파일 이름은 1~180자여야 합니다.");
    }
    const destinationFolderPath = parentPath(destinationPath);
    if (destinationFolderPath && !occupiedFolderKeys.has(vaultPathCollisionKey(destinationFolderPath))) {
      throw new VaultImportPlanError("가져올 파일의 상위 폴더를 확인할 수 없습니다.");
    }

    occupiedFileKeys.add(vaultPathCollisionKey(destinationPath));
    entries.push({
      body: entry.text,
      destinationPath,
      folderPath: destinationFolderPath,
      kind: entry.kind,
      sourcePath: entry.path,
      title
    });
  }

  return { entries, folders, renamedEntries, skippedAssets };
}
