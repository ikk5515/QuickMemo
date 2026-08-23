#!/usr/bin/env node
/* global process */

import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OBSIDIAN_1_13_7_ORACLE_FILES,
  createObsidianOracleFixtureManifest
} from "../tests/e2e/obsidian-official-oracle.fixture.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
const requestedOutput = outputIndex >= 0 ? args[outputIndex + 1] : undefined;

if (outputIndex >= 0 && (!requestedOutput || requestedOutput.startsWith("--"))) {
  throw new Error("--output requires a directory path.");
}

const outputDirectory = requestedOutput
  ? resolve(requestedOutput)
  : await mkdtemp(join(tmpdir(), "quickmemo-obsidian-1.13.7-oracle-"));

if (outputDirectory === repoRoot || outputDirectory === resolve(sep)) {
  throw new Error("Refusing to materialize the fixture at a broad project/system root.");
}

await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
const existing = await readdir(outputDirectory);
if (existing.length > 0) {
  throw new Error(`Output directory must be empty: ${outputDirectory}`);
}

for (const [relativePath, bytes] of Object.entries(OBSIDIAN_1_13_7_ORACLE_FILES)) {
  if (isAbsolute(relativePath) || relativePath.split("/").includes("..")) {
    throw new Error(`Unsafe fixture path: ${relativePath}`);
  }
  const target = join(outputDirectory, relativePath);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
}

const manifest = createObsidianOracleFixtureManifest();
await writeFile(
  join(outputDirectory, ".quickmemo-obsidian-oracle-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { flag: "wx", mode: 0o600 }
);

process.stdout.write(`${JSON.stringify({ outputDirectory, manifest }, null, 2)}\n`);
