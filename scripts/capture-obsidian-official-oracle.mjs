#!/usr/bin/env node
/* global Event, HTMLInputElement, HTMLElement, URL, console, document, process */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createObsidianOracleFixtureManifest } from "../tests/e2e/obsidian-official-oracle.fixture.mjs";

const targetVersion = "1.13.7";
const exactAsarSha256 = "a52a7daf1e2460bae03de80f2816604bd16a56cd374fbe5ce8d1a9ef5604059d";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

function argument(name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function requiredArgument(name) {
  const value = argument(name);
  if (!value) throw new Error(`Missing required ${name} argument.`);
  return value;
}

const appPath = resolve(requiredArgument("--app"));
const asarPath = resolve(requiredArgument("--asar"));
const fixturePath = resolve(requiredArgument("--fixture"));
const capturePath = resolve(requiredArgument("--output"));
const evidenceDirectory = dirname(capturePath);
const cdpUrl = argument("--cdp-url") ?? "http://127.0.0.1:9229";
const parsedCdpUrl = new URL(cdpUrl);

if (parsedCdpUrl.protocol !== "http:"
  || !["127.0.0.1", "localhost"].includes(parsedCdpUrl.hostname)) {
  throw new Error("--cdp-url must use loopback HTTP; remote browser capture is refused.");
}
if (!existsSync(appPath) || !(await stat(appPath)).isDirectory()) {
  throw new Error(`Official app directory is unavailable: ${appPath}`);
}
if (!existsSync(asarPath) || !(await stat(asarPath)).isFile()) {
  throw new Error(`Exact-version ASAR is unavailable: ${asarPath}`);
}
if (basename(asarPath) !== `obsidian-${targetVersion}.asar`) {
  throw new Error(`ASAR must retain the exact obsidian-${targetVersion}.asar filename.`);
}
if (!existsSync(fixturePath) || !(await stat(fixturePath)).isDirectory()) {
  throw new Error(`Materialized fixture directory is unavailable: ${fixturePath}`);
}
if (capturePath === repoRoot || capturePath === resolve(sep) || evidenceDirectory === repoRoot) {
  throw new Error("Refusing to write capture evidence at a broad project/system root.");
}
if (existsSync(capturePath)) throw new Error(`Capture output already exists: ${capturePath}`);
await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });

