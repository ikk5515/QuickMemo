import { beforeAll, describe, expect, it } from "vitest";
import {
  buildVaultPathRewriteSourcePlans,
  classifyVaultPathRewriteSourceState,
  prepareVaultPathRewriteJob,
  type VaultPathRewriteSourcePlan
} from "./pathRewriteJob";

let integrityKey: CryptoKey;

beforeAll(async () => {
  if (!globalThis.crypto?.subtle) {
    const { webcrypto } = await import("node:crypto");
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
  }
  integrityKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
});

function sourcePlan(overrides: Partial<VaultPathRewriteSourcePlan> = {}): VaultPathRewriteSourcePlan {
  return {
    sourceEntryId: "source-a",
    sourceKind: "markdown",
    expectedRevision: 4,
    originalSource: "See [[Folder/Old]].",
    rewrittenSource: "See [[Archive/New]].",
    changeCount: 1,
    ...overrides
  };
}

describe("durable Vault path rewrite job planning", () => {
  it("derives a deterministic opaque ID and keeps paths and source bodies out of clear manifest metadata", async () => {
    const input = {
      ownerUid: "user-a",
      pathChanges: [{ entryId: "target-a", oldPath: "Folder/Old.md", newPath: "Archive/New.md" }],
      sourcePlans: [sourcePlan()]
    };

    const first = await prepareVaultPathRewriteJob(integrityKey, input);
    const second = await prepareVaultPathRewriteJob(integrityKey, input);

    expect(first.jobId).toMatch(/^pr1_[A-Za-z0-9_-]{43}$/);
    expect(second.jobId).toBe(first.jobId);
    expect(first.steps[0]).toMatchObject({
      ordinal: 0,
      sourceEntryId: "source-a",
      expectedRevision: 4,
      rewrittenSource: "See [[Archive/New]]."
    });
    expect(first.manifest.steps[0]).not.toHaveProperty("rewrittenSource");
    expect(JSON.stringify(first.manifest.steps)).not.toContain("See [[");

    const different = await prepareVaultPathRewriteJob(integrityKey, {
      ...input,
      sourcePlans: [sourcePlan({ rewrittenSource: "See [[Archive/Other]]." })]
    });
    expect(different.jobId).not.toBe(first.jobId);
  });

  it("normalizes ordering so equivalent complete plans resume under one ID", async () => {
    const left = sourcePlan({ sourceEntryId: "source-z" });
    const right = sourcePlan({
      sourceEntryId: "source-a",
      originalSource: "![[Old.png]]",
      rewrittenSource: "![[Media/New.png]]"
    });
    const forward = await prepareVaultPathRewriteJob(integrityKey, {
      ownerUid: "user-a",
      pathChanges: [
        { entryId: "target-z", oldPath: "z.md", newPath: "moved/z.md" },
        { entryId: "target-a", oldPath: "a.md", newPath: "moved/a.md" }
      ],
      sourcePlans: [left, right]
    });
    const reverse = await prepareVaultPathRewriteJob(integrityKey, {
      ownerUid: "user-a",
      pathChanges: [
        { entryId: "target-a", oldPath: "a.md", newPath: "moved/a.md" },
        { entryId: "target-z", oldPath: "z.md", newPath: "moved/z.md" }
      ],
      sourcePlans: [right, left]
    });

    expect(reverse.jobId).toBe(forward.jobId);
    expect(forward.steps.map((step) => step.sourceEntryId)).toEqual(["source-a", "source-z"]);
  });

  it("builds current Markdown and Canvas source plans and fails closed for stale sources", () => {
    const entries = [
      { id: "markdown-a", path: "Notes/A.md", kind: "markdown" as const, content: "[[Old]]", revision: 2 },
      { id: "canvas-a", path: "Map.canvas", kind: "canvas" as const, content: "{\"nodes\":[]}", revision: 7 }
    ];
    const plans = buildVaultPathRewriteSourcePlans({
      entries,
      markdownPlans: [{
        sourceEntryId: "markdown-a",
        sourcePath: "Notes/A.md",
        rewrittenSourcePath: "Notes/A.md",
        expectedRevision: 2,
        patches: [{ start: 2, end: 5, before: "Old", after: "New", syntax: "wikilink", line: 1, column: 3 }]
      }],
      canvasPlans: [{
        sourceEntryId: "canvas-a",
        sourcePath: "Map.canvas",
        rewrittenSourcePath: "Map.canvas",
        expectedRevision: 7,
        originalSource: "{\"nodes\":[]}",
        rewrittenSource: "{\n  \"nodes\": []\n}\n",
        changeCount: 1
      }]
    });

    expect(plans).toEqual([
      expect.objectContaining({ sourceEntryId: "markdown-a", rewrittenSource: "[[New]]" }),
      expect.objectContaining({ sourceEntryId: "canvas-a", sourceKind: "canvas" })
    ]);
    expect(() => buildVaultPathRewriteSourcePlans({
      entries: [{ ...entries[0], revision: 3 }],
      markdownPlans: [{
        sourceEntryId: "markdown-a",
        sourcePath: "Notes/A.md",
        rewrittenSourcePath: "Notes/A.md",
        expectedRevision: 2,
        patches: [{ start: 2, end: 5, before: "Old", after: "New", syntax: "wikilink", line: 1, column: 3 }]
      }],
      canvasPlans: []
    })).toThrow("현재 source");
  });

  it("classifies only exact revision-and-digest states as pending or confirmed", async () => {
    const prepared = await prepareVaultPathRewriteJob(integrityKey, {
      ownerUid: "user-a",
      pathChanges: [{ entryId: "target-a", oldPath: "Old.md", newPath: "New.md" }],
      sourcePlans: [sourcePlan()]
    });
    const step = prepared.steps[0];

    await expect(classifyVaultPathRewriteSourceState(step, {
      revision: 4,
      source: "See [[Folder/Old]]."
    })).resolves.toMatchObject({ state: "pending" });
    await expect(classifyVaultPathRewriteSourceState(step, {
      revision: 5,
      source: "See [[Archive/New]]."
    })).resolves.toMatchObject({ state: "confirmed" });
    await expect(classifyVaultPathRewriteSourceState(step, {
      revision: 6,
      source: "See [[Archive/New]]."
    })).resolves.toMatchObject({ state: "blocked", reason: "revision-mismatch" });
    await expect(classifyVaultPathRewriteSourceState(step, {
      revision: 5,
      source: "tampered"
    })).resolves.toMatchObject({ state: "blocked", reason: "content-mismatch" });
  });

  it("rejects unsafe paths, duplicate sources, no-op content and oversized source bodies", async () => {
    await expect(prepareVaultPathRewriteJob(integrityKey, {
      ownerUid: "user-a",
      pathChanges: [{ entryId: "target-a", oldPath: "../Old.md", newPath: "New.md" }],
      sourcePlans: []
    })).rejects.toThrow();
    await expect(prepareVaultPathRewriteJob(integrityKey, {
      ownerUid: "user-a",
      pathChanges: [{ entryId: "target-a", oldPath: "Old.md", newPath: "New.md" }],
      sourcePlans: [sourcePlan(), sourcePlan()]
    })).rejects.toThrow("중복");
    await expect(prepareVaultPathRewriteJob(integrityKey, {
      ownerUid: "user-a",
      pathChanges: [{ entryId: "target-a", oldPath: "Old.md", newPath: "New.md" }],
      sourcePlans: [sourcePlan({ rewrittenSource: "See [[Folder/Old]]." })]
    })).rejects.toThrow("실제 내용 변경");
    await expect(prepareVaultPathRewriteJob(integrityKey, {
      ownerUid: "user-a",
      pathChanges: [{ entryId: "target-a", oldPath: "Old.md", newPath: "New.md" }],
      sourcePlans: [sourcePlan({ rewrittenSource: "가".repeat(200_000) })]
    })).rejects.toThrow("크기");
  });
});
