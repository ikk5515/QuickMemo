import { describe, expect, it } from "vitest";
import {
  canonicalizeDraftTitle,
  captureRevisionedDraft,
  findConfirmedDraftSubmission,
  persistedRevisionRelation,
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

  it("commits the same NFC title that the encryption layer persisted", () => {
    const decomposed = { ...submitted, title: "Cafe\u0301  " };
    expect(reconcileDraftAfterSave(decomposed, decomposed, 5)).toEqual({
      ...decomposed,
      baseRevision: 5,
      dirty: false,
      title: "Caf\u00e9"
    });
  });
});

describe("response-lost save confirmation", () => {
  it("accepts only the exact next revision and normalized submitted payload", () => {
    const older = { ...submitted, body: "먼저 보낸 본문", title: "노트  " };
    const latest = { ...submitted, body: "나중에 보낸 본문" };
    expect(findConfirmedDraftSubmission({
      body: "먼저 보낸 본문",
      folderId: null,
      revision: 5,
      title: "노트"
    }, [older, latest])).toEqual({ ...older, title: "노트" });
    expect(findConfirmedDraftSubmission({
      body: "먼저 보낸 본문",
      folderId: null,
      revision: 6,
      title: "노트"
    }, [older])).toBeNull();
    expect(findConfirmedDraftSubmission({
      body: "다른 기기의 본문",
      folderId: null,
      revision: 5,
      title: "노트"
    }, [older])).toBeNull();
  });

  it("returns the canonical title that matches the encrypted server payload", () => {
    const decomposed = { ...submitted, title: "Cafe\u0301 " };
    expect(findConfirmedDraftSubmission({
      body: decomposed.body,
      folderId: null,
      revision: 5,
      title: "Caf\u00e9"
    }, [decomposed])).toEqual({ ...decomposed, title: "Caf\u00e9" });
  });
});

describe("monotonic persisted revision commits", () => {
  it("never applies a late response over an already newer subscription", () => {
    expect(persistedRevisionRelation(4, 5)).toBe("apply");
    expect(persistedRevisionRelation(5, 5)).toBe("current");
    expect(persistedRevisionRelation(6, 5)).toBe("superseded");
  });

  it("canonicalizes trim and Unicode composition without changing the payload", () => {
    expect(canonicalizeDraftTitle({ body: "본문", title: " Cafe\u0301  " })).toEqual({
      body: "본문",
      title: "Caf\u00e9"
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
