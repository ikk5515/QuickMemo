import { afterEach, describe, expect, it, vi } from "vitest";
import { __vaultFolderTreeTesting } from "../../api/vault-folders.js";
import {
  buildVaultFolderTree,
  vaultFolderTreeFirestoreFields
} from "../../api/_vault-folder-tree.js";
import { vaultCutoverLeaseCredential } from "../../api/_vault-integrity-marker.js";

const projectId = "quickmemo-rules-test";
const context = { accessToken: "owner", projectId };
const uid = "user-a";
const transaction = "dHJhbnNhY3Rpb24tdG9rZW4=";
const timestamp = new Date("2026-08-23T00:00:00.000Z");
const leaseId = "l".repeat(43);
const leaseGeneration = "g".repeat(43);
const leaseCredential = vaultCutoverLeaseCredential(leaseId, leaseGeneration);
const treeName = `projects/${projectId}/databases/(default)/documents/vaultFolderTrees/${uid}`;
const documentName = (path: string) =>
  `projects/${projectId}/databases/(default)/documents/${path}`;

function treeDocument(folders: unknown[] = []) {
  return {
    createTime: timestamp.toISOString(),
    fields: vaultFolderTreeFirestoreFields(
      uid,
      buildVaultFolderTree(folders),
      timestamp,
      timestamp
    ),
    name: treeName,
    updateTime: timestamp.toISOString()
  };
}

function integrityDocument(state: "legacy" | "pending" | "ready" = "ready") {
  const leaseUpdatedAt = new Date();
  return {
    fields: {
      createdAt: { timestampValue: timestamp.toISOString() },
      indexVersion: { integerValue: "1" },
      ownerUid: { stringValue: uid },
      updatedAt: { timestampValue: state === "pending" ? leaseUpdatedAt.toISOString() : timestamp.toISOString() },
      wrappedKey: {
        mapValue: {
          fields: {
            algorithm: { stringValue: "RSA-OAEP" },
            version: { integerValue: "1" },
            wrappedKey: { stringValue: "wrapped-integrity-key" }
          }
        }
      },
      ...(state === "legacy" ? {} : {
        cutoverState: { stringValue: state },
        cutoverVersion: { integerValue: "1" }
      }),
      ...(state === "ready" ? {
        verifiedAt: { timestampValue: timestamp.toISOString() }
      } : {}),
      ...(state === "pending" ? {
        cutoverLeaseAcquiredAt: { timestampValue: leaseUpdatedAt.toISOString() },
        cutoverLeaseExpiresAt: { timestampValue: new Date(leaseUpdatedAt.getTime() + 90_000).toISOString() },
        cutoverLeaseGeneration: { stringValue: leaseGeneration },
        cutoverLeaseHash: { stringValue: leaseCredential.hash },
        cutoverLeaseVersion: { integerValue: "1" }
      } : {})
    },
    name: documentName(`vaultIntegrity/${uid}`),
    updateTime: timestamp.toISOString()
  };
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
    status
  });
}

const createBody = {
  action: "create",
  color: "#7c5cff",
  encryptedName: {
    algorithm: "AES-GCM",
    cipherText: "cipher",
    iv: "iv",
    version: 1
  },
  folderId: "folder-a",
  nameClaim: {
    claimId: "C".repeat(43),
    indexVersion: 1,
    parentId: null
  },
  order: 0,
  parentId: null,
  wrappedKey: {
    algorithm: "RSA-OAEP",
    version: 1,
    wrappedKey: "wrapped-key"
  }
} as const;

const ordinaryFolderTreeInput = {
  __id: "folder-a",
  encryptedName: createBody.encryptedName,
  isDeleted: false,
  parentId: null,
  vaultLineageGeneration: 1,
  wrappedKey: createBody.wrappedKey
};

function ordinaryFolderDocument() {
  return {
    fields: {
      encryptedName: {
        mapValue: {
          fields: {
            algorithm: { stringValue: "AES-GCM" },
            cipherText: { stringValue: "cipher" },
            iv: { stringValue: "iv" },
            version: { integerValue: "1" }
          }
        }
      },
      isDeleted: { booleanValue: false },
      ownerUid: { stringValue: uid },
      parentId: { nullValue: null },
      revision: { integerValue: "1" },
      vaultNameClaimId: { stringValue: "C".repeat(43) },
      vaultNameIndexVersion: { integerValue: "1" },
      wrappedKey: {
        mapValue: {
          fields: {
            algorithm: { stringValue: "RSA-OAEP" },
            version: { integerValue: "1" },
            wrappedKey: { stringValue: "wrapped-key" }
          }
        }
      }
    },
    name: documentName("noteFolders/folder-a"),
    updateTime: timestamp.toISOString()
  };
}

