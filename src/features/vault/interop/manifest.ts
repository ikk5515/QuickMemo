import {
  classifyObsidianVaultPath,
  isObsidianConfigPath,
  isSystemMetadataPath,
  normalizeVaultPath,
  renamedDuplicateVaultPath,
  vaultParentFolders,
  vaultPathCollisionKey
} from "./path";
import {
  DEFAULT_VAULT_INTEROP_LIMITS,
  VaultInteropError,
  type ObsidianManifestOptions,
  type ObsidianVaultEntryKind,
  type ObsidianVaultManifest,
  type ObsidianVaultManifestEntry,
  type ObsidianVaultSourceEntry,
  type VaultInteropLimits
} from "./types";

const utf8Encoder = new TextEncoder();
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function resolveVaultInteropLimits(overrides: Partial<VaultInteropLimits> = {}): VaultInteropLimits {
  const limits = { ...DEFAULT_VAULT_INTEROP_LIMITS, ...overrides };
  const integerKeys: Array<Exclude<keyof VaultInteropLimits, "maxCompressionRatio">> = [
    "maxArchiveBytes",
    "maxEntries",
    "maxEntryBytes",
    "maxPathBytes",
    "maxTextEntryBytes",
    "maxTotalBytes",
    "minRatioCheckBytes"
  ];
  if (
    integerKeys.some((key) => !Number.isSafeInteger(limits[key]) || limits[key] < 1)
    || !Number.isFinite(limits.maxCompressionRatio)
    || limits.maxCompressionRatio < 1
    || limits.maxTextEntryBytes > limits.maxEntryBytes
    || limits.maxEntryBytes > limits.maxTotalBytes
  ) {
    throw new RangeError("Invalid vault interoperability limits");
  }
  return limits;
}

/** Builds the exact, ID-free entries that can be written to an Obsidian ZIP. */
export function buildObsidianExportManifest(
  sources: readonly ObsidianVaultSourceEntry[],
  options: ObsidianManifestOptions = {}
) {
  return buildManifest(sources, options, true);
}

/** Validates already-extracted archive entries before any encrypted writes occur. */
export function validateObsidianImportManifest(
  sources: readonly ObsidianVaultSourceEntry[],
  options: ObsidianManifestOptions = {}
) {
  return buildManifest(sources, options, false);
}

