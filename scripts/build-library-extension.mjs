/* global console, process, URL */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { strToU8, zipSync } from "fflate";

const projectRoot = process.cwd();
const sourceDirectory = resolve(projectRoot, "public/quickmemo-capture-extension");
const defaultOutputDirectory = resolve(projectRoot, "dist/quickmemo-capture-extension");
const files = ["manifest.json", "service-worker.js", "capture.js", "README.md"];

function parseArguments(argv) {
  const parsed = {
    origin: process.env.QUICKMEMO_EXTENSION_ORIGIN ?? "",
    output: defaultOutputDirectory
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--origin" || argument === "--out") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} 값이 필요합니다.`);
      }
      if (argument === "--origin") parsed.origin = value;
      else parsed.output = isAbsolute(value) ? value : resolve(projectRoot, value);
      index += 1;
      continue;
    }
    if (argument.startsWith("--origin=")) {
      parsed.origin = argument.slice("--origin=".length);
      continue;
    }
    if (argument.startsWith("--out=")) {
      const value = argument.slice("--out=".length);
      parsed.output = isAbsolute(value) ? value : resolve(projectRoot, value);
      continue;
    }
    throw new Error(`알 수 없는 옵션입니다: ${argument}`);
  }
  return parsed;
}

function validateOrigin(value) {
  if (!value) {
    throw new Error("--origin 또는 QUICKMEMO_EXTENSION_ORIGIN으로 QuickMemo origin을 지정하세요.");
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("QuickMemo origin이 올바른 URL이 아닙니다.");
  }

  const isLocalHttp = parsed.protocol === "http:"
    && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]");
  if (parsed.protocol !== "https:" && !isLocalHttp) {
    throw new Error("운영 확장 프로그램 origin은 HTTPS여야 합니다. HTTP는 로컬 개발 주소만 허용됩니다.");
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("origin에는 경로, 쿼리, fragment 또는 사용자 인증 정보를 넣을 수 없습니다.");
  }

  return parsed.origin;
}

function assertSafeOutputDirectory(outputDirectory) {
  const relativeToProject = relative(projectRoot, outputDirectory);
  const relativeToSource = relative(sourceDirectory, outputDirectory);
  const outsideProject = relativeToProject === ".." || relativeToProject.startsWith(`..${sep}`) || isAbsolute(relativeToProject);
  const insideSource = relativeToSource === "" || (!relativeToSource.startsWith(`..${sep}`) && relativeToSource !== "..");

  if (outsideProject || outputDirectory === projectRoot || insideSource) {
    throw new Error("출력 경로는 프로젝트 내부이면서 확장 프로그램 원본 폴더 밖이어야 합니다.");
  }
}

function externalMatchPattern(origin) {
  const parsed = new URL(origin);
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

async function build() {
  const arguments_ = parseArguments(process.argv.slice(2));
  const origin = validateOrigin(arguments_.origin);
  const outputDirectory = resolve(arguments_.output);
  const archivePath = resolve(outputDirectory, "..", "quickmemo-capture-extension.zip");
  assertSafeOutputDirectory(outputDirectory);

  const replacements = new Map([
    ["__QUICKMEMO_ORIGIN__", origin],
    ["__QUICKMEMO_MATCH_PATTERN__", externalMatchPattern(origin)]
  ]);

  await rm(outputDirectory, { force: true, recursive: true });
  await rm(archivePath, { force: true });
  await mkdir(outputDirectory, { recursive: true });
  const archiveFiles = {};

  for (const file of files) {
    let content = await readFile(resolve(sourceDirectory, file), "utf8");
    for (const [placeholder, replacement] of replacements) {
      content = content.replaceAll(placeholder, replacement);
    }
    if (/__QUICKMEMO_[A-Z_]+__/.test(content)) {
      throw new Error(`${file}에 치환되지 않은 빌드 placeholder가 있습니다.`);
    }
    await writeFile(resolve(outputDirectory, file), content, "utf8");
    archiveFiles[file] = strToU8(content);
  }

  const manifest = JSON.parse(await readFile(resolve(outputDirectory, "manifest.json"), "utf8"));
  const permissions = [...(manifest.permissions ?? [])].sort();
  if (JSON.stringify(permissions) !== JSON.stringify(["activeTab", "alarms", "scripting", "storage"])) {
    throw new Error("확장 프로그램 권한은 activeTab, alarms, scripting, storage만 허용됩니다.");
  }
  if (manifest.host_permissions || manifest.content_scripts) {
    throw new Error("상시 host 권한 또는 content script는 허용되지 않습니다.");
  }

  await writeFile(archivePath, zipSync(archiveFiles, { level: 9 }));

  console.log(`QuickMemo 자료 캡처 확장 프로그램을 생성했습니다: ${relative(projectRoot, outputDirectory)}`);
  console.log(`설치용 ZIP: ${relative(projectRoot, archivePath)}`);
  console.log(`허용 origin: ${origin}`);
}

await build();