const evidenceFiles = new Map([
  ["global-graph", "global-graph.png"],
  ["backlinks", "backlinks.png"],
  ["tags", "tags.png"],
  ["canvas", "canvas.png"]
]);
for (const file of evidenceFiles.values()) {
  const path = resolve(evidenceDirectory, file);
  if (existsSync(path)) throw new Error(`Evidence output already exists: ${path}`);
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

if (await sha256(asarPath) !== exactAsarSha256) {
  throw new Error(`The ASAR hash is not official Obsidian ${targetVersion}.`);
}

const manifest = createObsidianOracleFixtureManifest();
const materializedManifestPath = resolve(fixturePath, ".quickmemo-obsidian-oracle-manifest.json");
if (!existsSync(materializedManifestPath)) {
  throw new Error("The fixture provenance manifest is missing.");
}
const materializedManifest = JSON.parse(await readFile(materializedManifestPath, "utf8"));
if (materializedManifest.fileCount !== manifest.fileCount
  || materializedManifest.sha256 !== manifest.sha256) {
  throw new Error("The materialized fixture manifest does not match the pinned fixture.");
}
for (const file of manifest.files) {
  if (isAbsolute(file.path) || file.path.split("/").includes("..")) {
    throw new Error(`Unsafe fixture manifest path: ${file.path}`);
  }
  const materializedPath = resolve(fixturePath, file.path);
  if (!existsSync(materializedPath)) throw new Error(`Fixture file is missing: ${file.path}`);
  const materializedStat = await stat(materializedPath);
  if (!materializedStat.isFile()
    || materializedStat.size !== file.bytes
    || await sha256(materializedPath) !== file.sha256) {
    throw new Error(`Fixture file does not match its manifest: ${file.path}`);
  }
}

function plist(key) {
  const result = spawnSync("/usr/libexec/PlistBuddy", [
    "-c",
    `Print :${key}`,
    `${appPath}/Contents/Info.plist`
  ], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

const bundleIdentifier = plist("CFBundleIdentifier");
const bundleVersion = plist("CFBundleVersion");
const shellVersion = plist("CFBundleShortVersionString");
if (bundleIdentifier !== "md.obsidian"
  || bundleVersion !== targetVersion
  || shellVersion !== targetVersion) {
  throw new Error("The selected application is not official Obsidian 1.13.7.");
}
const signature = spawnSync("codesign", ["--verify", "--deep", "--strict", appPath]);
if (signature.status !== 0) {
  throw new Error("Official app signature validation failed before capture.");
}

function canonicalGraph(snapshot, resolvedLinks, unresolvedLinks) {
  const typeById = new Map(snapshot.nodes.map((node) => [node.id, node.type]));
  const key = (id) => {
    const type = typeById.get(id);
    return type === "unresolved" ? `?${id}` : id;
  };
  return {
    nodes: snapshot.nodes.map((node) => key(node.id)).sort(),
    edges: snapshot.links.map(({ source, target }) => ({
      kind: typeById.get(target) === "tag" ? "tag" : "internal-link",
      occurrenceCount: typeById.get(target) === "tag"
        ? 1
        : (typeById.get(target) === "unresolved"
          ? unresolvedLinks[source]?.[target]
          : resolvedLinks[source]?.[target]) ?? 1,
      source: key(source),
      target: key(target)
    })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  };
}

const browser = await chromium.connectOverCDP(cdpUrl);
const page = browser.contexts().flatMap((context) => context.pages())
  .find((candidate) => candidate.url() === "app://obsidian.md/index.html");
if (!page) throw new Error("Official Obsidian renderer target is unavailable.");

const identity = await page.evaluate(() => ({
  title: document.title,
  vaultBasePath: globalThis.app.vault.adapter.basePath
}));
if (!identity.title.includes(`Obsidian ${targetVersion}`)) {
  throw new Error(`Unexpected official title: ${identity.title}`);
}
if (resolve(identity.vaultBasePath) !== fixturePath) {
  throw new Error(`Refusing to capture a non-fixture vault: ${identity.vaultBasePath}`);
}

async function ensureGlobalGraph() {
  await page.evaluate(async () => {
    const app = globalThis.app;
    if (app.workspace.getLeavesOfType("graph").length === 0) {
      await app.commands.executeCommandById("graph:open");
    }
    const leaf = app.workspace.getLeavesOfType("graph")[0];
    app.workspace.setActiveLeaf(leaf, { focus: true });
  });
  await page.waitForFunction(() => {
    const view = globalThis.app.workspace.getLeavesOfType("graph")[0]?.view;
    return Array.isArray(view?.renderer?.nodes) && view.renderer.nodes.length > 0;
  });
}

async function resetGlobalGraph() {
  await ensureGlobalGraph();
  await page.evaluate(() => {
    const view = globalThis.app.workspace.getLeavesOfType("graph")[0].view;
    view.dataEngine.controlsEl.querySelector(".graph-controls-button.mod-reset")?.click();
  });
  await page.waitForFunction(() => {
    const options = globalThis.app.workspace.getLeavesOfType("graph")[0].view.dataEngine.options;
    return options.showAttachments === false
      && options.showTags === false
      && options.hideUnresolved === false
      && options.showOrphans === true;
  });
  await page.waitForTimeout(600);
}

async function toggleGlobal(toggleIndex) {
  await page.evaluate((requestedIndex) => {
    const view = globalThis.app.workspace.getLeavesOfType("graph")[0].view;
    const section = view.dataEngine.controlsEl.querySelector(".graph-control-section.mod-filter");
    if (section?.classList.contains("is-collapsed")) {
      section.querySelector(".tree-item-self")?.click();
    }
    const toggles = [...section.querySelectorAll(".setting-item.mod-toggle label.checkbox-container")];
    const label = toggles[requestedIndex];
    if (!(label instanceof HTMLElement)) {
      throw new Error(`Missing pinned Graph toggle at index ${requestedIndex}`);
    }
    label.click();
  }, toggleIndex);
  await page.waitForTimeout(700);
}

async function graphRenderer(viewType, engineProperty) {
  return page.evaluate(({ viewTypeValue, enginePropertyValue }) => {
    const view = globalThis.app.workspace.getLeavesOfType(viewTypeValue)[0].view;
    return {
      links: view.renderer.links.map((link) => ({
        source: link.source.id,
        target: link.target.id
      })),
      nodes: view.renderer.nodes.map((node) => ({ id: node.id, type: node.type ?? "" })),
      options: { ...view[enginePropertyValue].options }
    };
  }, { viewTypeValue: viewType, enginePropertyValue: engineProperty });
}

await resetGlobalGraph();
const defaultGlobalRaw = await graphRenderer("graph", "dataEngine");
await page.screenshot({ path: resolve(evidenceDirectory, evidenceFiles.get("global-graph")) });

// In Obsidian 1.13.7 the first filter toggle is Tags and the second is Attachments.
await toggleGlobal(1);
const withAttachmentsRaw = await graphRenderer("graph", "dataEngine");

await toggleGlobal(1);
await toggleGlobal(0);
const withTagsRaw = await graphRenderer("graph", "dataEngine");

await page.evaluate(async () => {
  const app = globalThis.app;
  const file = app.vault.getAbstractFileByPath("Projects/Hub.md");
  const leaf = app.workspace.getLeaf("tab");
  await leaf.openFile(file);
  app.workspace.setActiveLeaf(leaf, { focus: true });
  if (app.workspace.getLeavesOfType("localgraph").length === 0) {
    await app.commands.executeCommandById("graph:open-local");
  }
});
await page.waitForFunction(() => (
  globalThis.app.workspace.getLeavesOfType("localgraph")[0]?.view?.file?.path === "Projects/Hub.md"
));
await page.evaluate(() => {
  const view = globalThis.app.workspace.getLeavesOfType("localgraph")[0].view;
  view.engine.controlsEl.querySelector(".graph-controls-button.mod-reset")?.click();
  const section = view.engine.controlsEl.querySelector(".graph-control-section.mod-filter");
  if (section?.classList.contains("is-collapsed")) {
    section.querySelector(".tree-item-self")?.click();
  }
  const slider = section?.querySelector(".setting-item.mod-local-jumps input[type=range]");
  if (!(slider instanceof HTMLInputElement)) throw new Error("Local Graph depth slider is absent.");
  slider.value = "2";
  slider.dispatchEvent(new Event("input", { bubbles: true }));
  slider.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.waitForFunction(() => {
  const view = globalThis.app.workspace.getLeavesOfType("localgraph")[0].view;
  return view.engine.options.localJumps === 2
    && view.engine.options.localForelinks === true
    && view.engine.options.localBacklinks === true
    && view.engine.options.localInterlinks === false;
});
await page.waitForTimeout(700);
const localHubDepthTwoRaw = await graphRenderer("localgraph", "engine");

const officialMetadata = await page.evaluate(() => {
  const app = globalThis.app;
  const markdownFiles = app.vault.getMarkdownFiles().slice()
    .sort((left, right) => left.path.localeCompare(right.path));
  const canvasIndex = app.internalPlugins.plugins.canvas.instance.index.index;
  const occurrences = [];
  const tagOccurrences = [];

  const fragmentFromLink = (link) => {
    const hash = link.indexOf("#");
    if (hash < 0) return null;
    const value = link.slice(hash + 1);
    if (!value) return null;
    return value.startsWith("^")
      ? { kind: "block", value: value.slice(1) }
      : { kind: "heading", value };
  };
  const targetFromLink = (link) => {
    const hash = link.indexOf("#");
    return hash < 0 ? link : link.slice(0, hash);
  };
  const unresolvedKey = (sourcePath, link, raw) => {
    const target = targetFromLink(link);
    if (!target) return sourcePath;
    const markdownSyntax = raw.startsWith("[") && !raw.startsWith("[[");
    if (markdownSyntax || target.startsWith("./") || target.startsWith("../")) {
      const base = sourcePath.slice(0, Math.max(0, sourcePath.lastIndexOf("/")));
      const parts = `${base}/${target}`.split("/");
      const normalized = [];
      for (const part of parts) {
        if (!part || part === ".") continue;
        if (part === "..") normalized.pop();
        else normalized.push(part);
      }
      return normalized.join("/");
    }
    return target.replace(/^\/+/, "");
  };
  const addOccurrence = (sourcePath, item, embedded, rawOverride) => {
    const raw = rawOverride ?? item.original;
    const target = targetFromLink(item.link);
    const destinations = app.metadataCache.getLinkpathDest(target, sourcePath)
      .map((file) => file.path);
    const isOfficiallyUnresolved = Boolean(
      target && Object.hasOwn(app.metadataCache.unresolvedLinks[sourcePath] ?? {}, target)
    );
    const first = isOfficiallyUnresolved ? null : destinations[0] ?? null;
    occurrences.push({
      candidatePaths: destinations.slice().sort(),
      embedded,
      fragment: fragmentFromLink(item.link),
      raw,
      sourcePath,
      status: first ? "resolved" : "unresolved",
      targetPath: first,
      unresolvedKey: unresolvedKey(sourcePath, item.link, raw)
    });
  };

  for (const file of markdownFiles) {
    const cache = app.metadataCache.getFileCache(file) ?? {};
    for (const item of cache.links ?? []) addOccurrence(file.path, item, false);
    for (const item of cache.embeds ?? []) addOccurrence(file.path, item, true);

    const frontmatterTags = Array.isArray(cache.frontmatter?.tags)
      ? cache.frontmatter.tags
      : typeof cache.frontmatter?.tags === "string"
        ? [cache.frontmatter.tags]
        : [];
    for (const value of frontmatterTags) {
      if (typeof value === "string") tagOccurrences.push({ path: file.path, tag: value });
    }
    for (const item of cache.tags ?? []) {
      tagOccurrences.push({ path: file.path, tag: item.tag.replace(/^#/, "") });
    }
  }

  for (const [sourcePath, entry] of Object.entries(canvasIndex)) {
    for (const item of entry.embeds ?? []) {
      addOccurrence(sourcePath, { link: item.file, original: item.file }, true, item.file);
    }
    for (const cache of Object.values(entry.caches ?? {})) {
      for (const item of cache.links ?? []) addOccurrence(sourcePath, item, false);
      for (const item of cache.embeds ?? []) addOccurrence(sourcePath, item, true);
    }
  }

  const tags = new Map();
  for (const { path, tag } of tagOccurrences) {
    const normalized = tag.replace(/^#/, "");
    const key = normalized.toLocaleLowerCase();
    const existing = tags.get(key);
    if (existing) {
      if (!existing.entryPaths.includes(path)) existing.entryPaths.push(path);
    } else {
      const segments = normalized.split("/");
      tags.set(key, {
        displayName: normalized,
        entryPaths: [path],
        key,
        parentKeys: Array.from({ length: Math.max(0, segments.length - 1) }, (_, index) => (
          segments.slice(0, index + 1).join("/").toLocaleLowerCase()
        ))
      });
    }
  }

  return {
    outgoing: occurrences.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    resolvedLinks: JSON.parse(JSON.stringify(app.metadataCache.resolvedLinks)),
    tags: [...tags.values()].map((tag) => ({
      ...tag,
      entryPaths: tag.entryPaths.slice().sort(),
      parentKeys: tag.parentKeys.slice().sort()
    })).sort((left, right) => left.key.localeCompare(right.key)),
    unresolvedLinks: JSON.parse(JSON.stringify(app.metadataCache.unresolvedLinks))
  };
});

await page.evaluate(async () => {
  const app = globalThis.app;
  const hub = app.vault.getAbstractFileByPath("Projects/Hub.md");
  const leaf = app.workspace.getLeaf("tab");
  await leaf.openFile(hub);
  app.workspace.setActiveLeaf(leaf, { focus: true });
  await app.commands.executeCommandById("backlink:open");
});
await page.waitForTimeout(600);
await page.screenshot({ path: resolve(evidenceDirectory, evidenceFiles.get("backlinks")) });

await page.evaluate(async () => {
  await globalThis.app.commands.executeCommandById("tag-pane:open");
});
await page.waitForTimeout(600);
await page.screenshot({ path: resolve(evidenceDirectory, evidenceFiles.get("tags")) });

await page.evaluate(async () => {
  const app = globalThis.app;
  const canvas = app.vault.getAbstractFileByPath("Canvas/Research.canvas");
  const leaf = app.workspace.getLeaf("tab");
  await leaf.openFile(canvas);
  app.workspace.setActiveLeaf(leaf, { focus: true });
});
await page.waitForFunction(() => globalThis.app.workspace.getActiveFile()?.path === "Canvas/Research.canvas");
await page.waitForTimeout(800);
await page.screenshot({ path: resolve(evidenceDirectory, evidenceFiles.get("canvas")) });

const evidence = [];
for (const [kind, file] of evidenceFiles) {
  evidence.push({
    kind,
    path: file,
    sha256: await sha256(resolve(evidenceDirectory, file))
  });
}

const capture = {
  schemaVersion: 1,
  captureKind: "obsidian-official-interactive-v1",
  app: {
    asarSha256: await sha256(asarPath),
    bundleIdentifier,
    bundleVersion,
    displayedVersion: targetVersion,
    shellVersion,
    signatureVerified: true
  },
  fixture: { fileCount: manifest.fileCount, sha256: manifest.sha256 },
  evidence,
  oracle: {
    graph: {
      defaultGlobal: canonicalGraph(
        defaultGlobalRaw,
        officialMetadata.resolvedLinks,
        officialMetadata.unresolvedLinks
      ),
      withAttachments: canonicalGraph(
        withAttachmentsRaw,
        officialMetadata.resolvedLinks,
        officialMetadata.unresolvedLinks
      ),
      withTags: canonicalGraph(
        withTagsRaw,
        officialMetadata.resolvedLinks,
        officialMetadata.unresolvedLinks
      ),
      localHubDepthTwo: canonicalGraph(
        localHubDepthTwoRaw,
        officialMetadata.resolvedLinks,
        officialMetadata.unresolvedLinks
      )
    },
    outgoing: officialMetadata.outgoing,
    tags: officialMetadata.tags
  }
};

await writeFile(capturePath, `${JSON.stringify(capture, null, 2)}\n`, {
  flag: "wx",
  mode: 0o600
});
console.log(JSON.stringify({ capturePath, evidence, graphCounts: Object.fromEntries(
  Object.entries(capture.oracle.graph).map(([key, value]) => [key, {
    nodes: value.nodes.length,
    edges: value.edges.length
  }])
), outgoing: capture.oracle.outgoing.length, tags: capture.oracle.tags.length }, null, 2));
process.exit(0);
