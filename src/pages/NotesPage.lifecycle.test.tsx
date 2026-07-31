import { cleanup as testingCleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RichMemoEditor,
  scheduleNotesPageClockDeadline,
  usePublicShareSecretCleanup
} from "./NotesPage";

function SecretCleanupHarness({
  clearSecrets,
  profileUid,
  renderVersion,
  unlocked
}: {
  clearSecrets: (uid?: string) => void;
  profileUid: string | null;
  renderVersion: number;
  unlocked: boolean;
}) {
  usePublicShareSecretCleanup(unlocked ? profileUid : null, clearSecrets);
  return <span>{renderVersion}</span>;
}

function InlineEditorChangeHarness({ onChange }: { onChange: (value: string) => void }) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const [value, setValue] = useState(
    "<table><tbody><tr><td><p>왼쪽</p></td><td><p>오른쪽</p></td></tr></tbody></table>"
  );

  return (
    <RichMemoEditor
      editorRef={editorRef}
      fontSize={17}
      onChange={(nextValue) => {
        onChange(nextValue);
        setValue(nextValue);
      }}
      onFilesPaste={() => undefined}
      value={value}
    />
  );
}

function testDomRect(width: number, height: number): DOMRect {
  return {
    bottom: height,
    height,
    left: 0,
    right: width,
    top: 0,
    width,
    x: 0,
    y: 0,
    toJSON: () => ({})
  } as DOMRect;
}

afterEach(() => {
  testingCleanup();
  vi.useRealTimers();
  document.body.style.userSelect = "";
});

describe("NotesPage lifecycle guards", () => {
  it("keeps in-memory share secrets for the same unlocked UID and clears them on lock, UID change, and unmount", () => {
    const clearSecrets = vi.fn();
    const view = render(
      <SecretCleanupHarness
        clearSecrets={clearSecrets}
        profileUid="owner-a"
        renderVersion={1}
        unlocked
      />
    );

    view.rerender(
      <SecretCleanupHarness
        clearSecrets={clearSecrets}
        profileUid="owner-a"
        renderVersion={2}
        unlocked
      />
    );
    expect(clearSecrets).not.toHaveBeenCalled();

    view.rerender(
      <SecretCleanupHarness
        clearSecrets={clearSecrets}
        profileUid="owner-a"
        renderVersion={3}
        unlocked={false}
      />
    );
    expect(clearSecrets).toHaveBeenCalledTimes(1);
    expect(clearSecrets).toHaveBeenLastCalledWith("owner-a");

    view.rerender(
      <SecretCleanupHarness
        clearSecrets={clearSecrets}
        profileUid="owner-b"
        renderVersion={4}
        unlocked
      />
    );
    view.rerender(
      <SecretCleanupHarness
        clearSecrets={clearSecrets}
        profileUid="owner-c"
        renderVersion={5}
        unlocked
      />
    );
    expect(clearSecrets).toHaveBeenCalledTimes(2);
    expect(clearSecrets).toHaveBeenLastCalledWith("owner-b");

    view.unmount();
    expect(clearSecrets).toHaveBeenCalledTimes(3);
    expect(clearSecrets).toHaveBeenLastCalledWith("owner-c");
  });

  it("keeps an active table resize session across parent onChange rerenders", async () => {
    const onChange = vi.fn();
    const view = render(<InlineEditorChangeHarness onChange={onChange} />);
    const table = await waitFor(() => {
      const currentTable = view.container.querySelector(".rich-body-input table");
      expect(currentTable).toBeInstanceOf(HTMLTableElement);
      return currentTable as HTMLTableElement;
    });

    vi.spyOn(table, "getBoundingClientRect").mockReturnValue(testDomRect(300, 120));
    onChange.mockClear();

    fireEvent.mouseDown(table, { button: 0, clientX: 300, clientY: 60 });
    expect(document.body.style.userSelect).toBe("none");

    fireEvent.mouseMove(window, { clientX: 320, clientY: 60 });
    await waitFor(() => expect(onChange.mock.calls.length).toBeGreaterThan(0));
    const firstMoveCallCount = onChange.mock.calls.length;

    fireEvent.mouseMove(window, { clientX: 340, clientY: 60 });
    await waitFor(() => expect(onChange.mock.calls.length).toBeGreaterThan(firstMoveCallCount));

    fireEvent.mouseUp(window);
    expect(document.body.style.userSelect).toBe("");
  });

  it("ticks a share-expiration clock once at the deadline instead of polling every five seconds", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
    const onDeadline = vi.fn();
    const cancel = scheduleNotesPageClockDeadline(Date.now() + 60_000, onDeadline);

    vi.advanceTimersByTime(5_000);
    expect(onDeadline).not.toHaveBeenCalled();

    vi.advanceTimersByTime(54_999);
    expect(onDeadline).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onDeadline).toHaveBeenCalledTimes(1);
    cancel();
  });
});
