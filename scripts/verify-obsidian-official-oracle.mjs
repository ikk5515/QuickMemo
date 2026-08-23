#!/usr/bin/env node
/* global Buffer, process */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createObsidianOracleFixtureManifest } from "../tests/e2e/obsidian-official-oracle.fixture.mjs";

const targetVersion = "1.13.7";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

function argument(name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function command(commandName, commandArgs) {
  return spawnSync(commandName, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function plistValue(appPath, key) {
  const result = command("/usr/libexec/PlistBuddy", [
    "-c",
    `Print :${key}`,
    join(appPath, "Contents", "Info.plist")
  ]);
  return result.status === 0 ? result.stdout.trim() : "";
}

async function sha256(path) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

async function isBoundedScreenshot(path) {
  const file = await stat(path);
  if (!file.isFile() || file.size <= 0 || file.size > 20 * 1024 * 1024) return false;
  const bytes = await readFile(path);
  const isPng = bytes.subarray(0, 8).equals(Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
  ]));
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return isPng || isJpeg;
}

async function installerAssets() {
  const roots = [join(homedir(), "Downloads"), join(homedir(), "Library", "Caches", "Homebrew", "downloads")];
  const candidates = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const name of await readdir(root)) {
      if (/obsidian.*\.(?:dmg|zip)$/iu.test(name)) candidates.push(join(root, name));
    }
  }
  return candidates.sort();
}

function fail(reason, details = {}) {
  const result = {
    accepted: false,
    gate: "official-obsidian-golden",
    reason,
    targetVersion,
    ...details,
    requirements: [
      "A code-signed official Obsidian macOS application with bundle id md.obsidian.",
      `The exact downloaded Obsidian ${targetVersion} ASAR in ~/Library/Application Support/obsidian.`,
      "A capture JSON produced from the materialized clean fixture, plus hashed Graph, Backlinks, Tags, and Canvas screenshots.",
      "The capture must match the installed ASAR hash and the fixture manifest hash; project-local expected values are not accepted as an official oracle."
    ]
  };
  process.stderr.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(1);
}

const requestedApp = argument("--app") ?? process.env.OBSIDIAN_APP_PATH;
const appCandidates = [
  requestedApp,
  "/Applications/Obsidian.app",
  join(homedir(), "Applications", "Obsidian.app")
].filter(Boolean).map((path) => resolve(path));
const appPath = appCandidates.find((path) => existsSync(path));

if (!appPath) {
  fail("Obsidian.app was not found; no official application was available for capture.", {
    checkedApplicationPaths: [...new Set(appCandidates)],
    installableAssetsFound: await installerAssets()
  });
}

if ((await stat(appPath)).isDirectory() === false) {
  fail("The selected Obsidian application path is not an application directory.", { appPath });
}

const bundleIdentifier = plistValue(appPath, "CFBundleIdentifier");
const bundleVersion = plistValue(appPath, "CFBundleVersion");
const shellVersion = plistValue(appPath, "CFBundleShortVersionString");
const signature = command("codesign", ["--verify", "--deep", "--strict", appPath]);

if (bundleIdentifier !== "md.obsidian" || signature.status !== 0) {
  fail("The application did not pass the official bundle/signature prerequisite.", {
    appPath,
    bundleIdentifier,
    signatureStatus: signature.status,
    signatureError: signature.stderr.trim()
  });
}

const supportDirectory = argument("--support-dir")
  ?? process.env.OBSIDIAN_SUPPORT_DIR
  ?? join(homedir(), "Library", "Application Support", "obsidian");
const exactAsarCandidates = [
  join(supportDirectory, `obsidian-${targetVersion}.asar`),
  join(appPath, "Contents", "Resources", `obsidian-${targetVersion}.asar`)
];
const asarPath = exactAsarCandidates.find((path) => existsSync(path));

if (!asarPath) {
  fail(`The exact Obsidian ${targetVersion} runtime ASAR was not found.`, {
    appPath,
    bundleVersion,
    checkedAsarPaths: exactAsarCandidates,
    shellVersion
  });
}

const captureValue = argument("--capture") ?? process.env.OBSIDIAN_OFFICIAL_CAPTURE_PATH;
if (!captureValue) {
  fail("No official capture JSON was supplied.", {
    appPath,
    asarPath,
    invocation: "node scripts/verify-obsidian-official-oracle.mjs --capture /absolute/path/capture.json"
  });
}
const capturePath = resolve(captureValue);
if (!existsSync(capturePath)) fail("The supplied capture JSON does not exist.", { capturePath });

let capture;
try {
  capture = JSON.parse(await readFile(capturePath, "utf8"));
} catch (error) {
  fail("The supplied capture is not valid JSON.", {
    capturePath,
    error: error instanceof Error ? error.message : String(error)
  });
}

const manifest = createObsidianOracleFixtureManifest();
const asarSha256 = await sha256(asarPath);
const expectedApp = {
  asarSha256,
  bundleIdentifier,
  bundleVersion,
  displayedVersion: targetVersion,
  shellVersion,
  signatureVerified: true
};

const appMatches = capture?.app
  && Object.entries(expectedApp).every(([key, value]) => capture.app[key] === value);

if (capture?.schemaVersion !== 1
  || capture?.captureKind !== "obsidian-official-interactive-v1"
  || !appMatches
  || capture?.fixture?.fileCount !== manifest.fileCount
  || capture?.fixture?.sha256 !== manifest.sha256
  || typeof capture?.oracle !== "object"
  || capture.oracle === null) {
  fail("The capture provenance, application hash, fixture hash, or oracle payload is invalid.", {
    capturePath,
    expectedApp,
    expectedFixture: { fileCount: manifest.fileCount, sha256: manifest.sha256 }
  });
}

const requiredEvidenceKinds = ["backlinks", "canvas", "global-graph", "tags"];
const evidence = Array.isArray(capture.evidence) ? capture.evidence : [];
const captureDirectory = dirname(capturePath);

for (const kind of requiredEvidenceKinds) {
  const item = evidence.find((candidate) => candidate?.kind === kind);
  if (!item || typeof item.path !== "string" || typeof item.sha256 !== "string") {
    fail(`The capture is missing required ${kind} screenshot evidence.`, { capturePath });
  }
  const evidencePath = isAbsolute(item.path) ? item.path : resolve(captureDirectory, item.path);
  if (!existsSync(evidencePath)
    || !await isBoundedScreenshot(evidencePath)
    || await sha256(evidencePath) !== item.sha256) {
    fail(`The ${kind} screenshot is missing or does not match its hash.`, {
      evidencePath,
      file: basename(evidencePath)
    });
  }
}

const vitest = join(repoRoot, "node_modules", ".bin", "vitest");
const comparison = spawnSync(vitest, [
  "run",
  "--config",
  "tests/e2e/obsidian-official-oracle.vitest.config.ts"
], {
  cwd: repoRoot,
  encoding: "utf8",
  env: { ...process.env, OBSIDIAN_OFFICIAL_CAPTURE_PATH: capturePath },
  stdio: "inherit"
});

if (comparison.status !== 0) {
  fail("QuickMemo does not match the validated official Obsidian capture.", {
    capturePath,
    comparisonStatus: comparison.status
  });
}

process.stdout.write(`${JSON.stringify({
  accepted: true,
  app: expectedApp,
  capturePath,
  fixture: { fileCount: manifest.fileCount, sha256: manifest.sha256 },
  gate: "official-obsidian-golden"
}, null, 2)}\n`);
