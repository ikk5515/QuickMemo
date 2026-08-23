import { describe, expect, it } from "vitest";
import { __vaultPathRewriteActivationTesting } from "../api/_vault-path-rewrite-activation.js";
import {
  vaultInventoryManifestContract,
  vaultInventoryManifestShardId
} from "../shared/vault-inventory-manifest.js";

const jobId = `pr2_${"atomic-activation".padEnd(43, "0")}`;
const activation = { expectedRevision: 2, jobId };
const target = { expectedRevision: 0, id: "legacy-note", kind: "entry" };

function preparedJob(overrides = {}) {
  return {
    __updateTime: "2026-08-24T00:00:00.000000Z",
    activationMode: "atomic-v1",
    confirmedCount: 0,
    cursor: 0,
    inventoryFingerprint: "I".repeat(43),
    kind: "path-rewrite-v1",
    lastErrorCode: null,
    mutationExpectedRevision: 0,
    mutationTargetId: "legacy-note",
    mutationTargetKind: "entry",
    ownerUid: "user-a",
    planFingerprint: jobId,
    preparedStepCount: 1,
    revision: 2,
    status: "prepared",
    stepCount: 1,
    version: 1,
    ...overrides
  };
}

function manifestDocuments(overrides = {}) {
  const marker = {
    __id: "marker",
    createdAt: "2026-08-24T00:00:00.000Z",
    epoch: 1,
    ownerUid: "user-a",
    shardCount: vaultInventoryManifestContract.shardCount,
    updatedAt: "2026-08-24T00:00:00.000Z",
    version: vaultInventoryManifestContract.version
  };
  const shards = Array.from(
    { length: vaultInventoryManifestContract.shardCount },
    (_, shardIndex) => ({
      __id: vaultInventoryManifestShardId(shardIndex),
      createdAt: "2026-08-24T00:00:00.000Z",
      epoch: 1,
      ownerUid: "user-a",
      revision: 1,
      root: String.fromCharCode(65 + (shardIndex % 26)).repeat(43),
      shardIndex,
      updatedAt: "2026-08-24T00:00:00.000Z",
      version: vaultInventoryManifestContract.version
    })
  );
  return [
    { ...marker, ...(overrides.marker ?? {}) },
    ...shards.map((shard, index) => ({
      ...shard,
      ...(overrides.shards?.[index] ?? {})
    }))
  ];
}

function preparedManifestJob(documents, overrides = {}) {
  const manifestJobId = `pr3_${"manifest-activation".padEnd(43, "0")}`;
  const marker = documents[0];
  const shards = documents.slice(1);
  return {
    jobId: manifestJobId,
    activation: { expectedRevision: 2, jobId: manifestJobId },
    job: preparedJob({
      activationMode: "atomic-manifest-v1",
      inventoryFingerprint: undefined,
      inventoryManifestEpoch: marker.epoch,
      inventoryManifestRoot: __vaultPathRewriteActivationTesting.vaultInventoryManifestBindingRoot(
        "user-a",
        marker,
        shards
      ),
      inventoryManifestShardCount: marker.shardCount,
      inventoryManifestVersion: marker.version,
      planFingerprint: manifestJobId,
      ...overrides
    })
  };
}

describe("atomic Vault path rewrite activation fence", () => {
  it("accepts an exact prepared binding, including a historical revision-zero note", () => {
    expect(__vaultPathRewriteActivationTesting.assertAtomicPreparedJob(
      preparedJob(),
      "user-a",
      activation,
      target
    )).toMatchObject({ status: "prepared", mutationExpectedRevision: 0 });
  });

  it.each(["not-applied", "abandoned", "preparing", "ready"])(
    "rejects %s so a recovery transition cannot be activated by a stale mutation",
    (status) => {
      expect(() => __vaultPathRewriteActivationTesting.assertAtomicPreparedJob(
        preparedJob({ status }),
        "user-a",
        activation,
        target
      )).toThrow();
    }
  );

  it.each([1, 3])("requires exact job revision equality (received %s)", (revision) => {
    expect(() => __vaultPathRewriteActivationTesting.assertAtomicPreparedJob(
      preparedJob({ revision }),
      "user-a",
      activation,
      target
    )).toThrow();
  });

  it("rejects a job bound to another endpoint target or an incomplete step seal", () => {
    expect(() => __vaultPathRewriteActivationTesting.assertAtomicPreparedJob(
      preparedJob(),
      "user-a",
      activation,
      { ...target, id: "another-note" }
    )).toThrow();
    expect(() => __vaultPathRewriteActivationTesting.assertAtomicPreparedJob(
      preparedJob({ preparedStepCount: 0 }),
      "user-a",
      activation,
      target
    )).toThrow();
  });

  it("accepts pr3 only with the explicit fixed-shard manifest binding", () => {
    const documents = manifestDocuments();
    const prepared = preparedManifestJob(documents);
    expect(__vaultPathRewriteActivationTesting.assertAtomicPreparedJob(
      prepared.job,
      "user-a",
      prepared.activation,
      target
    )).toMatchObject({
      activationMode: "atomic-manifest-v1",
      inventoryManifestEpoch: 1,
      inventoryManifestShardCount: 32
    });
    expect(() => __vaultPathRewriteActivationTesting.assertAtomicPreparedJob(
      { ...prepared.job, activationMode: "atomic-v1" },
      "user-a",
      prepared.activation,
      target
    )).toThrow();
    expect(() => __vaultPathRewriteActivationTesting.assertAtomicPreparedJob(
      { ...prepared.job, inventoryFingerprint: "I".repeat(43) },
      "user-a",
      prepared.activation,
      target
    )).toThrow();
  });

  it("matches one marker plus all 32 shards and rejects stale or incomplete roots", () => {
    const documents = manifestDocuments();
    const prepared = preparedManifestJob(documents);
    expect(__vaultPathRewriteActivationTesting.assertCurrentManifestDocumentsMatch(
      "user-a",
      prepared.job,
      documents
    )).toBe(prepared.job.inventoryManifestRoot);

    expect(() => __vaultPathRewriteActivationTesting.assertCurrentManifestDocumentsMatch(
      "user-a",
      prepared.job,
      manifestDocuments({ shards: { 7: { revision: 2 } } })
    )).toThrow();
    expect(() => __vaultPathRewriteActivationTesting.assertCurrentManifestDocumentsMatch(
      "user-a",
      prepared.job,
      documents.slice(0, -1)
    )).toThrow();
    expect(() => __vaultPathRewriteActivationTesting.assertCurrentManifestDocumentsMatch(
      "user-a",
      prepared.job,
      [...documents, { ...documents[1], __id: "unexpected" }]
    )).toThrow();
  });

  it("projects out shard entry maps and uses a fixed bounded transaction query", () => {
    const query = __vaultPathRewriteActivationTesting.manifestInventoryQuery();
    expect(query.from).toEqual([{ collectionId: "pathRewriteInventory" }]);
    expect(query.limit).toBe(34);
    expect(query.select.fields).not.toContainEqual({ fieldPath: "entries" });
    expect(query.select.fields).toContainEqual({ fieldPath: "root" });
    expect(query.select.fields).toContainEqual({ fieldPath: "revision" });
  });
});
