import { unzipSync, zipSync, type UnzipFileInfo, type Zippable } from "fflate";
import { buildObsidianExportManifest, resolveVaultInteropLimits, validateObsidianImportManifest } from "./manifest";
import { classifyObsidianVaultPath, normalizeVaultPath, vaultPathCollisionKey } from "./path";
import {
  VaultInteropError,
  type ObsidianVaultManifest,
  type ObsidianVaultSkippedEntry,
  type ObsidianVaultSourceEntry,
  type ObsidianZipOptions,
  type VaultInteropLimits
} from "./types";

export interface ObsidianVaultZipExport {
  bytes: Uint8Array;
  manifest: ObsidianVaultManifest;
}

/** Validates sources, then creates a deterministic ZIP with no QuickMemo metadata or IDs. */
export function exportObsidianVaultZip(
  sources: readonly ObsidianVaultSourceEntry[],
  options: ObsidianZipOptions = {}
): ObsidianVaultZipExport {
  const manifest = buildObsidianExportManifest(sources, options);
  return {
    bytes: createObsidianVaultZip(manifest, options),
    manifest
  };
}

/** Creates an Obsidian-compatible ZIP from an already-built manifest. */
export function createObsidianVaultZip(
  manifest: ObsidianVaultManifest,
  options: ObsidianZipOptions = {}
) {
  const limits = resolveVaultInteropLimits(options.limits);
  const validated = buildObsidianExportManifest(
    manifest.entries.map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      content: entry.bytes,
      mimeType: entry.mimeType
    })),
    {
      ...options,
      folders: manifest.folders,
      stripCommonRoot: false
    }
  );
  const zippable: Zippable = {};
  for (const folder of validated.folders) {
    zippable[`${folder}/`] = new Uint8Array();
  }
  for (const entry of validated.entries) {
    zippable[entry.path] = entry.bytes;
  }

  let archive: Uint8Array;
  try {
    archive = zipSync(zippable, {
      level: options.compressionLevel ?? 6,
      mtime: "1980-01-01T00:00:00.000Z"
    });
  } catch {
    throw new VaultInteropError("zip-invalid");
  }
  if (archive.length > limits.maxArchiveBytes) {
    throw new VaultInteropError("archive-too-large");
  }
  return archive;
}

/**
 * Reads a ZIP entirely in memory with central-directory size and ratio checks.
 * Nothing is written to disk; returned entries still need encryption by the caller.
 */
export function readObsidianVaultZip(bytes: Uint8Array, options: ObsidianZipOptions = {}) {
  const limits = resolveVaultInteropLimits(options.limits);
  if (!isUint8Array(bytes) || bytes.length > limits.maxArchiveBytes) {
    throw new VaultInteropError("archive-too-large");
  }

  const state: ZipReadState = {
    entryCount: 0,
    filePaths: new Map(),
    folders: [],
    selectedOriginalBytes: 0,
    seenExactPaths: new Set(),
    skipped: []
  };

  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(bytes, {
      filter: (file) => shouldInflateVaultEntry(file, state, limits, options)
    });
  } catch (error) {
    if (error instanceof VaultInteropError) {
      throw error;
    }
    throw new VaultInteropError("zip-invalid");
  }

  const sources: ObsidianVaultSourceEntry[] = [];
  let verifiedTotal = 0;
  for (const [rawPath, content] of Object.entries(unzipped)) {
    const normalizedPath = state.filePaths.get(rawPath)
      ?? normalizeVaultPath(rawPath, { maxPathBytes: limits.maxPathBytes });
    verifiedTotal += content.length;
    if (content.length > limits.maxEntryBytes || verifiedTotal > limits.maxTotalBytes) {
      throw new VaultInteropError("total-size-exceeded");
    }
    sources.push({ path: normalizedPath, content });
  }

  const manifest = validateObsidianImportManifest(sources, {
    ...options,
    folders: state.folders
  });
  return {
    ...manifest,
    skipped: [...state.skipped, ...manifest.skipped]
  };
}

interface ZipReadState {
  entryCount: number;
  filePaths: Map<string, string>;
  folders: string[];
  selectedOriginalBytes: number;
  seenExactPaths: Set<string>;
  skipped: ObsidianVaultSkippedEntry[];
}

function shouldInflateVaultEntry(
  file: UnzipFileInfo,
  state: ZipReadState,
  limits: VaultInteropLimits,
  options: ObsidianZipOptions
) {
  state.entryCount += 1;
  if (state.entryCount > limits.maxEntries) {
    throw new VaultInteropError("too-many-entries");
  }

  const archivePath = file.name.replace(/\\/g, "/");
  const directory = archivePath.endsWith("/");
  const normalizedWithSlash = normalizeVaultPath(archivePath, {
    allowTrailingSlash: directory,
    maxPathBytes: limits.maxPathBytes
  });
  const normalizedPath = normalizedWithSlash.replace(/\/$/, "");
  const exactKey = directory ? `${normalizedPath}/` : normalizedPath;
  if (state.seenExactPaths.has(exactKey)) {
    throw new VaultInteropError("duplicate-path");
  }
  state.seenExactPaths.add(exactKey);

  const metadataReason = archiveMetadataReason(normalizedPath, options.includeObsidianConfig === true);
  if (metadataReason) {
    state.skipped.push({ path: normalizedPath, reason: metadataReason });
    return false;
  }
  if (directory) {
    state.folders.push(normalizedPath);
    return false;
  }
  if (file.compression !== 0 && file.compression !== 8) {
    throw new VaultInteropError("unsupported-compression");
  }
  if (!safeZipSize(file.size) || !safeZipSize(file.originalSize)) {
    throw new VaultInteropError("zip-invalid");
  }
  const entrySizeLimit = classifyObsidianVaultPath(normalizedPath) === "asset"
    ? limits.maxEntryBytes
    : limits.maxTextEntryBytes;
  if (file.originalSize > entrySizeLimit) {
    throw new VaultInteropError("entry-too-large");
  }
  const ratio = file.originalSize / Math.max(file.size, 1);
  if (file.originalSize >= limits.minRatioCheckBytes && ratio > limits.maxCompressionRatio) {
    throw new VaultInteropError("entry-too-large");
  }
  state.selectedOriginalBytes += file.originalSize;
  if (state.selectedOriginalBytes > limits.maxTotalBytes) {
    throw new VaultInteropError("total-size-exceeded");
  }
  state.filePaths.set(file.name, normalizedPath);
  return true;
}

function archiveMetadataReason(path: string, includeObsidianConfig: boolean) {
  const segments = path.split("/").map((segment) => segment.toLocaleLowerCase("en-US"));
  if (segments[0] === "__macosx" || segments.includes(".ds_store")) {
    return "system-metadata" as const;
  }
  if (!includeObsidianConfig && segments.includes(".obsidian")) {
    return "obsidian-config" as const;
  }
  return null;
}

function safeZipSize(value: number) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isUint8Array(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value)
    && Object.prototype.toString.call(value) === "[object Uint8Array]";
}

/** Useful when presenting a collision preview without exposing storage IDs. */
export function listVaultPathCollisions(manifest: Pick<ObsidianVaultManifest, "entries">) {
  const firstByKey = new Map<string, string>();
  const collisions: Array<{ firstPath: string; duplicatePath: string }> = [];
  for (const entry of manifest.entries) {
    const key = vaultPathCollisionKey(entry.path);
    const firstPath = firstByKey.get(key);
    if (firstPath) {
      collisions.push({ firstPath, duplicatePath: entry.path });
    } else {
      firstByKey.set(key, entry.path);
    }
  }
  return collisions;
}
