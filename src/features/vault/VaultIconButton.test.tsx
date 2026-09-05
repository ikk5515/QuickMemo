import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VaultIconButton } from "./VaultIconButton";

afterEach(() => vi.useRealTimers());

describe("VaultIconButton", () => {
  it("keeps an accessible icon-only control and exposes dismissible help on keyboard focus", () => {
    const ref = createRef<HTMLButtonElement>();
    const onClick = vi.fn();
    const { container } = render(
      <VaultIconButton aria-label="새 노트" onClick={onClick} ref={ref} tooltip="새 메모 만들기">
        <svg aria-hidden="true" />
      </VaultIconButton>
    );
    const button = screen.getByRole("button", { name: "새 노트" });
    expect(button).toHaveTextContent("");
    expect(ref.current).toBe(button);
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.focus(button);
    expect(button).toHaveAccessibleDescription("새 메모 만들기");
    expect(container.contains(screen.getByRole("tooltip"))).toBe(false);
    fireEvent.keyDown(button, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(button).not.toHaveAttribute("aria-describedby");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("waits for hover intent and cancels stale timers", () => {
    vi.useFakeTimers();
    const view = render(<VaultIconButton aria-label="검색" tooltip="메모 검색" />);
    const button = screen.getByRole("button", { name: "검색" });
    fireEvent.pointerEnter(button);
    act(() => vi.advanceTimersByTime(299));
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("tooltip")).toHaveTextContent("메모 검색");
    fireEvent.pointerLeave(button);
    act(() => vi.advanceTimersByTime(120));
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.pointerEnter(button);
    view.unmount();
    act(() => vi.runAllTimers());
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("closes help when scrolling its anchor and preserves an existing description", () => {
    render(<>
      <p id="context">현재 폴더 안에 만듭니다.</p>
      <VaultIconButton aria-describedby="context" aria-label="새 폴더" tooltip="폴더 만들기" />
    </>);
    const button = screen.getByRole("button", { name: "새 폴더" });
    fireEvent.focus(button);
    expect(button).toHaveAccessibleDescription("현재 폴더 안에 만듭니다. 폴더 만들기");
    fireEvent.scroll(window);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(button).toHaveAccessibleDescription("현재 폴더 안에 만듭니다.");
  });
});
