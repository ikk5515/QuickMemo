/* global URL */

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const outputRoot = join(root, "dist", "library-ocr", "v7");
const assets = [
  {
    source: "node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js",
    target: "core/tesseract-core-lstm.wasm.js"
  },
  {
    source: "node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js",
    target: "core/tesseract-core-simd-lstm.wasm.js"
  },
  {
    source: "node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js",
    target: "core/tesseract-core-relaxedsimd-lstm.wasm.js"
  },
  {
    source: "node_modules/@tesseract.js-data/kor/4.0.0/kor.traineddata.gz",
    target: "lang/kor.traineddata.gz"
  },
  {
    source: "node_modules/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz",
    target: "lang/eng.traineddata.gz"
  }
];
const licenseAssets = [
  {
    source: "node_modules/tesseract.js/LICENSE.md",
    target: "licenses/tesseract.js-LICENSE.md"
  },
  {
    source: "node_modules/tesseract.js/dist/worker.min.js.LICENSE.txt",
    target: "licenses/tesseract-worker-LICENSE.txt"
  },
  {
    source: "node_modules/tesseract.js-core/LICENSE",
    target: "licenses/tesseract.js-core-LICENSE.txt"
  },
  {
    source: "node_modules/@tesseract.js-data/kor/README.md",
    target: "licenses/tesseract-kor-README.md"
  },
  {
    source: "node_modules/@tesseract.js-data/eng/README.md",
    target: "licenses/tesseract-eng-README.md"
  }
];

const manifestAssets = [];
const manifestLicenses = [];

for (const asset of assets) {
  const sourcePath = join(root, asset.source);
  const targetPath = join(outputRoot, asset.target);
  const bytes = await readFile(sourcePath);

  await mkdir(dirname(targetPath), { recursive: true });
  await copyFile(sourcePath, targetPath);
  manifestAssets.push({
    path: asset.target,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex")
  });
}

for (const asset of licenseAssets) {
  const sourcePath = join(root, asset.source);
  const targetPath = join(outputRoot, asset.target);
  const bytes = await readFile(sourcePath);

  await mkdir(dirname(targetPath), { recursive: true });
  await copyFile(sourcePath, targetPath);
  manifestLicenses.push({
    path: asset.target,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex")
  });
}

await writeFile(
  join(outputRoot, "asset-manifest.json"),
  `${JSON.stringify({
    schemaVersion: 1,
    tesseractVersion: "7.0.0",
    assets: manifestAssets,
    licenses: manifestLicenses
  }, null, 2)}\n`,
  "utf8"
);
