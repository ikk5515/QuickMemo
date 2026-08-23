export interface ObsidianOracleFixtureManifest {
  schemaVersion: 1;
  targetObsidianVersion: "1.13.7";
  fileCount: number;
  files: Array<{ path: string; bytes: number; sha256: string }>;
  sha256: string;
}

export interface ObsidianOracleIndexEntry {
  id: string;
  path: string;
  kind: "markdown" | "canvas" | "asset";
  content?: string;
  createdAt: number;
}

export const OBSIDIAN_1_13_7_ORACLE_FILES: Readonly<Record<string, Buffer>>;
export function createObsidianOracleFixtureManifest(): ObsidianOracleFixtureManifest;
export function createObsidianOracleIndexEntries(): ObsidianOracleIndexEntry[];
