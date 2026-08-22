import { describe, expect, it, vi } from "vitest";
import {
  executeNoteMerge,
  executeNoteSplit,
  planNoteMerge,
  planNoteSplit,
  type ComposerEntrySnapshot,
  type NoteComposerAdapter
} from "./noteComposer";

function entry(overrides: Partial<ComposerEntrySnapshot> = {}): ComposerEntrySnapshot {
  return {
    body: "앞 선택 뒤",
    contentFormat: "markdown-v1",
    dirty: false,
    folderId: null,
    id: "source",
    revision: 4,
    title: "원본",
    ...overrides
  };
}

function adapter(overrides: Partial<NoteComposerAdapter> = {}): NoteComposerAdapter {
  const snapshots = new Map<string, ComposerEntrySnapshot>([
    ["source", entry()],
    ["target", entry({ body: "대상", id: "target", revision: 2, title: "대상" })]
  ]);
  return {
    createMarkdownCopy: vi.fn(async () => ({ entryId: "created", revision: 1 })),
    flushDirtyDraft: vi.fn(async (guard) => ({ ...guard, dirty: false, revision: guard.revision + 1 })),
    readEntry: vi.fn(async (id) => snapshots.get(id) ?? null),
    saveMarkdown: vi.fn(async ({ expectedRevision }) => ({ revision: expectedRevision + 1 })),
    trashEntry: vi.fn(async () => undefined),
    ...overrides
  };
}

describe("revision-aware Note composer", () => {
  it("extracts a selection into a same-folder note and replaces it with a wikilink", () => {
    const source = entry();
    const plan = planNoteSplit(source, {
      start: 2,
      end: 4,
      newTitle: "분리 노트",
      operationIdFactory: () => "operation_split_1"
    });
    expect(plan.create).toMatchObject({ body: "선택", folderId: null, title: "분리 노트" });
    expect(plan.sourceBodyAfterCreate).toBe("앞 [[분리 노트]] 뒤");
  });

  it("never writes a wikilink that resolves to a different sanitized title", () => {
    expect(() => planNoteSplit(entry(), {
      start: 2,
      end: 4,
      newTitle: "[[다른 대상]]",
      operationIdFactory: () => "operation_split_unsafe"
    })).toThrow("안전한 Wikilink");
  });

  it("keeps the created copy when the second source update fails", async () => {
    const plan = planNoteSplit(entry(), {
      start: 2,
      end: 4,
      newTitle: "분리 노트",
      operationIdFactory: () => "operation_split_2"
    });
    const result = await executeNoteSplit(plan, adapter({
      saveMarkdown: vi.fn(async () => { throw new Error("revision conflict"); })
    }));
    expect(result).toEqual({
      kind: "created-copy-source-unchanged",
      createdEntryId: "created",
      reason: "revision conflict"
    });
  });

  it("stops before mutation when a remote revision changed", async () => {
    const plan = planNoteSplit(entry(), {
      start: 2,
      end: 4,
      newTitle: "분리",
      operationIdFactory: () => "operation_split_3"
    });
    const createMarkdownCopy = vi.fn(async () => ({ entryId: "created", revision: 1 }));
    await expect(executeNoteSplit(plan, adapter({
      createMarkdownCopy,
      readEntry: vi.fn(async () => entry({ revision: 5 }))
    }))).rejects.toThrow("다른 탭");
    expect(createMarkdownCopy).not.toHaveBeenCalled();
  });

  it("merges first and never deletes a source that changed after the merge", async () => {
    const source = entry();
    const target = entry({ body: "대상 본문", id: "target", revision: 2, title: "대상" });
    const plan = planNoteMerge(source, target, {
      operationIdFactory: () => "operation_merge_1",
      trashSourceAfterMerge: true
    });
    let sourceReads = 0;
    const trashEntry = vi.fn(async () => undefined);
    const result = await executeNoteMerge(plan, adapter({
      readEntry: vi.fn(async (id) => {
        if (id === "target") return target;
        sourceReads += 1;
        return sourceReads === 1 ? source : { ...source, revision: 5 };
      }),
      trashEntry
    }));
    expect(plan.targetBodyAfterMerge).toContain("## 원본\n\n앞 선택 뒤");
    expect(result.kind).toBe("merged-source-kept");
    expect(trashEntry).not.toHaveBeenCalled();
  });

  it("preserves source properties as inert YAML instead of activating them in the target", () => {
    const source = entry({ body: "---\nstatus: source\n---\n본문" });
    const target = entry({ body: "---\nstatus: target\n---\n대상", id: "target", title: "대상" });
    const plan = planNoteMerge(source, target, { operationIdFactory: () => "operation_merge_2" });
    expect(plan.targetBodyAfterMerge).toContain("---\nstatus: target\n---\n대상");
    expect(plan.targetBodyAfterMerge).toContain("### 원본 Properties\n\n```yaml\nstatus: source\n```");
  });

  it("flushes an exact dirty draft before reading its new revision", async () => {
    const dirty = entry({ dirty: true });
    const plan = planNoteSplit(dirty, {
      start: 2,
      end: 4,
      newTitle: "분리",
      operationIdFactory: () => "operation_split_4",
      replaceSelectionWithLink: false
    });
    const flushDirtyDraft = vi.fn(async () => ({ ...dirty, dirty: false, revision: 5 }));
    await executeNoteSplit(plan, adapter({
      flushDirtyDraft,
      readEntry: vi.fn(async () => ({ ...dirty, dirty: false, revision: 5 }))
    }));
    expect(flushDirtyDraft).toHaveBeenCalledWith(dirty);
  });
});
