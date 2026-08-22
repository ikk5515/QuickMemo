import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRootDirectory = fileURLToPath(new URL("../", import.meta.url));

const meteredDependencies = new Set([
  "@anthropic-ai/sdk",
  "@aws-sdk/client-bedrock-runtime",
  "@google/generative-ai",
  "@google/genai",
  "@mistralai/mistralai",
  "@vercel/ai",
  "cohere-ai",
  "groq-sdk",
  "mistralai",
  "openai",
  "replicate",
  "stripe"
]);

const dependencySections = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies"
];

const requiredZeroCostDefaults = new Map([
  ["FREE_TIER_MODE", "true"],
  ["SECURE_SHARE_EMAIL_ENABLED", "false"],
  ["SHARE_EMAIL_FREE_TIER_MODE", "true"]
]);

const sourcePatterns = [
  { label: "OpenAI", pattern: /(?:OPENAI_API_KEY|api\.openai\.com)/u },
  { label: "Anthropic", pattern: /(?:ANTHROPIC_API_KEY|api\.anthropic\.com)/u },
  { label: "Google generative AI", pattern: /(?:GEMINI_API_KEY|generativelanguage\.googleapis\.com)/u },
  { label: "Replicate", pattern: /(?:REPLICATE_API_TOKEN|api\.replicate\.com)/u },
  { label: "Mistral", pattern: /(?:MISTRAL_API_KEY|api\.mistral\.ai)/u },
  { label: "Groq", pattern: /(?:GROQ_API_KEY|api\.groq\.com)/u }
];
const sourceExtensions = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);

function npmAliasTarget(specifier) {
  if (typeof specifier !== "string" || !specifier.startsWith("npm:")) {
    return null;
  }

  const target = specifier.slice(4);
  if (target.startsWith("@")) {
    const slashIndex = target.indexOf("/");
    if (slashIndex < 2) {
      return null;
    }
    const versionIndex = target.indexOf("@", slashIndex + 1);
    return versionIndex < 0 ? target : target.slice(0, versionIndex);
  }

  const versionIndex = target.indexOf("@");
  return versionIndex < 0 ? target : target.slice(0, versionIndex);
}

function packageNameFromLockPath(lockPath) {
  const marker = "node_modules/";
  const markerIndex = lockPath.lastIndexOf(marker);
  return markerIndex < 0 ? null : lockPath.slice(markerIndex + marker.length);
}

function packageNameFromRegistryUrl(value) {
  if (typeof value !== "string") {
    return null;
  }

  try {
    const url = new URL(value);
    if (url.hostname !== "registry.npmjs.org" && url.hostname !== "registry.yarnpkg.com") {
      return null;
    }
    const segments = decodeURIComponent(url.pathname).split("/").filter(Boolean);
    if (segments[0]?.startsWith("@") && segments.length >= 2) {
      return `${segments[0]}/${segments[1]}`;
    }
    return segments[0] ?? null;
  } catch {
    return null;
  }
}

function dependencyEntries(manifest) {
  return dependencySections.flatMap((section) => Object.entries(manifest?.[section] ?? {}));
}

export function findForbiddenDependencies(packageJson, packageLock) {
  const forbidden = new Set();

  for (const [declaredName, specifier] of dependencyEntries(packageJson)) {
    if (meteredDependencies.has(declaredName)) {
      forbidden.add(declaredName);
    }
    const aliasTarget = npmAliasTarget(specifier);
    if (aliasTarget && meteredDependencies.has(aliasTarget)) {
      forbidden.add(`${declaredName} -> ${aliasTarget}`);
    }
  }

  for (const [lockPath, metadata] of Object.entries(packageLock?.packages ?? {})) {
    const lockName = packageNameFromLockPath(lockPath);
    if (lockName && meteredDependencies.has(lockName)) {
      forbidden.add(lockName);
    }

    for (const [declaredName, specifier] of dependencyEntries(metadata)) {
      if (meteredDependencies.has(declaredName)) {
        forbidden.add(declaredName);
      }
      const aliasTarget = npmAliasTarget(specifier);
      if (aliasTarget && meteredDependencies.has(aliasTarget)) {
        forbidden.add(`${declaredName} -> ${aliasTarget}`);
      }
    }

    const registryName = packageNameFromRegistryUrl(metadata?.resolved);
    if (registryName && meteredDependencies.has(registryName)) {
      forbidden.add(lockName && lockName !== registryName
        ? `${lockName} -> ${registryName}`
        : registryName);
    }
  }

  return [...forbidden].sort();
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await sourceFiles(path));
    } else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) {
      // Test/spec suffixes are intentionally scanned too. A production module can
      // import a file with either suffix, so filenames are not a trust boundary.
      files.push(path);
    }
  }
  return files;
}

export async function runZeroCostGuard(rootDirectory = defaultRootDirectory) {
  const packageJson = JSON.parse(await readFile(join(rootDirectory, "package.json"), "utf8"));
  const packageLock = JSON.parse(await readFile(join(rootDirectory, "package-lock.json"), "utf8"));
  const envExample = await readFile(join(rootDirectory, ".env.example"), "utf8");
  const vercelDeploymentPreflight = await readFile(
    join(rootDirectory, "scripts", "verify-vercel-hobby-plan.mjs"),
    "utf8"
  );

  if (
    /searchParams\.set\(\s*["']decrypt["']\s*,\s*["']true["']\s*\)/u.test(vercelDeploymentPreflight)
    || /[?&]decrypt=true(?:[&#"'`]|$)/u.test(vercelDeploymentPreflight)
  ) {
    throw new Error("Vercel deployment preflight must not bulk-decrypt project environment variables.");
  }

  const forbiddenInstalled = findForbiddenDependencies(packageJson, packageLock);
  if (forbiddenInstalled.length > 0) {
    throw new Error(`Metered SDK dependencies are forbidden: ${forbiddenInstalled.join(", ")}`);
  }

  const exampleValues = new Map();
  for (const rawLine of envExample.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator > 0) {
      exampleValues.set(line.slice(0, separator), line.slice(separator + 1));
    }
  }

  for (const [name, expected] of requiredZeroCostDefaults) {
    if (exampleValues.get(name) !== expected) {
      throw new Error(`${name} must default to ${expected} in .env.example.`);
    }
  }

  const runtimeFiles = [
    ...await sourceFiles(join(rootDirectory, "api")),
    ...await sourceFiles(join(rootDirectory, "src"))
  ];

  for (const path of runtimeFiles) {
    const source = await readFile(path, "utf8");
    for (const { label, pattern } of sourcePatterns) {
      if (pattern.test(source)) {
        throw new Error(`${label} metered runtime integration is forbidden: ${relative(rootDirectory, path)}`);
      }
    }
  }

  return { checkedFiles: runtimeFiles.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runZeroCostGuard();
  console.log("Zero-cost dependency and runtime guard passed.");
}
