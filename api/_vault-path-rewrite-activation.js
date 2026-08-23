import { createHash } from "node:crypto";
import {
  HttpError,
  assertOnlyKeys,
  firestoreBatchGet,
  firestoreRunQuery,
  updateDocumentWrite
} from "./_secure-share-common.js";
import {
  canonicalVaultPathRewriteInventory,
  validVaultPathRewriteInventoryFingerprint,
  vaultPathRewriteInventoryLimits
} from "../shared/vault-path-rewrite-inventory.js";
import {
  canonicalVaultInventoryManifestBinding,
  validVaultInventoryManifestDigest,
  vaultInventoryManifestContract
} from "../shared/vault-inventory-manifest.js";
import { prepareVaultInventoryManifestBootstrap } from "./_vault-inventory-manifest-mutation.js";

const maximumRevision = 999_999_999_999;
const pathRewriteJobPattern = /^pr[23]_[A-Za-z0-9_-]{43}$/u;

export function pathRewriteJobPath(uid, jobId) {
  return `vaultMaintenanceJobs/${uid}/pathRewrites/${jobId}`;
}

export function assertOptionalPathRewriteActivation(value) {
  if (value === undefined) return null;
  assertOnlyKeys(value, ["expectedRevision", "jobId"]);
  if (
    typeof value.jobId !== "string"
    || !pathRewriteJobPattern.test(value.jobId)
    || !Number.isSafeInteger(value.expectedRevision)
    || value.expectedRevision < 1
    || value.expectedRevision > maximumRevision
  ) {
    throw new HttpError(400, "invalid_request", "Invalid path rewrite activation");
  }
  return { expectedRevision: value.expectedRevision, jobId: value.jobId };
}

function assertAtomicPreparedJob(job, uid, activation, target) {
  const manifestBinding = activation.jobId.startsWith("pr3_");
  const validBinding = manifestBinding
    ? (
        job?.activationMode === "atomic-manifest-v1"
        && job.inventoryFingerprint === undefined
        && job.inventoryManifestVersion === vaultInventoryManifestContract.version
        && job.inventoryManifestShardCount === vaultInventoryManifestContract.shardCount
        && Number.isSafeInteger(job.inventoryManifestEpoch)
        && job.inventoryManifestEpoch >= 1
        && job.inventoryManifestEpoch <= maximumRevision
        && validVaultInventoryManifestDigest(job.inventoryManifestRoot)
      )
    : (
        job?.activationMode === "atomic-v1"
        && validVaultPathRewriteInventoryFingerprint(job.inventoryFingerprint)
        && job.inventoryManifestVersion === undefined
        && job.inventoryManifestShardCount === undefined
        && job.inventoryManifestEpoch === undefined
        && job.inventoryManifestRoot === undefined
      );
  if (
    !job
    || job.ownerUid !== uid
    || job.kind !== "path-rewrite-v1"
    || job.version !== 1
    || job.planFingerprint !== activation.jobId
    || !validBinding
    || job.mutationTargetKind !== target.kind
    || job.mutationTargetId !== target.id
    || job.mutationExpectedRevision !== target.expectedRevision
    || job.status !== "prepared"
    || !Number.isSafeInteger(job.stepCount)
    || job.stepCount < 0
    || job.stepCount > 5_000
    || job.cursor !== 0
    || job.confirmedCount !== 0
    || job.preparedStepCount !== job.stepCount
    || job.lastErrorCode !== null
    || !Number.isSafeInteger(job.revision)
    || job.revision !== activation.expectedRevision
    || job.revision >= maximumRevision
    || !job.__updateTime
  ) {
    throw new HttpError(
      409,
      "vault_path_rewrite_invalid",
      "Prepared path rewrite job does not match the path mutation",
      { expose: false }
    );
  }
  return job;
}

