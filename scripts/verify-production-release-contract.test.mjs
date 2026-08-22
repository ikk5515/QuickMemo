import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PRODUCTION_FIREBASE_PROJECT_ID,
  assertProductionReleaseContract,
  computeFirestoreReleaseContractSha256,
  sparkReleaseAttestation
} from "./verify-production-release-contract.mjs";

const temporaryRoots = [];

async function createContractFixture() {
  const root = await mkdtemp(join(tmpdir(), "quickmemo-release-contract-"));
  temporaryRoots.push(root);
  await writeFile(join(root, "firestore.rules"), "rules_version = '2';\n");
  await writeFile(join(root, "firestore.indexes.json"), "{\"indexes\":[]}\n");
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => (
    rm(path, { recursive: true, force: true })
  )));
});

describe("production release contract", () => {
  it("produces a deterministic digest that changes with either Firestore input", async () => {
    const root = await createContractFixture();
    const first = await computeFirestoreReleaseContractSha256(root);
    const repeated = await computeFirestoreReleaseContractSha256(root);

    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(repeated).toBe(first);

    await writeFile(join(root, "firestore.indexes.json"), "{\"indexes\":[{}]}\n");
    expect(await computeFirestoreReleaseContractSha256(root)).not.toBe(first);

    await writeFile(join(root, "firestore.indexes.json"), "{\"indexes\":[]}\n");
    await writeFile(join(root, "firestore.rules"), "rules_version = '2';\n// changed\n");
    expect(await computeFirestoreReleaseContractSha256(root)).not.toBe(first);
  });

  it.each([
    ["enabled", true],
    ["disabled", false]
  ])("accepts the exact attested contract with Vault %s", (vaultReleaseState, vaultEnabled) => {
    const digest = "a".repeat(64);
    expect(assertProductionReleaseContract({
      deployedFirestoreContractSha256: digest,
      sparkAttestation: sparkReleaseAttestation(digest),
      vaultReleaseState
    }, digest)).toEqual({ vaultEnabled });
  });

  it("binds the Spark attestation to the production project and exact contract", () => {
    const digest = "b".repeat(64);
    expect(sparkReleaseAttestation(digest)).toBe(
      `spark:${PRODUCTION_FIREBASE_PROJECT_ID}:${digest}`
    );

    for (const sparkAttestation of [
      `spark:other-project:${digest}`,
      `spark:${PRODUCTION_FIREBASE_PROJECT_ID}:${"c".repeat(64)}`,
      "spark",
      undefined
    ]) {
      expect(() => assertProductionReleaseContract({
        deployedFirestoreContractSha256: digest,
        sparkAttestation,
        vaultReleaseState: "enabled"
      }, digest)).toThrow("Spark plan is not attested");
    }
  });

  it("fails closed for a missing, stale, malformed, or non-explicit attestation", () => {
    const digest = "d".repeat(64);
    const valid = {
      deployedFirestoreContractSha256: digest,
      sparkAttestation: sparkReleaseAttestation(digest),
      vaultReleaseState: "enabled"
    };

    for (const deployedFirestoreContractSha256 of [
      undefined,
      "",
      "D".repeat(64),
      "e".repeat(64)
    ]) {
      expect(() => assertProductionReleaseContract({
        ...valid,
        deployedFirestoreContractSha256
      }, digest)).toThrow("deployed Firestore contract is not attested");
    }

    for (const vaultReleaseState of [undefined, "", "true", "false", "ENABLED"]) {
      expect(() => assertProductionReleaseContract({
        ...valid,
        vaultReleaseState
      }, digest)).toThrow("Vault release state is not explicit");
    }

    expect(() => assertProductionReleaseContract(valid, "not-a-digest"))
      .toThrow("local Firestore contract digest is invalid");
  });

  it("does not reflect rejected attestation values in errors", () => {
    const digest = "f".repeat(64);
    const rejectedValue = "do-not-reflect-this-attestation";
    try {
      assertProductionReleaseContract({
        deployedFirestoreContractSha256: rejectedValue,
        sparkAttestation: rejectedValue,
        vaultReleaseState: rejectedValue
      }, digest);
      throw new Error("Expected the release contract to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(error.message).not.toContain(rejectedValue);
    }
  });
});
