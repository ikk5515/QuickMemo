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
const pasteLockId = `vpl1_${"P".repeat(43)}`;
const otherPasteLockId = `vpl1_${"Q".repeat(43)}`;
const pasteLockNow = new Date("2026-08-23T01:00:00.000Z");
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

function ordinaryFolderDocument(options: {
  lock?: { expiresAt: string; id: string; malformedExtraField?: boolean };
  ownerUid?: string;
  parentId?: string | null;
  revision?: number;
} = {}) {
  const parentId = options.parentId ?? null;
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
      ownerUid: { stringValue: options.ownerUid ?? uid },
      parentId: parentId === null
        ? { nullValue: null }
        : { stringValue: parentId },
      revision: { integerValue: String(options.revision ?? 1) },
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
      },
      ...(options.lock ? {
        vaultPasteLock: {
          mapValue: {
            fields: {
              expiresAt: { timestampValue: options.lock.expiresAt },
              id: { stringValue: options.lock.id },
              ...(options.lock.malformedExtraField
                ? { unexpected: { booleanValue: true } }
                : {})
            }
          }
        }
      } : {})
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

const pasteLockAcquireBody = {
  action: "paste-lock-acquire",
  expectedRevision: 1,
  folderId: "folder-a",
  lockId: pasteLockId
} as const;

function pasteLockExpiry(offsetMilliseconds: number) {
  return new Date(pasteLockNow.getTime() + offsetMilliseconds).toISOString();
}