function manifestInventoryQuery() {
  return {
    from: [{ collectionId: vaultInventoryManifestContract.collectionId }],
    limit: vaultInventoryManifestContract.shardCount + 2,
    select: {
      fields: [
        "createdAt",
        "epoch",
        "ownerUid",
        "revision",
        "root",
        "shardCount",
        "shardIndex",
        "updatedAt",
        "version"
      ].map((fieldPath) => ({ fieldPath }))
    }
  };
}

export function vaultInventoryManifestBindingRoot(uid, marker, shards) {
  return createHash("sha256")
    .update(canonicalVaultInventoryManifestBinding({ uid, marker, shards }), "utf8")
    .digest("base64url");
}

function assertCurrentManifestDocumentsMatch(uid, job, documents) {
  if (
    !Array.isArray(documents)
    || documents.length !== vaultInventoryManifestContract.shardCount + 1
  ) {
    throw new HttpError(
      409,
      "vault_path_rewrite_inventory_changed",
      "Vault inventory manifest is incomplete"
    );
  }
  const marker = documents.find((document) => (
    document?.__id === vaultInventoryManifestContract.markerId
  ));
  const shards = documents.filter((document) => (
    document?.__id !== vaultInventoryManifestContract.markerId
  ));
  try {
    if (
      !marker
      || marker.epoch !== job.inventoryManifestEpoch
      || marker.version !== job.inventoryManifestVersion
      || marker.shardCount !== job.inventoryManifestShardCount
    ) {
      throw new TypeError("Vault inventory manifest marker changed");
    }
    const actualRoot = vaultInventoryManifestBindingRoot(uid, marker, shards);
    if (actualRoot !== job.inventoryManifestRoot) {
      throw new TypeError("Vault inventory manifest root changed");
    }
    return actualRoot;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      409,
      "vault_path_rewrite_inventory_changed",
      "Vault changed after the path rewrite plan was prepared"
    );
  }
}

async function assertCurrentManifestMatches(context, transaction, uid, job) {
  const documents = await firestoreRunQuery(
    context,
    manifestInventoryQuery(),
    `vaultMaintenanceJobs/${uid}`,
    transaction
  );
  return assertCurrentManifestDocumentsMatch(uid, job, documents);
}

function ownedInventoryQuery(uid, collectionId, maximum, fields) {
  return {
    from: [{ collectionId }],
    limit: maximum + 1,
    select: { fields: fields.map((fieldPath) => ({ fieldPath })) },
    where: {
      fieldFilter: {
        field: { fieldPath: "ownerUid" },
        op: "EQUAL",
        value: { stringValue: uid }
      }
    }
  };
}

function noteInventoryQuery(uid) {
  return ownedInventoryQuery(uid, "notes", vaultPathRewriteInventoryLimits.notes, [
    "contentFormat",
    "encryptedBody.algorithm",
    "encryptedBody.version",
    "encryptedTitle.algorithm",
    "encryptedTitle.version",
    "entryKind",
    "folderId",
    "isDeleted",
    "isPurged",
    "ownerUid",
    "revision",
    "secureShareCopyState",
    "type",
    "vaultImportJobId",
    "vaultNameClaimId",
    "vaultNameIndexVersion"
  ]);
}

function folderInventoryQuery(uid) {
  return ownedInventoryQuery(uid, "noteFolders", vaultPathRewriteInventoryLimits.folders, [
    "deletedBy",
    "encryptedName.algorithm",
    "encryptedName.version",
    "isDeleted",
    "name",
    "ownerUid",
    "parentId",
    "revision",
    "vaultImportJobId",
    "vaultLineageGeneration",
    "vaultLineageVersion",
    "vaultNameClaimId",
    "vaultNameIndexVersion",
    "wrappedKey.algorithm",
    "wrappedKey.version"
  ]);
}

export function vaultPathRewriteInventoryFingerprint(uid, notes, folders) {
  return createHash("sha256")
    .update(canonicalVaultPathRewriteInventory({ uid, notes, folders }), "utf8")
    .digest("base64url");
}

