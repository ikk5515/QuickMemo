import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { VaultImportManifestV1 } from "../features/vault/importRollback";
import type { LibraryItemContent } from "../types";
import type { DecryptedLibraryItem } from "./library";
import {
  LibraryVaultPromotionRecoveryError,
  promoteLibraryItemToVault,
  type LibraryVaultPromotionDependencies
} from "./libraryVaultPromotion";
import type { VaultImportJobStatus, VaultImportJobSummary } from "./vaultImportJobs";

const profile = { publicKeyJwk: {}, uid: "owner-a" };
const privateKey = {} as CryptoKey;
let vaultIntegrityKey: CryptoKey;

function content(): LibraryItemContent {
  return {
    archivedAt: null,
    collection: "리서치",
    description: "보존할 요약",
    highlights: [],
    ocrText: "",
    readerBlocks: [{ id: "block-a", kind: "paragraph", text: "보존할 본문" }],
    selectionText: "",
    siteName: "Example",
    sourceFileName: "",
    tags: ["보안"],
    title: "자료실 문서",
    url: "https://example.com/doc",
    version: 1
  };
}

function item(): DecryptedLibraryItem {
  return {
    captureSource: "browser-extension",
    content: content(),
    createdAt: { toMillis: () => Date.UTC(2026, 7, 22) } as never,
    encryptedContent: { algorithm: "AES-GCM", cipherText: "cipher", iv: "iv", version: 1 },
    generationId: "generation_12345678",
    id: "library_item_12345678",
    isFavorite: false,
    itemKey: {} as CryptoKey,
    kind: "clip",
    lastMutationId: "mutation_12345678",
    ownerUid: profile.uid,
    reviewCount: 0,
    revision: 1,
    sourceAttachmentId: null,
    sourceNoteId: null,
    status: "inbox",
    updatedBy: profile.uid,
    urlFingerprint: null,
    wrappedKeys: { [profile.uid]: { algorithm: "RSA-OAEP", version: 1, wrappedKey: "wrapped" } }
  } as DecryptedLibraryItem;
}

type PromotionTarget = Awaited<ReturnType<LibraryVaultPromotionDependencies["readTarget"]>>;

function dependencyHarness() {
  let target: PromotionTarget = null;
  let storedJob: VaultImportJobSummary | null = null;
  let lastJobId = "vi1_" + "A".repeat(43);
  let lastManifest: VaultImportManifestV1 | null = null;

  function job(
    status: VaultImportJobStatus,
    overrides: Partial<VaultImportJobSummary> = {}
  ): VaultImportJobSummary {
    return {
      chunkCount: 1,
      entryCount: 1,
      folderCount: 0,
      itemCount: 1,
      jobId: lastJobId,
      lastErrorCode: status === "blocked" ? "write-failed" : null,
      manifest: lastManifest,
      remainingChunkCount: 1,
      revision: status === "preparing" ? 1 : status === "staging" ? 2 : 3,
      rootFolderCount: 0,
      status,
      ...overrides
    };
  }

  const mocks = {
    cleanupJob: vi.fn(async () => {
      storedJob = null;
      return { cleaned: true as const, removedChunks: 1 };
    }),
    commitJob: vi.fn(async () => {
      if (!storedJob) throw new Error("job missing");
      storedJob = { ...storedJob, revision: storedJob.revision + 1, status: "committed" };
      return storedJob;
    }),
    createEntry: vi.fn(async (_profile, _key, draft, options) => {
      if (target) throw new Error("already exists");
      target = {
        body: draft.body,
        contentFormat: draft.contentFormat,
        entryKind: draft.entryKind,
        folderId: draft.folderId,
        isDeleted: false,
        isPurged: false,
        noteId: options?.targetId ?? "",
        ownerUid: profile.uid,
        revision: 1,
        title: draft.title,
        vaultImportJobId: options?.importJobId
      };
      return { noteId: options?.targetId ?? "", revision: 1 };
    }),
    ensureJob: vi.fn(async (input) => {
      lastJobId = input.jobId;
      lastManifest = input.manifest;
      if (storedJob?.status === "preparing" || !storedJob) {
        storedJob = job("staging");
      }
      return storedJob;
    }),
    loadJob: vi.fn(async () => storedJob),
    readTarget: vi.fn(async () => target),
    rollbackJob: vi.fn(async () => {
      if (storedJob?.status === "committed") {
        return {
          ...storedJob,
          alreadyCleaned: 0,
          entrySoftDeleted: 0,
          folderRootsTrashed: 0
        };
      }
      storedJob = job("rolled-back");
      return {
        ...storedJob,
        alreadyCleaned: 0,
        entrySoftDeleted: 0,
        folderRootsTrashed: 0
      };
    })
  } satisfies LibraryVaultPromotionDependencies;

  return {
    dependencies: mocks,
    getJob: () => storedJob,
    getManifest: () => lastManifest,
    getTarget: () => target,
    job,
    setJob: (next: VaultImportJobSummary | null) => { storedJob = next; },
    setTarget: (next: PromotionTarget) => { target = next; }
  };
}

