/* global console, process */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const token = (...parts) => parts.join("");
const forbiddenSourcePatterns = [
  new RegExp(token("firebase", "-", "admin")),
  new RegExp(token("firebase", "-", "functions")),
  new RegExp(token("\\b", "on", "Call", "\\b")),
  new RegExp(token("https", "Callable")),
  new RegExp(token("get", "Functions")),
  new RegExp(token("firebase", "\\/", "functions")),
  new RegExp(token("cloud", "functions", "\\.net"))
];
const scanRoots = [
  ".github/workflows",
  "api",
  "src",
  "tests"
];
const rootFiles = [
  "firebase.json",
  "package.json",
  "firestore.rules"
];
const sourceExtensions = new Set([".cjs", ".js", ".json", ".mjs", ".ts", ".tsx", ".yml", ".yaml"]);
const errors = [];

const collectFiles = (path) => {
  if (!existsSync(path)) {
    return [];
  }

  const stat = statSync(path);

  if (stat.isFile()) {
    return [path];
  }

  if (!stat.isDirectory()) {
    return [];
  }

  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const childPath = join(path, entry.name);

    if (entry.isDirectory()) {
      return collectFiles(childPath);
    }

    return [childPath];
  });
};

const shouldScan = (path) => {
  return [...sourceExtensions].some((extension) => path.endsWith(extension));
};

if (existsSync(join(root, "functions"))) {
  errors.push("The functions/ backend directory must not be present in the Functions-free build.");
}

const sourceFiles = [
  ...rootFiles.map((file) => join(root, file)),
  ...scanRoots.flatMap((directory) => collectFiles(join(root, directory)))
].filter(shouldScan);

for (const path of sourceFiles) {
  const content = readFileSync(path, "utf8");
  const matchedPattern = forbiddenSourcePatterns.find((pattern) => pattern.test(content));

  if (matchedPattern) {
    errors.push(`${path.slice(root.length + 1)} contains forbidden Functions/Admin SDK reference: ${matchedPattern}`);
  }
}

const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const staleFunctionsPackage = lock.packages?.functions;
const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const rootDependencies = {
  ...rootPackage.dependencies,
  ...rootPackage.devDependencies
};

if (staleFunctionsPackage) {
  errors.push("package-lock.json still contains the stale functions workspace package.");
}

for (const packageName of [token("firebase", "-", "admin"), token("firebase", "-", "functions")]) {
  if (rootDependencies[packageName]) {
    errors.push(`package.json must not depend on ${packageName} in the Functions-free build.`);
  }

  if (lock.packages?.[`node_modules/${packageName}`]) {
    errors.push(`package-lock.json must not contain node_modules/${packageName} in the Functions-free build.`);
  }
}

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}

console.log("Functions-free security guard passed.");
