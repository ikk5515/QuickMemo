import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "@testing-library/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";

const vaultPageSource = readFileSync(join(process.cwd(), "src/pages/VaultPage.tsx"), "utf8");
const mirrorsCommittedDrafts = /\bdraftsRef\.current\s*=\s*drafts\s*;/u.test(vaultPageSource);

interface Draft {
  body: string;
  dirty: boolean;
  baseRevision: number;
}

const savedFirstImage: Draft = {
  body: "![[image-1.png]]",
  dirty: false,
  baseRevision: 2
};
const secondImageBody = `${savedFirstImage.body}\n![[image-2.png]]`;

function NativeEditorCallback({ onChange }: { onChange: () => void }) {
  // An editor callback can synchronously publish a draft before an earlier
  // parent render's passive effects have run. The layout boundary fixes this
  // ordering for the test without depending on promise or browser timing.
  useLayoutEffect(onChange, [onChange]);
  return null;
}

function DraftRefHarness({
  mirrorCommittedDrafts,
  onSaveRead
}: {
  mirrorCommittedDrafts: boolean;
  onSaveRead: (draft: Draft) => void;
}) {
  const [drafts, setDrafts] = useState({ note: savedFirstImage });
  const draftsRef = useRef(drafts);
  const appendSecondImage = useCallback(() => {
    const next = {
      ...draftsRef.current,
      note: { ...draftsRef.current.note, body: secondImageBody, dirty: true }
    };
    // This ordering is checked against updateEntryDraft below.
    draftsRef.current = next;
    setDrafts(next);
  }, []);

  useEffect(() => {
    if (mirrorCommittedDrafts) draftsRef.current = drafts;
  }, [drafts, mirrorCommittedDrafts]);

  useEffect(() => {
    // Saving and clipboard confirmation read the ref, not a render closure.
    // Capture the first read, before the next render can repair an old mirror.
    onSaveRead(draftsRef.current.note);
  }, [drafts, onSaveRead]);

  return <NativeEditorCallback onChange={appendSecondImage} />;
}

describe("VaultPage synchronous draft ownership", () => {
  it("keeps the second image dirty for saving when an older render flushes passive effects", () => {
    const updateEntryDraft = vaultPageSource.match(
      /function updateEntryDraft\([\s\S]*?\n {2}function updateActiveDraft/u
    )?.[0] ?? "";
    expect(updateEntryDraft).toMatch(/draftsRef\.current = next;\s+setDrafts\(next\);/u);

    const onSaveRead = vi.fn();
    render(
      <DraftRefHarness
        mirrorCommittedDrafts={mirrorsCommittedDrafts}
        onSaveRead={onSaveRead}
      />
    );

    expect(onSaveRead).toHaveBeenCalled();
    expect(onSaveRead.mock.calls[0]?.[0]).toEqual({
      body: secondImageBody,
      dirty: true,
      baseRevision: savedFirstImage.baseRevision
    });
  });

  it("reproduces the old passive mirror losing the second image at the save boundary", () => {
    const onSaveRead = vi.fn();
    render(<DraftRefHarness mirrorCommittedDrafts onSaveRead={onSaveRead} />);

    // A control case proves the harness catches the transient loss even though
    // React subsequently commits the new state and makes the last read correct.
    expect(onSaveRead.mock.calls[0]?.[0]).toEqual(savedFirstImage);
    expect(onSaveRead).toHaveBeenLastCalledWith({
      body: secondImageBody,
      dirty: true,
      baseRevision: savedFirstImage.baseRevision
    });
  });
});
