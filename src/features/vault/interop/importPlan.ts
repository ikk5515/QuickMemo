import { renamedDuplicateVaultPath, vaultPathCollisionKey } from "./path";
import type { ObsidianVaultEntryKind, ObsidianVaultManifest } from "./types";
import { encodeVaultAsset, MAX_INLINE_VAULT_ASSET_BYTES } from "../vaultAsset";
import { assertVaultPayloadFitsPersistence } from "../vaultPayloadLimits";
import { requireValidProposedVaultFolderTree } from "../vaultFolderPreflight";

const MAX_VAULT_NAME_LENGTH = 180;
const MAX_VAULT_FOLDER_NAME_LENGTH = 120;
// Import planning happens before Firestore folder IDs exist. This placeholder
// is the maximum UTF-8 footprint accepted by persistence for a 120-character
// folder ID, so a real generated ID cannot make the later history snapshot
// larger than the preflighted one.
const MAX_FOLDER_ID_SIZE_PLACEHOLDER = "\u0800".repeat(120);

export interface ExistingVaultImportFolder {
  id: string;
  parentId?: string | null;
  path: string;
}

export interface VaultImportFolderPlan {
  existingFolderId?: string;
  name: string;
  parentPath: string | null;
  path: string;
}

export interface VaultImportTextEntryPlan {
  body: string;
  destinationPath: string;
  folderPath: string | null;
  kind: Exclude<ObsidianVaultEntryKind, "asset">;
  sourcePath: string;
  title: string;
}

export interface VaultImportAssetEntryPlan {
  bytes: Uint8Array;
  destinationPath: string;
  folderPath: string | null;
  kind: "asset";
  mimeType: string;
  sourcePath: string;
  title: string;
}

export type VaultImportEntryPlan = VaultImportTextEntryPlan | VaultImportAssetEntryPlan;

export interface VaultImportPlan {
  entries: VaultImportEntryPlan[];
  folders: VaultImportFolderPlan[];
  renamedEntries: number;
  assetEntries: number;
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

function titleFromPath(path: string, kind: ObsidianVaultEntryKind) {
  if (kind === "asset") {
    return baseName(path);
  }
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

function persistenceFormat(kind: Exclude<ObsidianVaultEntryKind, "asset">) {
  return kind === "markdown"
    ? "markdown-v1" as const
    : kind === "canvas"
      ? "json-canvas-v1" as const
      : "base-v1" as const;
}

function assertImportPayloadFitsPersistence(
  entry: ObsidianVaultManifest["entries"][number],
  title: string,
  destinationFolderPath: string | null
) {
  const body = entry.kind === "asset"
    ? encodeVaultAsset(entry.bytes, entry.mimeType)
    : entry.text ?? "";
  const contentFormat = entry.kind === "asset"
    ? "asset-v1" as const
    : persistenceFormat(entry.kind);
  try {
    assertVaultPayloadFitsPersistence({
      body,
      contentFormat,
      entryKind: entry.kind,
      folderId: destinationFolderPath ? MAX_FOLDER_ID_SIZE_PLACEHOLDER : null,
      title
    });
  } catch (caught) {
    throw new VaultImportPlanError(
      caught instanceof Error ? caught.message : "가져올 항목이 저장 가능한 크기를 초과했습니다."
    );
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

  try {
    requireValidProposedVaultFolderTree(existingFolders, folders);
  } catch (caught) {
    throw new VaultImportPlanError(
      caught instanceof Error ? caught.message : "가져올 폴더 깊이를 확인할 수 없습니다."
    );
  }

  const entries: VaultImportEntryPlan[] = [];
  let renamedEntries = 0;
  let assetEntries = 0;

  for (const entry of manifest.entries) {
    if (entry.kind !== "asset" && entry.text === undefined) {
      throw new VaultImportPlanError("가져올 텍스트 항목을 UTF-8로 해석할 수 없습니다.");
    }
    if (entry.kind === "asset" && entry.bytes.byteLength > MAX_INLINE_VAULT_ASSET_BYTES) {
      throw new VaultImportPlanError(`첨부 파일은 ${Math.floor(MAX_INLINE_VAULT_ASSET_BYTES / 1024)}KB 이하만 암호화해 가져올 수 있습니다.`);
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
    assertImportPayloadFitsPersistence(entry, title, destinationFolderPath);

    occupiedFileKeys.add(vaultPathCollisionKey(destinationPath));
    if (entry.kind === "asset") {
      assetEntries += 1;
      entries.push({
        bytes: entry.bytes.slice(),
        destinationPath,
        folderPath: destinationFolderPath,
        kind: "asset",
        mimeType: entry.mimeType,
        sourcePath: entry.path,
        title
      });
    } else {
      entries.push({
        body: entry.text!,
        destinationPath,
        folderPath: destinationFolderPath,
        kind: entry.kind,
        sourcePath: entry.path,
        title
      });
    }
  }

  return { assetEntries, entries, folders, renamedEntries };
}