async function promote(setup: ReturnType<typeof dependencyHarness>) {
  return promoteLibraryItemToVault({
    item: item(),
    privateKey,
    profile,
    vaultIntegrityKey
  }, setup.dependencies);
}

describe("library Vault promotion", () => {
  beforeAll(async () => {
    vaultIntegrityKey = await crypto.subtle.generateKey(
      { length: 256, name: "AES-GCM" },
      true,
      ["encrypt", "decrypt"]
    );
  });
  beforeEach(() => vi.clearAllMocks());

  it("atomically promotes encrypted Markdown without mutating the Library item", async () => {
    const source = item();
    const before = JSON.stringify(source.content);
    const setup = dependencyHarness();
    const result = await promoteLibraryItemToVault({
      item: source,
      privateKey,
      profile,
      vaultIntegrityKey
    }, setup.dependencies);

    expect(result.state).toBe("created");
    expect(result.noteId).toMatch(/^vit1_[A-Za-z0-9_-]{43}$/u);
    expect(result.body).toContain("# 자료실 문서");
    expect(setup.dependencies.loadJob).toHaveBeenCalledBefore(setup.dependencies.ensureJob);
    expect(setup.dependencies.ensureJob).toHaveBeenCalledBefore(setup.dependencies.createEntry);
    expect(setup.dependencies.createEntry).toHaveBeenCalledBefore(setup.dependencies.commitJob);
    expect(setup.dependencies.commitJob).toHaveBeenCalledOnce();
    expect(setup.dependencies.rollbackJob).not.toHaveBeenCalled();
    expect(JSON.stringify(source.content)).toBe(before);
  });

  it("returns an edited and moved promoted target without recreating terminal metadata", async () => {
    const setup = dependencyHarness();
    const first = await promote(setup);
    const existing = setup.getTarget();
    if (!existing) throw new Error("test target missing");
    setup.setTarget({
      ...existing,
      body: `${existing.body}\n\n사용자 편집`,
      folderId: "moved-folder",
      revision: 2,
      title: "사용자가 바꾼 제목"
    });
    vi.clearAllMocks();

    const repeated = await promote(setup);

    expect(repeated).toMatchObject({
      noteId: first.noteId,
      revision: 2,
      state: "existing",
      title: "사용자가 바꾼 제목"
    });
    expect(setup.dependencies.readTarget).toHaveBeenCalledOnce();
    expect(setup.dependencies.ensureJob).not.toHaveBeenCalled();
    expect(setup.dependencies.createEntry).not.toHaveBeenCalled();
    expect(setup.dependencies.commitJob).not.toHaveBeenCalled();
  });

  it("recovers a lost create response by verifying and committing the exact server entry", async () => {
    const setup = dependencyHarness();
    vi.mocked(setup.dependencies.createEntry).mockImplementationOnce(async (_profile, _key, draft, options) => {
      setup.setTarget({
        body: draft.body,
        contentFormat: draft.contentFormat,
        entryKind: draft.entryKind,
        folderId: draft.folderId,
        isDeleted: false,
        isPurged: false,
        noteId: options?.targetId ?? "",
        ownerUid: profile.uid,
        revision: 1,
        title: draft.title,
        vaultImportJobId: options?.importJobId
      });
      throw new Error("network response lost");
    });

    const result = await promote(setup);

    expect(result.state).toBe("recovered");
    expect(setup.dependencies.commitJob).toHaveBeenCalledOnce();
    expect(setup.dependencies.rollbackJob).not.toHaveBeenCalled();
  });

  it("resumes preparing metadata through staging before creating the target", async () => {
    const setup = dependencyHarness();
    await promote(setup);
    setup.setTarget(null);
    setup.setJob(setup.job("preparing", { manifest: null }));
    vi.clearAllMocks();

    const result = await promote(setup);

    expect(result.state).toBe("recovered");
    expect(setup.dependencies.ensureJob).toHaveBeenCalledOnce();
    expect(setup.dependencies.createEntry).toHaveBeenCalledOnce();
  });

  it("fails closed when a preparing job already has a provenance target", async () => {
    const setup = dependencyHarness();
    await promote(setup);
    setup.setJob(setup.job("preparing", { manifest: null }));
    vi.clearAllMocks();

    await expect(promote(setup)).rejects.toBeInstanceOf(LibraryVaultPromotionRecoveryError);
    expect(setup.dependencies.ensureJob).not.toHaveBeenCalled();
    expect(setup.dependencies.commitJob).not.toHaveBeenCalled();
    expect(setup.dependencies.cleanupJob).not.toHaveBeenCalled();
  });

  it("resumes a manifest-complete staging job without ensuring it again", async () => {
    const setup = dependencyHarness();
    await promote(setup);
    setup.setTarget(null);
    setup.setJob(setup.job("staging"));
    vi.clearAllMocks();

    const result = await promote(setup);

    expect(result.state).toBe("recovered");
    expect(setup.dependencies.ensureJob).not.toHaveBeenCalled();
    expect(setup.dependencies.createEntry).toHaveBeenCalledOnce();
  });

  it("verifies a committed target and cleans terminal metadata without another create", async () => {
    const setup = dependencyHarness();
    await promote(setup);
    setup.setJob(setup.job("committed"));
    vi.clearAllMocks();

    const result = await promote(setup);

    expect(result.state).toBe("recovered");
    expect(setup.dependencies.createEntry).not.toHaveBeenCalled();
    expect(setup.dependencies.ensureJob).not.toHaveBeenCalled();
    expect(setup.dependencies.readTarget).toHaveBeenCalledOnce();
    expect(setup.dependencies.cleanupJob).toHaveBeenCalledOnce();
  });

  it("does not commit or clean a live job whose target was edited or moved", async () => {
    const setup = dependencyHarness();
    await promote(setup);
    const existing = setup.getTarget();
    if (!existing) throw new Error("test target missing");
    setup.setTarget({
      ...existing,
      body: `${existing.body}\ncorrupt-live-job-change`,
      folderId: "wrong-folder",
      revision: 2
    });

    for (const status of ["staging", "committed"] as const) {
      setup.setJob(setup.job(status));
      vi.clearAllMocks();
      await expect(promote(setup)).rejects.toThrow("일치하지 않습니다");
      expect(setup.dependencies.commitJob).not.toHaveBeenCalled();
      expect(setup.dependencies.cleanupJob).not.toHaveBeenCalled();
      expect(setup.dependencies.rollbackJob).not.toHaveBeenCalled();
    }
  });

  it("fails closed when a committed job has no exact target", async () => {
    const setup = dependencyHarness();
    await promote(setup);
    setup.setTarget(null);
    setup.setJob(setup.job("committed"));
    vi.clearAllMocks();

    await expect(promote(setup)).rejects.toBeInstanceOf(LibraryVaultPromotionRecoveryError);
    expect(setup.dependencies.createEntry).not.toHaveBeenCalled();
    expect(setup.dependencies.cleanupJob).not.toHaveBeenCalled();
  });

  it("cleans rolled-back metadata before replaying the deterministic operation", async () => {
    const setup = dependencyHarness();
    await promote(setup);
    setup.setTarget(null);
    setup.setJob(setup.job("rolled-back"));
    vi.clearAllMocks();

    const result = await promote(setup);

    expect(result.state).toBe("recovered");
    expect(setup.dependencies.cleanupJob).toHaveBeenCalledBefore(setup.dependencies.ensureJob);
    expect(setup.dependencies.createEntry).toHaveBeenCalledOnce();
  });

  it("rejects a mismatched persisted manifest before any target probe or write", async () => {
    const setup = dependencyHarness();
    await promote(setup);
    const manifest = setup.getManifest();
    if (!manifest) throw new Error("test manifest missing");
    setup.setJob(setup.job("staging", {
      manifest: {
        ...manifest,
        targets: [{ ...manifest.targets[0], targetId: "vit1_" + "X".repeat(43) }]
      }
    }));
    setup.setTarget(null);
    vi.clearAllMocks();

    await expect(promote(setup)).rejects.toThrow("승격 계획");
    expect(setup.dependencies.readTarget).toHaveBeenCalledOnce();
    expect(setup.dependencies.createEntry).not.toHaveBeenCalled();
  });

  it("blocks rolling-back or blocked jobs for explicit recovery", async () => {
    const setup = dependencyHarness();
    await promote(setup);
    for (const status of ["rolled-back", "rolling-back", "blocked"] as const) {
      setup.setJob(setup.job(status));
      vi.clearAllMocks();
      await expect(promote(setup)).rejects.toBeInstanceOf(LibraryVaultPromotionRecoveryError);
      expect(setup.dependencies.createEntry).not.toHaveBeenCalled();
    }
  });

  it("rolls back a failed staging job so no active note or name claim remains", async () => {
    const setup = dependencyHarness();
    vi.mocked(setup.dependencies.createEntry).mockRejectedValueOnce(new Error("write failed"));

    await expect(promote(setup)).rejects.toThrow("write failed");

    expect(setup.dependencies.rollbackJob).toHaveBeenCalledOnce();
    expect(setup.dependencies.cleanupJob).toHaveBeenCalledOnce();
    expect(setup.getJob()).toBeNull();
  });

  it("fails closed with a non-sensitive recovery message when compensation cannot finish", async () => {
    const setup = dependencyHarness();
    vi.mocked(setup.dependencies.createEntry).mockRejectedValueOnce(new Error("sensitive-item-id"));
    vi.mocked(setup.dependencies.loadJob)
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("offline"));
    vi.mocked(setup.dependencies.rollbackJob).mockRejectedValueOnce(new Error("offline"));

    const caught = await promote(setup).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(LibraryVaultPromotionRecoveryError);
    expect((caught as Error).message).not.toContain("sensitive-item-id");
  });

  it("rejects an invalid Vault title before loading or creating maintenance metadata", async () => {
    const setup = dependencyHarness();
    await expect(promoteLibraryItemToVault({
      item: item(),
      privateKey,
      profile,
      title: "../",
      vaultIntegrityKey
    }, setup.dependencies)).rejects.toThrow("이름");
    expect(setup.dependencies.loadJob).not.toHaveBeenCalled();
    expect(setup.dependencies.ensureJob).not.toHaveBeenCalled();
    expect(setup.dependencies.createEntry).not.toHaveBeenCalled();
  });
});
