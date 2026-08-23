/* global Response, URL */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteManagedUserVaultServerState,
  removeDeletedUserFromParticipantNote
} from "../api/delete-managed-user.js";
import { fromFirestoreFields, toFirestoreFields } from "../api/_secure-share-common.js";
import {
  canonicalVaultInventoryManifestEntryKey,
  canonicalVaultInventoryManifestEntryToken,
  canonicalVaultInventoryManifestShard,
  vaultInventoryManifestContract,
  vaultInventoryManifestMarkerPath,
  vaultInventoryManifestShardIndexFromEntryKey,
  vaultInventoryManifestShardPath
} from "../shared/vault-inventory-manifest.js";

const projectId = "managed-user-vault-delete-test";
const documentRoot = `projects/${projectId}/databases/(default)/documents`;

function stringValue(value) {
  return { stringValue: value };
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function firestoreDocument(path, fields, updateTime = "2026-08-24T00:00:00.000001Z") {
  return {
    fields: toFirestoreFields(fields),
    name: `${documentRoot}/${path}`,
    updateTime
  };
}

function firestoreNoteDocument(path, fields, updateTime) {
  const { wrappedKeys, ...ordinaryFields } = fields;
  const document = firestoreDocument(path, ordinaryFields, updateTime);
  document.fields.wrappedKeys = {
    mapValue: {
      fields: Object.fromEntries(
        Object.entries(wrappedKeys).map(([uid, wrappedKey]) => [
          uid,
          { mapValue: { fields: toFirestoreFields(wrappedKey) } }
        ])
      )
    }
  };
  return document;
}

function participantCleanupFixture({
  commitStatus = 200,
  manifestState = "ready"
} = {}) {
  const ownerUid = "owner-user";
  const targetUid = "target-user";
  const callerUid = "admin-user";
  const noteId = "shared-note";
  const notePath = `notes/${noteId}`;
  const noteName = `${documentRoot}/${notePath}`;
  const timestamp = "2026-08-24T00:00:00.000Z";
  const wrappedKey = (suffix) => ({
    algorithm: "AES-KW",
    version: 1,
    wrappedKey: `wrapped-${suffix}`
  });
  const noteFields = {
    contentFormat: "markdown-v1",
    encryptedBody: { algorithm: "AES-GCM", cipherText: "cipher-body", iv: "iv", version: 1 },
    encryptedTitle: { algorithm: "AES-GCM", cipherText: "cipher-title", iv: "iv", version: 1 },
    entryKind: "markdown",
    folderId: null,
    ownerUid,
    participantUids: [ownerUid, targetUid],
    revision: 7,
    type: "shared",
    wrappedKeys: {
      [ownerUid]: wrappedKey("owner"),
      [targetUid]: wrappedKey("target")
    }
  };
  const note = firestoreNoteDocument(notePath, noteFields);
  const entryKey = digest(canonicalVaultInventoryManifestEntryKey({
    id: noteId,
    kind: "note",
    uid: ownerUid
  }));
  const entryToken = digest(canonicalVaultInventoryManifestEntryToken({
    document: { ...noteFields, id: noteId },
    kind: "note",
    uid: ownerUid
  }));
  const shardIndex = vaultInventoryManifestShardIndexFromEntryKey(entryKey);
  const entries = { [entryKey]: entryToken };
  const markerPath = vaultInventoryManifestMarkerPath(ownerUid);
  const shardPath = vaultInventoryManifestShardPath(ownerUid, shardIndex);
  const marker = firestoreDocument(markerPath, {
    createdAt: timestamp,
    epoch: 1,
    ownerUid,
    shardCount: vaultInventoryManifestContract.shardCount,
    updatedAt: timestamp,
    version: vaultInventoryManifestContract.version
  });
  const shardRevision = 3;
  const shard = firestoreDocument(shardPath, {
    createdAt: timestamp,
    epoch: 1,
    ownerUid,
    revision: shardRevision,
    root: digest(canonicalVaultInventoryManifestShard({
      entries,
      epoch: 1,
      revision: shardRevision,
      shardIndex,
      uid: ownerUid
    })),
    shardIndex,
    updatedAt: timestamp,
    version: vaultInventoryManifestContract.version
  });
  // Manifest entry digests are valid Firestore map keys even when they begin
  // with a digit; encode this dynamic map separately from ordinary fields.
  shard.fields.entries = {
    mapValue: {
      fields: Object.fromEntries(
        Object.entries(entries).map(([key, value]) => [key, stringValue(value)])
      )
    }
  };
  const transaction = "dGVzdC10cmFuc2FjdGlvbg==";
  const commits = [];
  const rollbacks = [];
  const requests = [];

  const fetch = vi.fn(async (input, init = {}) => {
    const url = new URL(String(input));
    requests.push({ init, url });
    const resource = decodeURIComponent(url.pathname.replace(/^\/v1\//u, ""));
    const body = init.body ? JSON.parse(String(init.body)) : {};

    if (resource.endsWith("/documents:batchGet")) {
      if (body.newTransaction) {
        return new Response(JSON.stringify([{ found: note, transaction }]), {
          headers: { "content-type": "application/json" },
          status: 200
        });
      }
      const rows = body.documents.map((name) => {
        if (manifestState !== "absent" && name === marker.name) return { found: marker };
        if (manifestState === "ready" && name === shard.name) return { found: shard };
        return { missing: name };
      });
      return new Response(JSON.stringify(rows), {
        headers: { "content-type": "application/json" },
        status: 200
      });
    }
    if (resource.endsWith("/documents:commit")) {
      commits.push(body);
      return new Response(
        JSON.stringify(commitStatus === 200
          ? { writeResults: body.writes.map(() => ({})) }
          : { error: { status: "ABORTED" } }),
        {
          headers: { "content-type": "application/json" },
          status: commitStatus
        }
      );
    }
    if (resource.endsWith("/documents:rollback")) {
      rollbacks.push(body);
      return new Response(JSON.stringify({}), {
        headers: { "content-type": "application/json" },
        status: 200
      });
    }
    throw new Error(`Unexpected Firestore request: ${resource}`);
  });

  return {
    callerUid,
    commits,
    entryKey,
    fetch,
    note,
    noteFields,
    noteId,
    noteName,
    ownerUid,
    requests,
    rollbacks,
    shard,
    shardIndex,
    targetUid,
    transaction
  };
}

function freshStats() {
  return {
    documentsDeleted: 0,
    vaultFolderTreesDeleted: 0,
    vaultImportChunksDeleted: 0,
    vaultImportJobsDeleted: 0,
    vaultIntegrityClaimsDeleted: 0,
    vaultIntegrityRootsDeleted: 0,
    vaultMaintenanceRootsDeleted: 0,
    vaultPathRewriteInventoryDeleted: 0,
    vaultPathRewriteJobsDeleted: 0,
    vaultPathRewriteStepsDeleted: 0,
    vaultServerStateDocumentsDeleted: 0,
    vaultServerStateReads: 0,
    vaultWorkspacesDeleted: 0
  };
}

class FakeFirestoreRest {
  documents = new Map();
  updateSequence = 0;

  add(path, ownerUid) {
    const name = `${documentRoot}/${path}`;
    this.updateSequence += 1;
    this.documents.set(name, {
      fields: { ownerUid: stringValue(ownerUid) },
      name,
      updateTime: new Date(Date.UTC(2026, 7, 24, 0, 0, 0, this.updateSequence))
        .toISOString()
    });
    return name;
  }

  paths() {
    return [...this.documents.keys()].map((name) => name.slice(`${documentRoot}/`.length));
  }

  response(body, status = 200) {
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status
    });
  }

  async fetch(input, init = {}) {
    const url = new URL(String(input));
    if (url.origin !== "https://firestore.googleapis.com") {
      throw new Error(`Unexpected network target: ${url.origin}`);
    }
    const resource = decodeURIComponent(url.pathname.replace(/^\/v1\//u, ""));
    if (resource.endsWith("/documents:commit")) {
      const body = JSON.parse(String(init.body ?? "{}"));
      const writes = Array.isArray(body.writes) ? body.writes : [];
      if (writes.some((write) => {
        const document = this.documents.get(write.delete);
        return write.currentDocument?.updateTime
          && document?.updateTime !== write.currentDocument.updateTime;
      })) {
        return this.response({ error: { status: "ABORTED" } }, 409);
      }
      for (const write of writes) {
        if (typeof write.delete === "string") this.documents.delete(write.delete);
      }
      return this.response({ writeResults: writes.map(() => ({})) });
    }
    if (url.searchParams.has("pageSize")) {
      const prefix = `${resource}/`;
      const pageSize = Math.max(1, Number(url.searchParams.get("pageSize") ?? 50));
      const documents = [...this.documents.values()]
        .filter((document) => {
          if (!document.name.startsWith(prefix)) return false;
          return !document.name.slice(prefix.length).includes("/");
        })
        .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
        .slice(0, pageSize);
      return this.response({ documents });
    }
    const document = this.documents.get(resource);
    return document
      ? this.response(document)
      : this.response({ error: { status: "NOT_FOUND" } }, 404);
  }
}

function addVaultServerState(backend, uid) {
  for (const path of [
    `vaultIntegrity/${uid}`,
    `vaultFolderTrees/${uid}`,
    `vaultWorkspaces/${uid}`,
    `vaultMaintenanceJobs/${uid}`,
    `vaultIntegrity/${uid}/nameClaims/claim-a`,
    `vaultIntegrity/${uid}/nameClaims/claim-b`,
    `vaultMaintenanceJobs/${uid}/pathRewrites/job-a`,
    `vaultMaintenanceJobs/${uid}/pathRewrites/job-a/steps/step-0000`,
    `vaultMaintenanceJobs/${uid}/pathRewrites/job-a/steps/step-0001`,
    `vaultMaintenanceJobs/${uid}/imports/import-a`,
    `vaultMaintenanceJobs/${uid}/imports/import-a/chunks/chunk-000`,
    `vaultMaintenanceJobs/${uid}/imports/import-a/chunks/chunk-001`,
    `vaultMaintenanceJobs/${uid}/pathRewriteInventory/marker`,
    `vaultMaintenanceJobs/${uid}/pathRewriteInventory/shard-00`,
    `vaultMaintenanceJobs/${uid}/pathRewriteInventory/shard-31`
  ]) {
    backend.add(path, uid);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("managed user shared-note membership cleanup", () => {
  it("increments the note revision and owner manifest shard in one transaction", async () => {
    const fixture = participantCleanupFixture();
    vi.stubEnv("FIRESTORE_EMULATOR_HOST", "");
    vi.stubGlobal("fetch", fixture.fetch);

    await expect(removeDeletedUserFromParticipantNote({
      accessToken: "test-token",
      callerUid: fixture.callerUid,
      noteName: fixture.noteName,
      projectId,
      targetUid: fixture.targetUid
    })).resolves.toBe(true);

    expect(fixture.commits).toHaveLength(1);
    const [{ transaction, writes }] = fixture.commits;
    expect(transaction).toBe(fixture.transaction);
    expect(writes).toHaveLength(3);
    const noteWrite = writes.find((write) => write.update?.name === fixture.noteName);
    const historyWrite = writes.find((write) => write.update?.name.includes("/history/"));
    const manifestWrite = writes.find((write) => write.update?.name === fixture.shard.name);
    const noteUpdate = fromFirestoreFields(noteWrite.update.fields);
    expect(noteUpdate).toMatchObject({
      participantUids: [fixture.ownerUid],
      revision: 8,
      type: "personal",
      updatedBy: fixture.callerUid
    });
    expect(noteUpdate.wrappedKeys).toEqual({
      [fixture.ownerUid]: fixture.noteFields.wrappedKeys[fixture.ownerUid]
    });
    expect(noteWrite.currentDocument).toEqual({ updateTime: "2026-08-24T00:00:00.000001Z" });
    expect(fromFirestoreFields(historyWrite.update.fields)).toMatchObject({
      action: "share",
      actorUid: fixture.callerUid,
      changedFields: ["participants"],
      noteId: fixture.noteId,
      readerUids: [fixture.ownerUid],
      revision: 8
    });
    expect(manifestWrite.currentDocument).toEqual({ updateTime: fixture.shard.updateTime });
    const manifestEntries = Object.fromEntries(
      Object.entries(manifestWrite.update.fields.entries.mapValue.fields)
        .map(([key, value]) => [key, value.stringValue])
    );
    const expectedNextToken = digest(canonicalVaultInventoryManifestEntryToken({
      document: {
        ...fixture.noteFields,
        ...noteUpdate,
        id: fixture.noteId
      },
      kind: "note",
      uid: fixture.ownerUid
    }));
    expect(manifestEntries[fixture.entryKey]).toBe(expectedNextToken);
    expect(fixture.rollbacks).toEqual([]);
  });

  it("keeps legacy owners writable without scanning their full inventory", async () => {
    const fixture = participantCleanupFixture({ manifestState: "absent" });
    vi.stubEnv("FIRESTORE_EMULATOR_HOST", "");
    vi.stubGlobal("fetch", fixture.fetch);

    await expect(removeDeletedUserFromParticipantNote({
      accessToken: "test-token",
      callerUid: fixture.callerUid,
      noteName: fixture.noteName,
      projectId,
      targetUid: fixture.targetUid
    })).resolves.toBe(true);

    expect(fixture.commits[0].writes).toHaveLength(2);
    expect(fixture.commits[0].writes.some((write) => (
      write.update?.name.includes("/pathRewriteInventory/")
    ))).toBe(false);
    expect(fixture.requests.filter(({ url }) => url.pathname.endsWith(":runQuery"))).toEqual([]);
  });

  it("normalizes a pre-versioned participant note to revision one", async () => {
    const fixture = participantCleanupFixture({ manifestState: "absent" });
    delete fixture.note.fields.revision;
    vi.stubEnv("FIRESTORE_EMULATOR_HOST", "");
    vi.stubGlobal("fetch", fixture.fetch);

    await expect(removeDeletedUserFromParticipantNote({
      accessToken: "test-token",
      callerUid: fixture.callerUid,
      noteName: fixture.noteName,
      projectId,
      targetUid: fixture.targetUid
    })).resolves.toBe(true);

    const noteWrite = fixture.commits[0].writes.find((write) => (
      write.update?.name === fixture.noteName
    ));
    const historyWrite = fixture.commits[0].writes.find((write) => (
      write.update?.name.includes("/history/")
    ));
    expect(fromFirestoreFields(noteWrite.update.fields).revision).toBe(1);
    expect(fromFirestoreFields(historyWrite.update.fields).revision).toBe(1);
  });

  it("fails closed and requests a retry for a partial owner manifest", async () => {
    const fixture = participantCleanupFixture({ manifestState: "partial" });
    vi.stubEnv("FIRESTORE_EMULATOR_HOST", "");
    vi.stubGlobal("fetch", fixture.fetch);

    await expect(removeDeletedUserFromParticipantNote({
      accessToken: "test-token",
      callerUid: fixture.callerUid,
      noteName: fixture.noteName,
      projectId,
      targetUid: fixture.targetUid
    })).rejects.toMatchObject({ name: "ManagedUserCleanupInProgressError" });

    expect(fixture.commits).toEqual([]);
    expect(fixture.rollbacks).toEqual([{ transaction: fixture.transaction }]);
  });

  it("maps an aborted atomic commit to a retryable cleanup response", async () => {
    const fixture = participantCleanupFixture({ commitStatus: 409 });
    vi.stubEnv("FIRESTORE_EMULATOR_HOST", "");
    vi.stubGlobal("fetch", fixture.fetch);

    await expect(removeDeletedUserFromParticipantNote({
      accessToken: "test-token",
      callerUid: fixture.callerUid,
      noteName: fixture.noteName,
      projectId,
      targetUid: fixture.targetUid
    })).rejects.toMatchObject({ name: "ManagedUserCleanupInProgressError" });

    expect(fixture.commits).toHaveLength(1);
    expect(fixture.rollbacks).toEqual([{ transaction: fixture.transaction }]);
  });

  it("fails closed when a discovery result has become target-owned", async () => {
    const fixture = participantCleanupFixture();
    fixture.note.fields.ownerUid = stringValue(fixture.targetUid);
    vi.stubEnv("FIRESTORE_EMULATOR_HOST", "");
    vi.stubGlobal("fetch", fixture.fetch);

    await expect(removeDeletedUserFromParticipantNote({
      accessToken: "test-token",
      callerUid: fixture.callerUid,
      noteName: fixture.noteName,
      projectId,
      targetUid: fixture.targetUid
    })).rejects.toMatchObject({ name: "ManagedUserCleanupInProgressError" });

    expect(fixture.commits).toEqual([]);
    expect(fixture.rollbacks).toEqual([{ transaction: fixture.transaction }]);
  });
});

describe("managed user Vault server-state deletion", () => {
  it("removes all fixed owner subcollections before roots and preserves another owner", async () => {
    const backend = new FakeFirestoreRest();
    addVaultServerState(backend, "target-user");
    addVaultServerState(backend, "foreign-user");
    const foreignPaths = backend.paths().filter((path) => path.includes("foreign-user"));
    const stats = freshStats();
    vi.stubGlobal("fetch", vi.fn(backend.fetch.bind(backend)));

    await expect(deleteManagedUserVaultServerState({
      accessToken: "test-token",
      projectId,
      stats,
      targetUid: "target-user"
    })).resolves.toMatchObject({ writes: 15 });

    expect(backend.paths().filter((path) => path.includes("target-user"))).toEqual([]);
    expect(backend.paths().filter((path) => path.includes("foreign-user")))
      .toEqual(foreignPaths);
    expect(stats).toMatchObject({
      documentsDeleted: 15,
      vaultFolderTreesDeleted: 1,
      vaultImportChunksDeleted: 2,
      vaultImportJobsDeleted: 1,
      vaultIntegrityClaimsDeleted: 2,
      vaultIntegrityRootsDeleted: 1,
      vaultMaintenanceRootsDeleted: 1,
      vaultPathRewriteInventoryDeleted: 3,
      vaultPathRewriteJobsDeleted: 1,
      vaultPathRewriteStepsDeleted: 2,
      vaultServerStateDocumentsDeleted: 15,
      vaultWorkspacesDeleted: 1
    });
    expect(stats.vaultServerStateReads).toBeLessThanOrEqual(500);
  });

  it("fails closed rather than deleting a foreign-owned document in the target subtree", async () => {
    const backend = new FakeFirestoreRest();
    backend.add("vaultIntegrity/target-user", "target-user");
    backend.add("vaultIntegrity/target-user/nameClaims/foreign-claim", "foreign-user");
    const stats = freshStats();
    vi.stubGlobal("fetch", vi.fn(backend.fetch.bind(backend)));

    await expect(deleteManagedUserVaultServerState({
      accessToken: "test-token",
      projectId,
      stats,
      targetUid: "target-user"
    })).rejects.toThrow("Managed user Vault ownership changed during cleanup");

    expect(backend.paths()).toContain(
      "vaultIntegrity/target-user/nameClaims/foreign-claim"
    );
    expect(stats.vaultServerStateDocumentsDeleted).toBe(0);
  });

  it("stops at the fixed 500-write bound and completes idempotently on retry", async () => {
    const backend = new FakeFirestoreRest();
    backend.add("vaultIntegrity/target-user", "target-user");
    for (let index = 0; index < 501; index += 1) {
      backend.add(
        `vaultIntegrity/target-user/nameClaims/claim-${String(index).padStart(3, "0")}`,
        "target-user"
      );
    }
    vi.stubGlobal("fetch", vi.fn(backend.fetch.bind(backend)));

    await expect(deleteManagedUserVaultServerState({
      accessToken: "test-token",
      projectId,
      stats: freshStats(),
      targetUid: "target-user"
    })).rejects.toMatchObject({ name: "ManagedUserCleanupInProgressError" });
    expect(backend.paths().filter((path) => path.includes("/nameClaims/")))
      .toHaveLength(1);
    expect(backend.paths()).toContain("vaultIntegrity/target-user");

    const retryStats = freshStats();
    await expect(deleteManagedUserVaultServerState({
      accessToken: "test-token",
      projectId,
      stats: retryStats,
      targetUid: "target-user"
    })).resolves.toMatchObject({ writes: 2 });
    expect(backend.paths()).toEqual([]);
    expect(retryStats.vaultIntegrityClaimsDeleted).toBe(1);
    expect(retryStats.vaultIntegrityRootsDeleted).toBe(1);
  });
});