function buildManifest(
  sources: readonly ObsidianVaultSourceEntry[],
  options: ObsidianManifestOptions,
  enforceDeclaredKind: boolean
): ObsidianVaultManifest {
  const limits = resolveVaultInteropLimits(options.limits);
  if (sources.length > limits.maxEntries) {
    throw new VaultInteropError("too-many-entries");
  }

  const normalizedSources = sources.map((source) => ({
    ...source,
    path: normalizeVaultPath(source.path, { maxPathBytes: limits.maxPathBytes })
  }));
  const normalizedFolders = (options.folders ?? []).map((folder) => normalizeVaultPath(folder, {
    allowTrailingSlash: folder.replace(/\\/g, "/").endsWith("/"),
    maxPathBytes: limits.maxPathBytes
  }).replace(/\/$/, ""));
  if (normalizedSources.length + normalizedFolders.length > limits.maxEntries) {
    throw new VaultInteropError("too-many-entries");
  }
  const commonRoot = options.stripCommonRoot
    ? commonVaultRoot(normalizedSources.map((source) => source.path))
    : null;

  const entries: ObsidianVaultManifestEntry[] = [];
  const skipped: ObsidianVaultManifest["skipped"] = [];
  const warnings: string[] = [];
  const occupiedFileKeys = new Set<string>();
  let totalBytes = 0;

  for (const source of normalizedSources) {
    const strippedPath = commonRoot ? stripVaultRoot(source.path, commonRoot) : source.path;
    const path = normalizeVaultPath(strippedPath, { maxPathBytes: limits.maxPathBytes });
    if (isSystemMetadataPath(path)) {
      skipped.push({ path, reason: "system-metadata" });
      continue;
    }
    if (!options.includeObsidianConfig && isObsidianConfigPath(path)) {
      skipped.push({ path, reason: "obsidian-config" });
      continue;
    }

    const inferredKind = classifyObsidianVaultPath(path);
    if (enforceDeclaredKind && source.kind && source.kind !== inferredKind) {
      throw new VaultInteropError("invalid-content");
    }

    let finalPath = path;
    let collisionKey = vaultPathCollisionKey(finalPath);
    if (occupiedFileKeys.has(collisionKey)) {
      const policy = options.duplicatePolicy ?? "error";
      if (policy === "error") {
        throw new VaultInteropError("duplicate-path");
      }
      if (policy === "keep-first") {
        skipped.push({ path, reason: "duplicate" });
        continue;
      }
      let attempt = 2;
      do {
        finalPath = renamedDuplicateVaultPath(path, attempt);
        collisionKey = vaultPathCollisionKey(finalPath);
        attempt += 1;
      } while (occupiedFileKeys.has(collisionKey));
      warnings.push(`중복 경로를 '${finalPath}'(으)로 변경했습니다.`);
    }

    const entry = sourceToManifestEntry(source, finalPath, inferredKind, limits, options.validateCanvas !== false);
    totalBytes += entry.bytes.length;
    if (totalBytes > limits.maxTotalBytes) {
      throw new VaultInteropError("total-size-exceeded");
    }
    occupiedFileKeys.add(collisionKey);
    entries.push(entry);
  }

  const foldersByKey = new Map<string, string>();
  const addFolder = (folder: string) => {
    const finalFolder = commonRoot ? stripVaultRoot(folder, commonRoot) : folder;
    if (!finalFolder) {
      return;
    }
    const normalized = normalizeVaultPath(finalFolder, { maxPathBytes: limits.maxPathBytes });
    for (const parent of [...vaultParentFolders(`${normalized}/placeholder`), normalized]) {
      const key = vaultPathCollisionKey(parent);
      if (!foldersByKey.has(key)) {
        foldersByKey.set(key, parent);
      }
    }
  };
  normalizedFolders.forEach(addFolder);
  entries.forEach((entry) => vaultParentFolders(entry.path).forEach(addFolder));

  for (const folderKey of foldersByKey.keys()) {
    if (occupiedFileKeys.has(folderKey)) {
      throw new VaultInteropError("path-conflict");
    }
  }
  if (entries.length + foldersByKey.size > limits.maxEntries) {
    throw new VaultInteropError("too-many-entries");
  }

  return {
    entries: entries.sort((left, right) => compareVaultPaths(left.path, right.path)),
    folders: [...foldersByKey.values()].sort(compareVaultPaths),
    skipped,
    totalBytes,
    warnings
  };
}

function sourceToManifestEntry(
  source: ObsidianVaultSourceEntry,
  path: string,
  kind: ObsidianVaultEntryKind,
  limits: VaultInteropLimits,
  validateCanvas: boolean
): ObsidianVaultManifestEntry {
  if (typeof source.content !== "string" && !isUint8Array(source.content)) {
    throw new VaultInteropError("invalid-content");
  }
  const bytes = typeof source.content === "string"
    ? utf8Encoder.encode(source.content)
    : source.content.slice();
  if (bytes.length > limits.maxEntryBytes) {
    throw new VaultInteropError("entry-too-large");
  }

  let text: string | undefined;
  if (kind !== "asset") {
    if (bytes.length > limits.maxTextEntryBytes) {
      throw new VaultInteropError("entry-too-large");
    }
    try {
      text = typeof source.content === "string" ? source.content : fatalUtf8Decoder.decode(bytes);
    } catch {
      throw new VaultInteropError("invalid-content");
    }
    if (text.includes("\u0000")) {
      throw new VaultInteropError("invalid-content");
    }
    if (kind === "canvas" && validateCanvas) {
      validateJsonCanvas(text, limits);
    }
  }

  return {
    path,
    kind,
    bytes,
    ...(text === undefined ? {} : { text }),
    mimeType: normalizedMimeType(source.mimeType, path, kind)
  };
}