describe("Vault folder server transaction boundary", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("commits tree, encrypted folder, and name claim in one preconditioned transaction", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json([
        { found: treeDocument(), transaction },
        { found: integrityDocument("ready") },
        { missing: `projects/${projectId}/databases/(default)/documents/noteFolders/folder-a` },
        { missing: `projects/${projectId}/databases/(default)/documents/vaultIntegrity/${uid}/nameClaims/${"C".repeat(43)}` }
      ]))
      .mockResolvedValueOnce(json([]))
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
      .rejects.toMatchObject({ code: "vault_tree_repair_required", statusCode: 409 });
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

  it("acquires a 120-second root-folder lock without changing folder or tree revisions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(pasteLockNow);
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json([
        { found: treeDocument([ordinaryFolderTreeInput]), transaction },
        { found: integrityDocument("ready") },
        { found: ordinaryFolderDocument() }
      ]))
      .mockResolvedValueOnce(json({ commitTime: timestamp.toISOString(), writeResults: [] }));

    await expect(__vaultFolderTreeTesting.performAction(
      context,
      uid,
      pasteLockAcquireBody
    )).resolves.toEqual({ folderId: "folder-a", revision: 1, treeRevision: 1 });

    const commitCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith(":commit"));
    const payload = JSON.parse(String((commitCall?.[1] as RequestInit | undefined)?.body)) as {
      writes: Array<{
        update: { fields: Record<string, unknown> };
        updateMask: { fieldPaths: string[] };
      }>;
    };
    expect(payload.writes).toHaveLength(1);
    expect(payload.writes[0]?.updateMask.fieldPaths).toEqual(["vaultPasteLock"]);
    expect(payload.writes[0]?.update.fields).toEqual({
      vaultPasteLock: {
        mapValue: {
          fields: {
            expiresAt: { timestampValue: pasteLockExpiry(120_000) },
            id: { stringValue: pasteLockId }
          }
        }
      }
    });
    expect(JSON.stringify(payload)).not.toContain("revision");
  });

  it("refreshes the same active lock to a full server-timed TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(pasteLockNow);
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json([
        { found: treeDocument([ordinaryFolderTreeInput]), transaction },
        { found: integrityDocument("ready") },
        {
          found: ordinaryFolderDocument({
            lock: { expiresAt: pasteLockExpiry(60_000), id: pasteLockId }
          })
        }
      ]))
      .mockResolvedValueOnce(json({ commitTime: timestamp.toISOString(), writeResults: [] }));

    await expect(__vaultFolderTreeTesting.performAction(
      context,
      uid,
      pasteLockAcquireBody
    )).resolves.toEqual({ folderId: "folder-a", revision: 1, treeRevision: 1 });
    const commitCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith(":commit"));
    const payload = JSON.parse(String((commitCall?.[1] as RequestInit | undefined)?.body)) as {
      writes: Array<{ update: { fields: Record<string, unknown> }; updateMask: { fieldPaths: string[] } }>;
    };
    expect(payload.writes).toEqual([expect.objectContaining({
      update: expect.objectContaining({
        fields: {
          vaultPasteLock: {
            mapValue: {
              fields: {
                expiresAt: { timestampValue: pasteLockExpiry(120_000) },
                id: { stringValue: pasteLockId }
              }
            }
          }
        }
      }),
      updateMask: { fieldPaths: ["vaultPasteLock"] }
    })]);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith(":rollback"))).toBe(false);
  });

  it("rejects normal mutation for an active or malformed pasted-image lock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(pasteLockNow);
    for (const lock of [
      { expiresAt: pasteLockExpiry(60_000), id: pasteLockId },
      { expiresAt: pasteLockExpiry(60_000), id: pasteLockId, malformedExtraField: true }
    ]) {
      const fetchMock = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(json([
          { found: treeDocument([ordinaryFolderTreeInput]), transaction },
          { found: integrityDocument("ready") },
          { found: ordinaryFolderDocument({ lock }) },
          { missing: documentName(`vaultIntegrity/${uid}/nameClaims/${"C".repeat(43)}`) }
        ]))
        .mockResolvedValueOnce(json({}));

      await expect(__vaultFolderTreeTesting.performAction(context, uid, updateBody))
        .rejects.toMatchObject({ code: "vault_paste_locked", statusCode: 409 });
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith(":commit"))).toBe(false);
      fetchMock.mockRestore();
    }
  });

  it("overwrites an expired lock with a new lock id", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(pasteLockNow);
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json([
        { found: treeDocument([ordinaryFolderTreeInput]), transaction },
        { found: integrityDocument("ready") },
        {
          found: ordinaryFolderDocument({
            lock: { expiresAt: pasteLockExpiry(-1), id: otherPasteLockId }
          })
        }
      ]))
      .mockResolvedValueOnce(json({ commitTime: timestamp.toISOString(), writeResults: [] }));

    await expect(__vaultFolderTreeTesting.performAction(
      context,
      uid,
      pasteLockAcquireBody
    )).resolves.toEqual({ folderId: "folder-a", revision: 1, treeRevision: 1 });
    const commitBody = String(fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith(":commit"))?.[1]?.body);
    expect(commitBody).toContain(pasteLockId);
    expect(commitBody).not.toContain(otherPasteLockId);
  });

  it("releases only a matching lock and keeps absent or different locks idempotent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(pasteLockNow);
    const activeLock = {
      expiresAt: pasteLockExpiry(60_000),
      id: pasteLockId
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json([
        { found: treeDocument([ordinaryFolderTreeInput]), transaction },
        { found: integrityDocument("pending") },
        { found: ordinaryFolderDocument({ lock: activeLock }) }
      ]))
      .mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(json([
        { found: treeDocument([ordinaryFolderTreeInput]), transaction },
        { found: integrityDocument("ready") },
        { found: ordinaryFolderDocument() }
      ]))
      .mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(json([
        { found: treeDocument([ordinaryFolderTreeInput]), transaction },
        { found: integrityDocument("ready") },
        { found: ordinaryFolderDocument({ lock: activeLock }) }
      ]))
      .mockResolvedValueOnce(json({ commitTime: timestamp.toISOString(), writeResults: [] }));

    await expect(__vaultFolderTreeTesting.performAction(context, uid, {
      action: "paste-lock-release",
      folderId: "folder-a",
      lockId: otherPasteLockId
    })).resolves.toEqual({ folderId: "folder-a", revision: 1, treeRevision: 1 });
    await expect(__vaultFolderTreeTesting.performAction(context, uid, {
      action: "paste-lock-release",
      folderId: "folder-a",
      lockId: pasteLockId
    })).resolves.toEqual({ folderId: "folder-a", revision: 1, treeRevision: 1 });
    await expect(__vaultFolderTreeTesting.performAction(context, uid, {
      action: "paste-lock-release",
      folderId: "folder-a",
      lockId: pasteLockId
    })).resolves.toEqual({ folderId: "folder-a", revision: 1, treeRevision: 1 });

    const commits = fetchMock.mock.calls.filter(([url]) => String(url).endsWith(":commit"));
    expect(commits).toHaveLength(1);
    const payload = JSON.parse(String((commits[0]?.[1] as RequestInit | undefined)?.body)) as {
      writes: Array<{ update: { fields: Record<string, unknown> }; updateMask: { fieldPaths: string[] } }>;
    };
    expect(payload.writes).toEqual([expect.objectContaining({
      update: expect.objectContaining({ fields: {} }),
      updateMask: { fieldPaths: ["vaultPasteLock"] }
    })]);
  });

  it("requires a current revision, ready integrity, owner match, and active root placement", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(pasteLockNow);
    const parentTreeInput = {
      ...ordinaryFolderTreeInput,
      __id: "parent-a"
    };
    const childTreeInput = {
      ...ordinaryFolderTreeInput,
      parentId: "parent-a"
    };
    const cases = [
      {
        body: { ...pasteLockAcquireBody, expectedRevision: 2 },
        expectedCode: "revision_conflict",
        folder: ordinaryFolderDocument(),
        integrity: integrityDocument("ready"),
        tree: treeDocument([ordinaryFolderTreeInput])
      },
      {
        body: pasteLockAcquireBody,
        expectedCode: "vault_integrity_not_ready",
        folder: ordinaryFolderDocument(),
        integrity: integrityDocument("pending"),
        tree: treeDocument([ordinaryFolderTreeInput])
      },
      {
        body: pasteLockAcquireBody,
        expectedCode: "vault_folder_not_found",
        folder: ordinaryFolderDocument({ ownerUid: "other-user" }),
        integrity: integrityDocument("ready"),
        tree: treeDocument([ordinaryFolderTreeInput])
      },
      {
        body: pasteLockAcquireBody,
        expectedCode: "vault_folder_unavailable",
        folder: ordinaryFolderDocument({ parentId: "parent-a" }),
        integrity: integrityDocument("ready"),
        tree: treeDocument([parentTreeInput, childTreeInput])
      }
    ];

    for (const testCase of cases) {
      const fetchMock = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(json([
          { found: testCase.tree, transaction },
          { found: testCase.integrity },
          { found: testCase.folder }
        ]))
        .mockResolvedValueOnce(json({}));
      await expect(__vaultFolderTreeTesting.performAction(context, uid, testCase.body))
        .rejects.toMatchObject({ code: testCase.expectedCode });
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith(":commit"))).toBe(false);
      fetchMock.mockRestore();
    }
  });
});
