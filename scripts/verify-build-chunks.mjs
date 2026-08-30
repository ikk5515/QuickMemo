import { Buffer } from "node:buffer";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { cwd } from "node:process";
import { gzipSync } from "node:zlib";

const distDirectory = join(cwd(), "dist");
const assetsDirectory = join(distDirectory, "assets");
const indexHtml = await readFile(join(distDirectory, "index.html"), "utf8");
const javascriptFiles = (await readdir(assetsDirectory))
  .filter((fileName) => fileName.endsWith(".js"));
const commonJsRuntimeFiles = javascriptFiles
  .filter((fileName) => /^commonjs-runtime-[A-Za-z0-9_-]+\.js$/u.test(fileName));

if (commonJsRuntimeFiles.length !== 1) {
  throw new Error("Expected exactly one isolated CommonJS runtime chunk.");
}

const [commonJsRuntimeFile] = commonJsRuntimeFiles;
const commonJsRuntimeSize = (await stat(join(assetsDirectory, commonJsRuntimeFile))).size;

if (commonJsRuntimeSize > 4_096) {
  throw new Error("The isolated CommonJS runtime chunk unexpectedly exceeds 4 KiB.");
}

const sourceByFile = new Map(
  await Promise.all(
    javascriptFiles.map(async (fileName) => [
      fileName,
      await readFile(join(assetsDirectory, fileName), "utf8")
    ])
  )
);

function importedChunks(fileName) {
  const source = sourceByFile.get(fileName) ?? "";
  const imports = new Set();
  const relativeJavaScriptImport = /["']\.\/([^"'?]+\.js)["']/gu;
  let match = relativeJavaScriptImport.exec(source);

  while (match) {
    if (sourceByFile.has(match[1])) {
      imports.add(match[1]);
    }
    match = relativeJavaScriptImport.exec(source);
  }

  return imports;
}

function staticallyImportedChunks(fileName) {
  const source = sourceByFile.get(fileName) ?? "";
  const imports = new Set();
  const staticRelativeJavaScriptImport = /(?:\bfrom|(?:^|[;}])import)\s*["']\.\/([^"'?]+\.js)["']/gu;
  let match = staticRelativeJavaScriptImport.exec(source);

  while (match) {
    if (sourceByFile.has(match[1])) {
      imports.add(match[1]);
    }
    match = staticRelativeJavaScriptImport.exec(source);
  }

  return imports;
}

function reachableChunks(entryFiles) {
  const visited = new Set();
  const queue = [...entryFiles];

  while (queue.length > 0) {
    const fileName = queue.shift();

    if (!fileName || visited.has(fileName)) {
      continue;
    }
    visited.add(fileName);
    importedChunks(fileName).forEach((importedFile) => queue.push(importedFile));
  }

  return visited;
}

function staticallyReachableChunks(entryFiles) {
  const visited = new Set();
  const queue = [...entryFiles];

  while (queue.length > 0) {
    const fileName = queue.shift();
    if (!fileName || visited.has(fileName)) continue;
    visited.add(fileName);
    staticallyImportedChunks(fileName).forEach((importedFile) => queue.push(importedFile));
  }

  return visited;
}

const ocrEntryFiles = javascriptFiles.filter((fileName) => {
  const source = sourceByFile.get(fileName) ?? "";
  return source.includes("createScheduler")
    && source.includes("TESSERACT_ONLY");
});

if (ocrEntryFiles.length !== 1) {
  throw new Error("Expected exactly one lazy Tesseract OCR implementation chunk.");
}

const ocrGraph = reachableChunks(ocrEntryFiles);

if (!ocrGraph.has(commonJsRuntimeFile)) {
  throw new Error("The OCR graph does not use the isolated CommonJS runtime chunk.");
}

if ([...ocrGraph].some((fileName) => fileName.startsWith("docx-preview-"))) {
  throw new Error("The OCR graph unexpectedly pulls in the DOCX preview implementation.");
}

function requireSingleChunk(prefix) {
  const matches = javascriptFiles.filter((fileName) => fileName.startsWith(`${prefix}-`));
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${prefix} chunk, received ${matches.length}.`);
  }
  return matches[0];
}

function assertChunkBudget(fileName, { rawBytes, gzipBytes }) {
  const source = sourceByFile.get(fileName) ?? "";
  const rawSize = Buffer.byteLength(source);
  const gzipSize = gzipSync(source, { level: 9 }).byteLength;

  if (rawSize > rawBytes || gzipSize > gzipBytes) {
    throw new Error(
      `${fileName} exceeds its bundle budget: ${rawSize} raw / ${gzipSize} gzip bytes.`
    );
  }
}

// Keep the initial encrypted Vault route compact on slower mobile devices.
// CodeMirror is deliberately a separate lazy chunk and has its own ceiling so
// a dependency upgrade cannot silently restore the former 900+ KiB route.
const vaultPageChunk = requireSingleChunk("VaultPage");
const codeMirrorChunk = requireSingleChunk("CodeMirrorMarkdownEditor");

assertChunkBudget(vaultPageChunk, {
  rawBytes: 400 * 1_024,
  gzipBytes: 120 * 1_024
});
assertChunkBudget(codeMirrorChunk, {
  rawBytes: 640 * 1_024,
  gzipBytes: 225 * 1_024
});

if ([...staticallyReachableChunks([codeMirrorChunk])].some((fileName) => fileName.startsWith("editor-"))) {
  throw new Error("The lazy CodeMirror graph unexpectedly pulls in the legacy TipTap/ProseMirror editor chunk.");
}

const initialAssetFiles = Array.from(indexHtml.matchAll(
  /(?:src|href)=["']\/assets\/([^"'?]+\.(?:js|css))["']/gu
)).map((match) => match[1]);

if (initialAssetFiles.some((fileName) => (
  fileName.startsWith("firebase-storage-")
  || fileName.startsWith("blobAttachments-")
))) {
  throw new Error("Attachment storage code must not be preloaded by the application shell.");
}

let initialGzipBytes = 0;

for (const fileName of new Set(initialAssetFiles)) {
  const source = await readFile(join(assetsDirectory, fileName));
  initialGzipBytes += gzipSync(source, { level: 9 }).byteLength;
}

if (initialGzipBytes > 245 * 1_024) {
  throw new Error(`The initial application shell exceeds its 245 KiB gzip budget: ${initialGzipBytes} bytes.`);
}
