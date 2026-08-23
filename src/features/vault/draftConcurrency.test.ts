import { describe, expect, it } from "vitest";
import {
  captureRevisionedDraft,
  reconcileDraftAfterConflictSave,
  reconcileDraftAfterSave,
  sameRevisionedDraft
} from "./draftConcurrency";

const submitted = {
  baseRevision: 4,
  body: "저장 요청 본문",
  dirty: true,
  folderId: null,
  title: "노트"
};

describe("reconcileDraftAfterSave", () => {
  it("cleans an unchanged submitted draft and advances its revision", () => {
    expect(reconcileDraftAfterSave(submitted, submitted, 5)).toEqual({
      ...submitted,
      baseRevision: 5,
      dirty: false
    });
  });

  it("preserves edits made while saving and leaves them dirty", () => {
    const latest = { ...submitted, body: "저장 중 계속 쓴 본문" };
    expect(reconcileDraftAfterSave(latest, submitted, 5)).toEqual({
      ...latest,
      baseRevision: 5,
      dirty: true
    });
  });
});

describe("revision conflict draft reconciliation", () => {
  it("captures an immutable payload-only snapshot", () => {
    const captured = captureRevisionedDraft({ ...submitted, ignored: "not copied" });
    expect(captured).toEqual(submitted);
    expect(sameRevisionedDraft(captured, submitted)).toBe(true);
    expect(sameRevisionedDraft({ ...captured, baseRevision: 5 }, submitted)).toBe(false);
  });

  it("commits an explicit merge when the captured local draft stayed exact", () => {
    expect(reconcileDraftAfterConflictSave(
      submitted,
      submitted,
      { body: "병합 본문", folderId: null, title: "서버 제목" },
      8
    )).toEqual({
      ...submitted,
      baseRevision: 8,
      body: "병합 본문",
      dirty: false,
      title: "서버 제목"
    });
  });

  it("preserves edits made while the selected merge was saving", () => {
    const latest = { ...submitted, body: "저장 중 이어 쓴 본문" };
    expect(reconcileDraftAfterConflictSave(
      latest,
      submitted,
      { body: "병합 본문", folderId: null, title: "노트" },
      8
    )).toEqual({
      ...latest,
      baseRevision: 8,
      dirty: true
    });
  });
});
