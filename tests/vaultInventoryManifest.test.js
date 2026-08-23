import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalVaultInventoryManifestBinding,
  canonicalVaultInventoryManifestEntryKey,
  canonicalVaultInventoryManifestEntryToken,
  canonicalVaultInventoryManifestShard,
  vaultInventoryManifestContract,
  vaultInventoryManifestMarkerPath,
  vaultInventoryManifestShardId,
  vaultInventoryManifestShardIndexFromEntryKey,
  vaultInventoryManifestShardPath
} from "../shared/vault-inventory-manifest.js";

const uid = "user-a";
const timestamp = "2026-08-24T00:00:00.000Z";

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function activeNote(overrides = {}) {
  return {
    id: "Note_A-1",
    ownerUid: uid,
    revision: 3,
    folderId: null,
    type: "personal",
    contentFormat: "markdown-v1",
    entryKind: "markdown",
    encryptedTitle: { algorithm: "AES-GCM", version: 1 },
    encryptedBody: { algorithm: "AES-GCM", version: 1 },
    isDeleted: false,
    ...overrides
  };
}

function marker(epoch = 1) {
  return {
    __id: "marker",
    createdAt: timestamp,
    epoch,
    ownerUid: uid,
    shardCount: vaultInventoryManifestContract.shardCount,
    updatedAt: timestamp,
    version: vaultInventoryManifestContract.version
  };
}

function emptyShards(epoch = 1) {
  return Array.from({ length: vaultInventoryManifestContract.shardCount }, (_, shardIndex) => {
    const entries = {};
    const revision = 1;
    return {
      __id: vaultInventoryManifestShardId(shardIndex),
      createdAt: timestamp,
      entries,
      epoch,
      ownerUid: uid,
      revision,
      root: digest(canonicalVaultInventoryManifestShard({
        entries,
        epoch,
        revision,
        shardIndex,
        uid
      })),
      shardIndex,
      updatedAt: timestamp,
      version: vaultInventoryManifestContract.version
    };
  });
}

function addDocument(shards, kind, document) {
  const entryKey = digest(canonicalVaultInventoryManifestEntryKey({ document, kind, uid }));
  const tokenPreimage = canonicalVaultInventoryManifestEntryToken({ document, kind, uid });
  if (tokenPreimage === null) return { entryKey, token: null };
  const token = digest(tokenPreimage);
  const shardIndex = vaultInventoryManifestShardIndexFromEntryKey(entryKey);
  const shard = shards[shardIndex];
  shard.entries = { ...shard.entries, [entryKey]: token };
  shard.revision += 1;
  shard.root = digest(canonicalVaultInventoryManifestShard({
    entries: shard.entries,
    epoch: shard.epoch,
    revision: shard.revision,
    shardIndex,
    uid
  }));
  return { entryKey, token };
}

describe("Vault inventory manifest contract", () => {
  it("uses exact four-segment marker and shard document paths", () => {
    expect(vaultInventoryManifestMarkerPath(uid))
      .toBe("vaultMaintenanceJobs/user-a/pathRewriteInventory/marker");
    expect(vaultInventoryManifestShardPath(uid, 0))
      .toBe("vaultMaintenanceJobs/user-a/pathRewriteInventory/shard-00");
    expect(vaultInventoryManifestShardPath(uid, 31))
      .toBe("vaultMaintenanceJobs/user-a/pathRewriteInventory/shard-31");
  });

  it("creates opaque, deterministic keys and revision-bound tokens", () => {
    const note = activeNote();
    const key = digest(canonicalVaultInventoryManifestEntryKey({ document: note, kind: "note", uid }));
    const first = digest(canonicalVaultInventoryManifestEntryToken({ document: note, kind: "note", uid }));
    const second = digest(canonicalVaultInventoryManifestEntryToken({
      document: { ...note, revision: 4 },
      kind: "note",
      uid
    }));
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(first).not.toBe(second);
    expect(vaultInventoryManifestShardIndexFromEntryKey(key)).toBeGreaterThanOrEqual(0);
    expect(vaultInventoryManifestShardIndexFromEntryKey(key)).toBeLessThan(32);
  });

  it("excludes copying, aborted, deleted and purged notes with the pr2 membership rules", () => {
    for (const overrides of [
      { secureShareCopyState: "copying" },
      { secureShareCopyState: "aborted" },
      { isDeleted: true },
      { isPurged: true }
    ]) {
      expect(canonicalVaultInventoryManifestEntryToken({
        document: activeNote(overrides),
        kind: "note",
        uid
      })).toBeNull();
    }
  });

  it("sorts mixed-case and punctuation entry digests with binary ordering", () => {
    for (const [shardIndex, entries] of [
      [0, {
        [`g${"0".repeat(42)}`]: "T".repeat(43),
        [`A${"0".repeat(42)}`]: "U".repeat(43)
      }],
      [30, {
        [`-${"0".repeat(42)}`]: "V".repeat(43),
        [`e${"0".repeat(42)}`]: "W".repeat(43)
      }]
    ]) {
      const reversed = Object.fromEntries(Object.entries(entries).reverse());
      expect(canonicalVaultInventoryManifestShard({
        entries,
        epoch: 1,
        revision: 1,
        shardIndex,
        uid
      })).toBe(canonicalVaultInventoryManifestShard({
        entries: reversed,
        epoch: 1,
        revision: 1,
        shardIndex,
        uid
      }));
    }
  });

  it("rejects a misplaced entry and a shard over its fixed safety capacity", () => {
    expect(() => canonicalVaultInventoryManifestShard({
      entries: { [`B${"0".repeat(42)}`]: "T".repeat(43) },
      epoch: 1,
      revision: 1,
      shardIndex: 0,
      uid
    })).toThrow("shard entry");

    const entries = Object.fromEntries(Array.from(
      { length: vaultInventoryManifestContract.maximumEntriesPerShard + 1 },
      (_, index) => [
        `A${index.toString(36).padStart(42, "0")}`,
        digest(`token-${index}`)
      ]
    ));
    expect(() => canonicalVaultInventoryManifestShard({
      entries,
      epoch: 1,
      revision: 1,
      shardIndex: 0,
      uid
    })).toThrow("safe entry limit");
  });

  it("binds exactly 32 unique shard summaries and changes on a single mutation", () => {
    const shards = emptyShards();
    const before = digest(canonicalVaultInventoryManifestBinding({ marker: marker(), shards, uid }));
    addDocument(shards, "note", activeNote());
    const after = digest(canonicalVaultInventoryManifestBinding({ marker: marker(), shards, uid }));
    expect(after).not.toBe(before);
    expect(digest(canonicalVaultInventoryManifestBinding({
      marker: marker(),
      shards: [...shards].reverse(),
      uid
    }))).toBe(after);

    expect(() => canonicalVaultInventoryManifestBinding({
      marker: marker(),
      shards: shards.slice(1),
      uid
    })).toThrow("incomplete");
    expect(() => canonicalVaultInventoryManifestBinding({
      marker: marker(),
      shards: [...shards.slice(0, -1), shards[0]],
      uid
    })).toThrow("shard set");
  });
});
