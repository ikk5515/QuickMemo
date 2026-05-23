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

const forbiddenContentRules = [
  {
    label: "private key block",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |)?PRIVATE KEY-----[\s\S]{80,}?-----END (?:RSA |EC |OPENSSH |)?PRIVATE KEY-----/
  },
  {
    label: "Firebase service-account JSON",
    test: (content) =>
      /"type"\s*:\s*"service_account"/.test(content) &&
      /"private_key_id"\s*:/.test(content) &&
      /"private_key"\s*:/.test(content)
  },
  {
    label: "Firebase Admin SDK service-account email",
    pattern: /firebase-adminsdk-[A-Za-z0-9_-]+@[^\s"']+\.iam\.gserviceaccount\.com/
  },
  {
    label: "non-placeholder secret env assignment",
    test: (content) =>
      hasNonPlaceholderEnvValue(content, [
        "CRON_SECRET",
        "FIREBASE_CLEANUP_PRIVATE_KEY",
        "FIREBASE_CLEANUP_SERVICE_ACCOUNT_JSON",
        "VERCEL_TOKEN",
        "VERCEL_ORG_ID",
        "VERCEL_PROJECT_ID"
      ])
  },
  {
    label: "Google API key",
    pattern: /AIza[0-9A-Za-z_-]{35}/
  },
  {
    label: "GitHub token",
    pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/
  },
  {
    label: "Slack token",
    pattern: /xox[baprs]-[A-Za-z0-9-]{20,}/
  },
  {
    label: "AWS access key",
    pattern: /AKIA[0-9A-Z]{16}/
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

function trackedFileContent(file) {
  const rawContent = readFileSync(join(root, file));

  if (rawContent.includes(0)) {
    return null;
  }

  return rawContent.toString("utf8");
}

function hasNonPlaceholderEnvValue(content, names) {
  const escapedNames = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|");
  const assignmentPattern = new RegExp(
    `^[^\\S\\r\\n]*(?:${escapedNames})[^\\S\\r\\n]*=[^\\S\\r\\n]*(.*?)[^\\S\\r\\n]*$`,
    "gmu"
  );
  let match;

  while ((match = assignmentPattern.exec(content)) !== null) {
    const value = match[1].trim().replace(/^['"]|['"]$/gu, "");

    if (!value || isPlaceholderSecretValue(value)) {
      continue;
    }

    return true;
  }

  return false;
}

function isPlaceholderSecretValue(value) {
  const normalizedValue = value.toLowerCase();

  return (
    normalizedValue === "false" ||
    normalizedValue === "true" ||
    normalizedValue.includes("...") ||
    normalizedValue.includes("your-") ||
    normalizedValue.includes("example") ||
    normalizedValue.includes("placeholder") ||
    normalizedValue.includes("at-least-16-random-characters")
  );
}

function assertSecretEnvAssignmentScanner() {
  const cronSecretName = ["CRON", "SECRET"].join("_");
  const firebasePrivateKeyName = ["FIREBASE", "CLEANUP", "PRIVATE", "KEY"].join("_");
  const vercelTokenName = ["VERCEL", "TOKEN"].join("_");

  if (!hasNonPlaceholderEnvValue(`  ${cronSecretName} = "supersecret-value"`, [cronSecretName])) {
    errors.push("secret env assignment scanner failed to detect a non-placeholder value");
  }

  if (hasNonPlaceholderEnvValue(`${cronSecretName}=\n${firebasePrivateKeyName}=`, [cronSecretName, firebasePrivateKeyName])) {
    errors.push("secret env assignment scanner rejected an empty example value");
  }

  if (hasNonPlaceholderEnvValue(`${vercelTokenName}=at-least-16-random-characters`, [vercelTokenName])) {
    errors.push("secret env assignment scanner rejected an allowed placeholder value");
  }
}

assertSecretEnvAssignmentScanner();
assertRequiredPatterns(".gitignore", requiredGitignorePatterns);
assertRequiredPatterns(".vercelignore", requiredVercelignorePatterns);

for (const file of trackedFiles()) {
  const matchedRule = forbiddenTrackedPathRules.find((rule) => rule.pattern.test(file) && !rule.allow?.test(file));

  if (matchedRule) {
    errors.push(`tracked ${matchedRule.label} must be removed from git: ${file}`);
  }

  const content = trackedFileContent(file);

  if (content === null) {
    continue;
  }

  const matchedContentRule = forbiddenContentRules.find((rule) => rule.pattern?.test(content) || rule.test?.(content, file));

  if (matchedContentRule) {
    errors.push(`tracked file appears to contain ${matchedContentRule.label}: ${file}`);
  }
}

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}

console.log("Sensitive-file gitignore guard passed.");
