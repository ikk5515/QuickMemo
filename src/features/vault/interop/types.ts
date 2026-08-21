export type ObsidianVaultEntryKind = "markdown" | "canvas" | "base" | "asset";

export type VaultDuplicatePolicy = "error" | "keep-first" | "rename";

export type VaultInteropErrorCode =
  | "archive-too-large"
  | "canvas-invalid"
  | "duplicate-path"
  | "entry-too-large"
  | "invalid-content"
  | "invalid-path"
  | "path-conflict"
  | "too-many-entries"
  | "total-size-exceeded"
  | "unsupported-compression"
  | "zip-invalid";

export class VaultInteropError extends Error {
  readonly code: VaultInteropErrorCode;

  constructor(code: VaultInteropErrorCode, message?: string) {
    super(message ?? code);
    this.name = "VaultInteropError";
    this.code = code;
  }
}

export interface ObsidianVaultSourceEntry {
  /** A vault-relative path. Storage IDs must never be used as paths. */
  path: string;
  kind?: ObsidianVaultEntryKind;
  content: string | Uint8Array;
  mimeType?: string;
}

export interface ObsidianVaultManifestEntry {
  path: string;
  kind: ObsidianVaultEntryKind;
  bytes: Uint8Array;
  /** Present only for Markdown, Canvas, and Base entries. */
  text?: string;
  mimeType: string;
}

export interface ObsidianVaultSkippedEntry {
  path: string;
  reason: "duplicate" | "obsidian-config" | "system-metadata";
}

export interface ObsidianVaultManifest {
  entries: ObsidianVaultManifestEntry[];
  folders: string[];
  skipped: ObsidianVaultSkippedEntry[];
  totalBytes: number;
  warnings: string[];
}

export interface VaultInteropLimits {
  maxArchiveBytes: number;
  maxCompressionRatio: number;
  maxEntries: number;
  maxEntryBytes: number;
  maxPathBytes: number;
  maxTextEntryBytes: number;
  maxTotalBytes: number;
  minRatioCheckBytes: number;
}

export const DEFAULT_VAULT_INTEROP_LIMITS: Readonly<VaultInteropLimits> = Object.freeze({
  maxArchiveBytes: 128 * 1024 * 1024,
  maxCompressionRatio: 150,
  maxEntries: 10_000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxPathBytes: 1_024,
  maxTextEntryBytes: 4 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  minRatioCheckBytes: 64 * 1024
});

export interface ObsidianManifestOptions {
  duplicatePolicy?: VaultDuplicatePolicy;
  folders?: string[];
  includeObsidianConfig?: boolean;
  limits?: Partial<VaultInteropLimits>;
  stripCommonRoot?: boolean;
  validateCanvas?: boolean;
}

export interface ObsidianZipOptions extends ObsidianManifestOptions {
  compressionLevel?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
}