function validateJsonCanvas(source: string, limits: VaultInteropLimits) {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new VaultInteropError("canvas-invalid");
  }
  if (!isRecord(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    throw new VaultInteropError("canvas-invalid");
  }
  if (value.nodes.length > limits.maxEntries || value.edges.length > limits.maxEntries * 2) {
    throw new VaultInteropError("canvas-invalid");
  }

  const nodeIds = new Set<string>();
  for (const node of value.nodes) {
    if (!isRecord(node) || !validCanvasId(node.id) || nodeIds.has(node.id)) {
      throw new VaultInteropError("canvas-invalid");
    }
    nodeIds.add(node.id);
    if (
      !finiteCanvasNumber(node.x)
      || !finiteCanvasNumber(node.y)
      || !positiveCanvasNumber(node.width)
      || !positiveCanvasNumber(node.height)
    ) {
      throw new VaultInteropError("canvas-invalid");
    }
    if (node.type === "file") {
      if (typeof node.file !== "string") {
        throw new VaultInteropError("canvas-invalid");
      }
      normalizeVaultPath(node.file, { maxPathBytes: limits.maxPathBytes });
    } else if (node.type === "link") {
      if (typeof node.url !== "string" || !safeCanvasWebUrl(node.url)) {
        throw new VaultInteropError("canvas-invalid");
      }
    } else if (node.type === "text") {
      if (typeof node.text !== "string") {
        throw new VaultInteropError("canvas-invalid");
      }
    } else if (node.type !== "group") {
      throw new VaultInteropError("canvas-invalid");
    }
  }

  const edgeIds = new Set<string>();
  for (const edge of value.edges) {
    if (
      !isRecord(edge)
      || !validCanvasId(edge.id)
      || edgeIds.has(edge.id)
      || typeof edge.fromNode !== "string"
      || typeof edge.toNode !== "string"
      || !nodeIds.has(edge.fromNode)
      || !nodeIds.has(edge.toNode)
    ) {
      throw new VaultInteropError("canvas-invalid");
    }
    edgeIds.add(edge.id);
  }
}

function safeCanvasWebUrl(value: string) {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

function validCanvasId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes("\u0000");
}

function finiteCanvasNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function positiveCanvasNumber(value: unknown): value is number {
  return finiteCanvasNumber(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUint8Array(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === "[object Uint8Array]";
}

function commonVaultRoot(paths: string[]) {
  if (!paths.length || paths.some((path) => !path.includes("/"))) {
    return null;
  }
  const root = paths[0].split("/", 1)[0];
  const key = root.normalize("NFC").toLocaleLowerCase("en-US");
  return paths.every((path) => path.split("/", 1)[0].normalize("NFC").toLocaleLowerCase("en-US") === key)
    ? root
    : null;
}

function stripVaultRoot(path: string, root: string) {
  if (path === root) {
    return "";
  }
  const prefix = `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function normalizedMimeType(value: string | undefined, path: string, kind: ObsidianVaultEntryKind) {
  const candidate = value?.trim().toLocaleLowerCase("en-US");
  if (candidate && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(candidate)) {
    return candidate;
  }
  if (kind === "markdown" || kind === "base") {
    return "text/markdown";
  }
  if (kind === "canvas") {
    return "application/json";
  }
  const extension = path.split(".").at(-1)?.toLocaleLowerCase("en-US");
  return extension === "png" ? "image/png"
    : extension === "jpg" || extension === "jpeg" ? "image/jpeg"
      : extension === "gif" ? "image/gif"
        : extension === "webp" ? "image/webp"
          : extension === "svg" ? "image/svg+xml"
            : extension === "pdf" ? "application/pdf"
              : "application/octet-stream";
}

function compareVaultPaths(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