async function assertCurrentInventoryMatches(context, transaction, uid, expectedFingerprint) {
  const notes = await firestoreRunQuery(context, noteInventoryQuery(uid), "", transaction);
  if (notes.length > vaultPathRewriteInventoryLimits.notes) {
    throw new HttpError(409, "vault_path_rewrite_inventory_capacity", "Vault note inventory exceeds the safe limit");
  }
  const folders = await firestoreRunQuery(context, folderInventoryQuery(uid), "", transaction);
  if (folders.length > vaultPathRewriteInventoryLimits.folders) {
    throw new HttpError(409, "vault_path_rewrite_inventory_capacity", "Vault folder inventory exceeds the safe limit");
  }
  const actualFingerprint = vaultPathRewriteInventoryFingerprint(uid, notes, folders);
  if (actualFingerprint !== expectedFingerprint) {
    throw new HttpError(
      409,
      "vault_path_rewrite_inventory_changed",
      "Vault changed after the path rewrite plan was prepared"
    );
  }
  return { folders, notes };
}

/**
 * Reads and validates the opaque E2EE rewrite envelope inside the caller's
 * existing Firestore transaction, then returns the paired activation writes.
 * The path mutation and every returned write must be committed together.
 */
export async function prepareAtomicPathRewriteActivation(
  context,
  transaction,
  uid,
  value,
  target,
  now
) {
  const activation = assertOptionalPathRewriteActivation(value);
  if (!activation) return [];
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("A valid path rewrite activation timestamp is required");
  }
  if (
    !target
    || (target.kind !== "entry" && target.kind !== "folder")
    || typeof target.id !== "string"
    || !target.id
    || target.id.length > 120
    || target.id.includes("/")
    || !Number.isSafeInteger(target.expectedRevision)
    || target.expectedRevision < (target.kind === "entry" ? 0 : 1)
    || target.expectedRevision > maximumRevision
  ) {
    throw new TypeError("A valid path rewrite mutation target is required");
  }
  const path = pathRewriteJobPath(uid, activation.jobId);
  const [stored] = await firestoreBatchGet(context, [path], transaction);
  const job = assertAtomicPreparedJob(stored, uid, activation, target);
  let inventoryBootstrapWrites = [];
  if (activation.jobId.startsWith("pr3_")) {
    // The marker plus all fixed shards are one bounded transaction query.
    // A shard update or collection phantom aborts/mismatches the pre-mutation
    // fence without reading every owner note/folder. Shard `entries` are
    // deliberately projected out; their authenticated roots are sufficient.
    await assertCurrentManifestMatches(context, transaction, uid, job);
  } else {
    // Preserve pr2 recovery compatibility. New jobs use pr3; this legacy path
    // may be removed only after every prepared pr2 job has drained.
    const inventory = await assertCurrentInventoryMatches(
      context,
      transaction,
      uid,
      job.inventoryFingerprint
    );
    inventoryBootstrapWrites = await prepareVaultInventoryManifestBootstrap(
      context,
      transaction,
      uid,
      inventory.notes,
      inventory.folders,
      now,
      {
        currentDocument: target.currentDocument,
        id: target.id,
        kind: target.kind === "entry" ? "note" : "folder",
        nextDocument: target.nextDocument
      }
    );
  }
  const fields = {
    activatedAt: now,
    revision: job.revision + 1,
    // Even a zero-step rewrite remains `ready` until a client observes this
    // durable activation and acknowledges it as completed. This prevents a
    // cleanup tab from deleting the only commit proof before the mutating tab
    // can disambiguate a lost HTTP response.
    status: "ready",
    updatedAt: now
  };
  return [
    updateDocumentWrite(
      context.projectId,
      path,
      fields,
      Object.keys(fields),
      job.__updateTime
    ),
    ...inventoryBootstrapWrites
  ];
}

export const __vaultPathRewriteActivationTesting = Object.freeze({
  assertCurrentManifestDocumentsMatch,
  assertAtomicPreparedJob,
  assertOptionalPathRewriteActivation,
  folderInventoryQuery,
  manifestInventoryQuery,
  noteInventoryQuery,
  vaultInventoryManifestBindingRoot,
  vaultPathRewriteInventoryFingerprint
});
