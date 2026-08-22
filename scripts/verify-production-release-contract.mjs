/* global console, process */

import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PRODUCTION_FIREBASE_PROJECT_ID = "quickmemo-a95ba";
export const FIRESTORE_RELEASE_CONTRACT_FILES = Object.freeze([
  "firestore.rules",
  "firestore.indexes.json"
]);

const releaseContractDomain = "quickmemo/firestore-release-contract/v1";
const currentModulePath = (() => {
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    // Vitest transforms ESM modules through a non-file URL. The test runner is
    // launched from the repository root and always passes an explicit root for
    // digest fixtures, so this fallback is deterministic without browser data.
    return null;
  }
})();
const repositoryRoot = currentModulePath
  ? resolve(dirname(currentModulePath), "..")
  : resolve(process.cwd());
const sha256Pattern = /^[0-9a-f]{64}$/u;

export async function computeFirestoreReleaseContractSha256(rootDirectory = repositoryRoot) {
  const digest = createHash("sha256");
  digest.update(`${releaseContractDomain}\0`, "utf8");

  for (const relativePath of FIRESTORE_RELEASE_CONTRACT_FILES) {
    const bytes = await readFile(resolve(rootDirectory, relativePath));
    digest.update(`${relativePath}\0${bytes.byteLength}\0`, "utf8");
    digest.update(bytes);
    digest.update("\0", "utf8");
  }

  return digest.digest("hex");
}

export function sparkReleaseAttestation(
  firestoreContractSha256,
  projectId = PRODUCTION_FIREBASE_PROJECT_ID
) {
  return `spark:${projectId}:${firestoreContractSha256}`;
}

export function assertProductionReleaseContract(input, currentFirestoreContractSha256) {
  if (!sha256Pattern.test(currentFirestoreContractSha256)) {
    throw new Error("Production release is blocked because the local Firestore contract digest is invalid.");
  }

  if (
    typeof input?.deployedFirestoreContractSha256 !== "string"
    || input.deployedFirestoreContractSha256 !== currentFirestoreContractSha256
  ) {
    throw new Error("Production release is blocked because the deployed Firestore contract is not attested for this commit.");
  }

  if (
    typeof input?.sparkAttestation !== "string"
    || input.sparkAttestation !== sparkReleaseAttestation(currentFirestoreContractSha256)
  ) {
    throw new Error("Production release is blocked because the Spark plan is not attested for this Firestore contract.");
  }

  if (input?.vaultReleaseState !== "enabled" && input?.vaultReleaseState !== "disabled") {
    throw new Error("Production release is blocked because the Vault release state is not explicit.");
  }

  return {
    vaultEnabled: input.vaultReleaseState === "enabled"
  };
}

async function writeGithubOutputs(result, outputPath) {
  if (!outputPath) {
    return;
  }

  await appendFile(
    outputPath,
    `contract_verified=true\nvault_enabled=${result.vaultEnabled ? "true" : "false"}\n`,
    { encoding: "utf8", flag: "a" }
  );
}

async function main() {
  const command = process.argv[2];
  if (process.argv.length !== 3) {
    throw new Error("Pass exactly one release-contract command.");
  }

  const currentFirestoreContractSha256 = await computeFirestoreReleaseContractSha256();
  if (command === "--print-firestore-sha256") {
    process.stdout.write(`${currentFirestoreContractSha256}\n`);
    return;
  }

  if (command !== "--verify") {
    throw new Error("Unknown release-contract command.");
  }

  const result = assertProductionReleaseContract({
    deployedFirestoreContractSha256:
      process.env.FIREBASE_DEPLOYED_RULES_INDEXES_SHA256,
    sparkAttestation: process.env.FIREBASE_SPARK_ATTESTATION,
    vaultReleaseState: process.env.VAULT_RELEASE_STATE
  }, currentFirestoreContractSha256);

  await writeGithubOutputs(result, process.env.GITHUB_OUTPUT);
  console.log("Production release contract verified without disclosing attestation values.");
}

if (currentModulePath && process.argv[1] && resolve(process.argv[1]) === currentModulePath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Production release contract verification failed.");
    process.exitCode = 1;
  });
}