const updateBody = {
  action: "update",
  encryptedName: { ...createBody.encryptedName, cipherText: "updated" },
  expectedRevision: 1,
  folderId: "folder-a",
  nameClaim: createBody.nameClaim
} as const;

describe("Vault folder server transaction boundary", () => {
  afterEach(() => vi.restoreAllMocks());

  it("commits tree, encrypted folder, and name claim in one preconditioned transaction", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json([
        { found: treeDocument(), transaction },
        { found: integrityDocument("ready") },
        { missing: `projects/${projectId}/databases/(default)/documents/noteFolders/folder-a` },
        { missing: `projects/${projectId}/databases/(default)/documents/vaultIntegrity/${uid}/nameClaims/${"C".repeat(43)}` }
      ]))
      .mockResolvedValueOnce(json({ commitTime: timestamp.toISOString(), writeResults: [] }));

    const result = await __vaultFolderTreeTesting.performAction(context, uid, createBody);

    expect(result).toMatchObject({ folderId: "folder-a", revision: 1, treeRevision: 2 });
    const commitCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith(":commit"));
    expect(commitCall).toBeDefined();
    const request = commitCall?.[1] as RequestInit;
    const payload = JSON.parse(String(request.body)) as {
      transaction: string;
      writes: Array<Record<string, unknown>>;
    };
    expect(payload.transaction).toBe(transaction);
    expect(payload.writes).toHaveLength(3);
    expect(payload.writes[0]).toMatchObject({
      currentDocument: { updateTime: timestamp.toISOString() }
    });
    expect(JSON.stringify(payload.writes)).not.toContain("사용자 폴더 이름");
  });

  it("rolls back without committing when the opaque name claim is occupied", async () => {
    const claimName = `projects/${projectId}/databases/(default)/documents/vaultIntegrity/${uid}/nameClaims/${"C".repeat(43)}`;
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json([
        { found: treeDocument(), transaction },
        { found: integrityDocument("ready") },
        { missing: `projects/${projectId}/databases/(default)/documents/noteFolders/folder-a` },
        {
          found: {
            fields: {
              indexVersion: { integerValue: "1" },
              ownerUid: { stringValue: uid },
              parentId: { nullValue: null },
              targetId: { stringValue: "other-folder" },
              targetType: { stringValue: "folder" }
            },
            name: claimName,
            updateTime: timestamp.toISOString()
          }
        }
      ]))
      .mockResolvedValueOnce(json({}));

    await expect(__vaultFolderTreeTesting.performAction(context, uid, createBody))
      .rejects.toMatchObject({ code: "vault_name_conflict", statusCode: 409 });
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith(":commit"))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith(":rollback"))).toBe(true);
  });

  it("rolls back a transaction acquired before central tree validation fails", async () => {
    const malformedTree = treeDocument();
    malformedTree.fields.folderCount = { integerValue: "1" };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json([
        { found: malformedTree, transaction },
        { found: integrityDocument("ready") },
        { missing: `projects/${projectId}/databases/(default)/documents/noteFolders/folder-a` },
        { missing: `projects/${projectId}/databases/(default)/documents/vaultIntegrity/${uid}/nameClaims/${"C".repeat(43)}` }
      ]))
      .mockResolvedValueOnce(json({}));

    await expect(__vaultFolderTreeTesting.performAction(context, uid, createBody))
      .rejects.toMatchObject({ code: "vault_tree_invalid", statusCode: 409 });
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith(":commit"))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith(":rollback"))).toBe(true);
  });

  it("rejects an imported create when the owned staging job is missing", async () => {
    const importJobId = `vi1_${"I".repeat(43)}`;
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json([
        { found: treeDocument(), transaction },
        { found: integrityDocument("ready") },
        { missing: `projects/${projectId}/databases/(default)/documents/noteFolders/folder-a` },
        { missing: `projects/${projectId}/databases/(default)/documents/vaultIntegrity/${uid}/nameClaims/${"C".repeat(43)}` }
      ]))
      .mockResolvedValueOnce(json([
        {
          missing: `projects/${projectId}/databases/(default)/documents/vaultMaintenanceJobs/${uid}/imports/${importJobId}`
        }
      ]))
      .mockResolvedValueOnce(json({}));

    await expect(__vaultFolderTreeTesting.performAction(context, uid, {
      ...createBody,
      importJobId
    })).rejects.toMatchObject({ code: "vault_import_invalid", statusCode: 409 });
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith(":commit"))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith(":rollback"))).toBe(true);
  });

  it("rejects legacy migration into an imported parent while its job is staging", async () => {
    const importJobId = `vi1_${"I".repeat(43)}`;
    const importedParent = {
      __id: "import-root",
      encryptedName: { version: 1 },
      isDeleted: false,
      parentId: null,
      vaultLineageGeneration: 1,
      wrappedKey: { version: 1 }
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json([
        { found: treeDocument([importedParent]), transaction },
        { found: integrityDocument("pending") },
        {
          found: {
            fields: {
              isDeleted: { booleanValue: false },
              name: { stringValue: "Legacy folder" },
              ownerUid: { stringValue: uid },
              parentId: { nullValue: null }
            },
            name: documentName("noteFolders/legacy-folder"),
            updateTime: timestamp.toISOString()
          }
        },
        {
          missing: documentName(`vaultIntegrity/${uid}/nameClaims/${"L".repeat(43)}`)
        }
      ]))
      .mockResolvedValueOnce(json([]))
      .mockResolvedValueOnce(json([{
        found: {
          fields: {
            isDeleted: { booleanValue: false },
            ownerUid: { stringValue: uid },
            vaultImportJobId: { stringValue: importJobId }
          },
          name: documentName("noteFolders/import-root"),
          updateTime: timestamp.toISOString()
        }
      }]))
      .mockResolvedValueOnce(json([{
        found: {
          fields: {
            kind: { stringValue: "vault-import-v1" },
            ownerUid: { stringValue: uid },
            status: { stringValue: "staging" },
            version: { integerValue: "1" }
          },
          name: documentName(`vaultMaintenanceJobs/${uid}/imports/${importJobId}`),
          updateTime: timestamp.toISOString()
        }
      }]))
      .mockResolvedValueOnce(json({}));

    await expect(__vaultFolderTreeTesting.performAction(context, uid, {
      action: "migrate",
      color: "#7c5cff",
      encryptedName: createBody.encryptedName,
      expectedName: "Legacy folder",
      folderId: "legacy-folder",
      leaseGeneration,
      leaseId,
      nameClaim: {
        claimId: "L".repeat(43),
        indexVersion: 1,
        parentId: "import-root"
      },
      order: 0,
      parentId: "import-root",
      wrappedKey: createBody.wrappedKey
    })).rejects.toMatchObject({ code: "vault_import_locked", statusCode: 409 });
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith(":commit"))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith(":rollback"))).toBe(true);
  });

  it("fails closed when the live import query returns invalid ownership metadata", async () => {
    const importJobId = `vi1_${"Q".repeat(43)}`;
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json([
        { found: treeDocument([ordinaryFolderTreeInput]), transaction },
        { found: integrityDocument("ready") },
        { found: ordinaryFolderDocument() },
        { missing: documentName(`vaultIntegrity/${uid}/nameClaims/${"C".repeat(43)}`) }
      ]))
      .mockResolvedValueOnce(json([{
        document: {
          fields: {
            kind: { stringValue: "vault-import-v1" },
            ownerUid: { stringValue: "other-user" },
            status: { stringValue: "staging" },
            version: { integerValue: "1" }
          },
          name: documentName(`vaultMaintenanceJobs/${uid}/imports/${importJobId}`),
          updateTime: timestamp.toISOString()
        }
      }]))
      .mockResolvedValueOnce(json({}));

    await expect(__vaultFolderTreeTesting.performAction(context, uid, updateBody))
      .rejects.toMatchObject({ code: "vault_import_invalid", statusCode: 409 });
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith(":commit"))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith(":rollback"))).toBe(true);
  });

  it("fails closed without committing when the live import query fails", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json([
        { found: treeDocument([ordinaryFolderTreeInput]), transaction },
        { found: integrityDocument("ready") },
        { found: ordinaryFolderDocument() },
        { missing: documentName(`vaultIntegrity/${uid}/nameClaims/${"C".repeat(43)}`) }
      ]))
      .mockResolvedValueOnce(json({ error: { message: "query unavailable" } }, 503))
      .mockResolvedValueOnce(json({}));

    await expect(__vaultFolderTreeTesting.performAction(context, uid, updateBody))
      .rejects.toBeInstanceOf(Error);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith(":commit"))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith(":rollback"))).toBe(true);
  });
});
