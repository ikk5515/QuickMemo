/* global console, process */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

const requiredGitignorePatterns = [
  ".env",
  ".env.*",
  "!.env.example",
  ".firebaserc",
  "!.firebaserc.example",
  ".firebase/",
  ".vercel/",
  ".runtimeconfig.json",
  ".npmrc",
  ".yarnrc",
  ".pnpmrc",
  "serviceAccount*.json",
  "*service-account*.json",
  "*-firebase-adminsdk-*.json",
  "*credentials*.json",
  "*secret*.json",
  "*.pem",
  "*.p12",
  "*.pfx",
  "*.key",
  "*.crt",
  "*.cert",
  "GoogleService-Info.plist",
  "google-services.json"
];

const requiredVercelignorePatterns = [
  ".env",
  ".env.*",
  ".firebaserc",
  ".firebase",
  ".vercel",
  ".runtimeconfig.json",
  ".npmrc",
  ".yarnrc",
  ".pnpmrc",
  "serviceAccount*.json",
  "*service-account*.json",
  "*-firebase-adminsdk-*.json",
  "*credentials*.json",
  "*secret*.json",
  "*.pem",
  "*.p12",
  "*.pfx",
  "*.key",
  "*.crt",
  "*.cert",
  "GoogleService-Info.plist",
  "google-services.json"
];

const forbiddenTrackedPathRules = [
  {
    label: "environment file",
    pattern: /^\.env(?:$|\.)/,
    allow: /^\.env\.example$/
  },
  {
    label: "local Firebase project selection",
    pattern: /^\.firebaserc$/
  },
  {
    label: "Vercel local metadata",
    pattern: /^\.vercel(?:\/|$)/
  },
  {
    label: "Firebase local cache",
    pattern: /^\.firebase(?:\/|$)/
  },
  {
    label: "Firebase runtime config",
    pattern: /^\.runtimeconfig\.json$/
  },
  {
    label: "package-manager auth config",
    pattern: /(^|\/)\.(npmrc|yarnrc|pnpmrc)$/
  },
  {
    label: "service-account credential JSON",
    pattern: /(^|\/)(serviceAccount.*\.json|.*service-account.*\.json|.*-firebase-adminsdk-.*\.json)$/i
  },
  {
    label: "credential or secret JSON",
    pattern: /(^|\/).*(credentials?|secrets?).*\.json$/i
  },
  {
    label: "private key or certificate",
    pattern: /(^|\/).*\.(pem|p12|pfx|key|crt|cert)$/i
  },
  {
    label: "mobile Firebase app config",
    pattern: /(^|\/)(GoogleService-Info\.plist|google-services\.json)$/i
  },
  {
    label: "debug or local log",
    pattern: /(^|\/)(firebase-debug|firestore-debug|ui-debug|npm-debug|yarn-error|pnpm-debug|.*-debug).*\.log$/i
  },
  {
    label: "local emulator export",
    pattern: /(^|\/)(firestore_export|firebase-export-[^/]+|emulator-data)(?:\/|$)/i
  }
];

const errors = [];

function normalizedIgnoreLines(fileName) {
  return readFileSync(join(root, fileName), "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function assertRequiredPatterns(fileName, requiredPatterns) {
  const lines = new Set(normalizedIgnoreLines(fileName));

  for (const pattern of requiredPatterns) {
    if (!lines.has(pattern)) {
      errors.push(`${fileName} is missing required sensitive-file pattern: ${pattern}`);
    }
  }
}

function trackedFiles() {
  const output = execFileSync("git", ["ls-files", "-z"], { cwd: root });

  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

assertRequiredPatterns(".gitignore", requiredGitignorePatterns);
assertRequiredPatterns(".vercelignore", requiredVercelignorePatterns);

for (const file of trackedFiles()) {
  const matchedRule = forbiddenTrackedPathRules.find((rule) => rule.pattern.test(file) && !rule.allow?.test(file));

  if (matchedRule) {
    errors.push(`tracked ${matchedRule.label} must be removed from git: ${file}`);
  }
}

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}

console.log("Sensitive-file gitignore guard passed.");
