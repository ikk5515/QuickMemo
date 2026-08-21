import {
  DEFAULT_VAULT_INTEROP_LIMITS,
  VaultInteropError,
  type ObsidianVaultEntryKind
} from "./types";

const utf8Encoder = new TextEncoder();
const drivePathPattern = /^[a-z]:/i;

export interface NormalizeVaultPathOptions {
  allowTrailingSlash?: boolean;
  maxPathBytes?: number;
}

/**
 * Normalizes a vault-relative path without ever resolving parent segments.
 * Unsafe paths are rejected rather than repaired so callers cannot accidentally
 * turn an archive entry into a path outside the unlocked vault.
 */
export function normalizeVaultPath(input: string, options: NormalizeVaultPathOptions = {}) {
  if (typeof input !== "string" || !input || containsControlCharacter(input)) {
    throw new VaultInteropError("invalid-path");
  }

  const slashPath = input.replace(/\\/g, "/");
  const trailingSlash = slashPath.endsWith("/");
  if (
    slashPath.startsWith("/")
    || slashPath.startsWith("//")
    || drivePathPattern.test(slashPath)
    || (!options.allowTrailingSlash && trailingSlash)
  ) {
    throw new VaultInteropError("invalid-path");
  }

  const rawSegments = slashPath.split("/");
  if (trailingSlash) {
    rawSegments.pop();
  }
  if (!rawSegments.length || rawSegments.some((segment) => !segment || unsafeVaultSegment(segment))) {
    throw new VaultInteropError("invalid-path");
  }

  const normalized = rawSegments.map((segment) => segment.normalize("NFC")).join("/");
  const path = trailingSlash ? `${normalized}/` : normalized;
  const maxPathBytes = options.maxPathBytes ?? DEFAULT_VAULT_INTEROP_LIMITS.maxPathBytes;
  if (!Number.isSafeInteger(maxPathBytes) || maxPathBytes < 1 || utf8Encoder.encode(path).length > maxPathBytes) {
    throw new VaultInteropError("invalid-path");
  }
  return path;
}

export function vaultPathCollisionKey(path: string) {
  return normalizeVaultPath(path, { allowTrailingSlash: path.endsWith("/") })
    .toLocaleLowerCase("en-US");
}

export function vaultParentFolders(path: string) {
  const normalized = normalizeVaultPath(path);
  const segments = normalized.split("/");
  segments.pop();
  return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
}

export function classifyObsidianVaultPath(path: string): ObsidianVaultEntryKind {
  const normalized = normalizeVaultPath(path).toLocaleLowerCase("en-US");
  if (normalized.endsWith(".md")) {
    return "markdown";
  }
  if (normalized.endsWith(".canvas")) {
    return "canvas";
  }
  if (normalized.endsWith(".base")) {
    return "base";
  }
  return "asset";
}

export function renamedDuplicateVaultPath(path: string, attempt: number) {
  const normalized = normalizeVaultPath(path);
  if (!Number.isSafeInteger(attempt) || attempt < 2) {
    throw new VaultInteropError("invalid-path");
  }
  const slashIndex = normalized.lastIndexOf("/");
  const directory = slashIndex === -1 ? "" : normalized.slice(0, slashIndex + 1);
  const fileName = normalized.slice(slashIndex + 1);
  const dotIndex = fileName.lastIndexOf(".");
  const hasExtension = dotIndex > 0;
  const stem = hasExtension ? fileName.slice(0, dotIndex) : fileName;
  const extension = hasExtension ? fileName.slice(dotIndex) : "";
  return normalizeVaultPath(`${directory}${stem} ${attempt}${extension}`);
}

export function isObsidianConfigPath(path: string) {
  const firstSegment = normalizeVaultPath(path).split("/", 1)[0].toLocaleLowerCase("en-US");
  return firstSegment === ".obsidian";
}

export function isSystemMetadataPath(path: string) {
  const normalized = normalizeVaultPath(path);
  const segments = normalized.split("/");
  return segments[0].toLocaleLowerCase("en-US") === "__macosx"
    || segments.some((segment) => segment.toLocaleLowerCase("en-US") === ".ds_store");
}

function unsafeVaultSegment(segment: string) {
  if (segment === "." || segment === ".." || containsControlCharacter(segment)) {
    return true;
  }

  let decoded = segment;
  for (let pass = 0; pass < 2; pass += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) {
        break;
      }
      decoded = next;
    } catch {
      break;
    }
  }
  const decodedSlashPath = decoded.replace(/\\/g, "/");
  return containsControlCharacter(decoded)
    || decodedSlashPath.includes("/")
    || decodedSlashPath === "."
    || decodedSlashPath === "..";
}

function containsControlCharacter(value: string) {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return true;
    }
  }
  return false;
}
