import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { cwd } from "node:process";

const assetsDirectory = join(cwd(), "dist", "assets");
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
