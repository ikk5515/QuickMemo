import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = fileURLToPath(new URL("../", import.meta.url));
const packageJson = JSON.parse(await readFile(join(rootDirectory, "package.json"), "utf8"));
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

const installedDependencies = {
  ...(packageJson.dependencies ?? {}),
  ...(packageJson.devDependencies ?? {}),
  ...(packageJson.optionalDependencies ?? {})
};
const forbiddenInstalled = Object.keys(installedDependencies)
  .filter((name) => meteredDependencies.has(name))
  .sort();

if (forbiddenInstalled.length > 0) {
  throw new Error(`Metered SDK dependencies are forbidden: ${forbiddenInstalled.join(", ")}`);
}

const requiredZeroCostDefaults = new Map([
  ["FREE_TIER_MODE", "true"],
  ["SECURE_SHARE_EMAIL_ENABLED", "false"],
  ["SHARE_EMAIL_FREE_TIER_MODE", "true"]
]);
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

const sourcePatterns = [
  { label: "OpenAI", pattern: /(?:OPENAI_API_KEY|api\.openai\.com)/u },
  { label: "Anthropic", pattern: /(?:ANTHROPIC_API_KEY|api\.anthropic\.com)/u },
  { label: "Google generative AI", pattern: /(?:GEMINI_API_KEY|generativelanguage\.googleapis\.com)/u },
  { label: "Replicate", pattern: /(?:REPLICATE_API_TOKEN|api\.replicate\.com)/u },
  { label: "Mistral", pattern: /(?:MISTRAL_API_KEY|api\.mistral\.ai)/u },
  { label: "Groq", pattern: /(?:GROQ_API_KEY|api\.groq\.com)/u }
];
const sourceExtensions = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await sourceFiles(path));
    } else if (
      entry.isFile()
      && sourceExtensions.has(extname(entry.name))
      && !/\.(?:test|spec)\.[^.]+$/u.test(entry.name)
    ) {
      files.push(path);
    }
  }
  return files;
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

console.log("Zero-cost dependency and runtime guard passed.");
