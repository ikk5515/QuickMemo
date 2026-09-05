import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarResizeHandle } from "./SidebarResizeHandle";

afterEach(() => vi.unstubAllGlobals());
function Resize({ onChange = () => {} }: { onChange?: (width: number) => void }) {
  const [width, setWidth] = useState(280);
  return <SidebarResizeHandle label="목록 너비" width={width} minWidth={180} maxWidth={520} onChange={(next) => { setWidth(next); onChange(next); }} />;
}
describe("shared sidebar resizing", () => {
  it("exposes current bounds and supports keyboard increments and Home/End", () => {
    render(<Resize />); const separator = screen.getByRole("separator", { name: "목록 너비" });
    fireEvent.keyDown(separator, { key: "ArrowRight" }); expect(separator).toHaveAttribute("aria-valuenow", "296");
    fireEvent.keyDown(separator, { key: "ArrowLeft", shiftKey: true }); expect(separator).toHaveAttribute("aria-valuenow", "248");
    fireEvent.keyDown(separator, { key: "End" }); expect(separator).toHaveAttribute("aria-valuenow", "520");
    fireEvent.keyDown(separator, { key: "ArrowRight" }); expect(separator).toHaveAttribute("aria-valuenow", "520");
    fireEvent.keyDown(separator, { key: "Home" }); expect(separator).toHaveAttribute("aria-valuenow", "180");
  });
  it("coalesces pointer movement, clamps the final value and releases global drag styles", () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    const frames = new Map<number, FrameRequestCallback>(); let serial = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++serial, callback); return serial; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    const onChange = vi.fn(); const view = render(<Resize onChange={onChange} />);
    const separator = screen.getByRole("separator");
    fireEvent.pointerDown(separator, { button: 0, clientX: 280 });
    fireEvent.pointerMove(separator, { clientX: 300 }); fireEvent.pointerMove(separator, { clientX: 330 });
    expect(onChange).not.toHaveBeenCalled(); expect(frames.size).toBe(1);
    act(() => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback(0)); });
    expect(onChange).toHaveBeenLastCalledWith(330);
    fireEvent.pointerMove(separator, { clientX: 900 }); fireEvent.pointerUp(separator);
    expect(onChange).toHaveBeenLastCalledWith(520); expect(frames.size).toBe(0);
    expect(document.body.style.userSelect).toBe(""); expect(document.body.style.cursor).toBe("");
    fireEvent.pointerDown(separator, { button: 0, clientX: 520 });
    fireEvent.pointerMove(separator, { clientX: 500 }); view.unmount();
    expect(frames.size).toBe(0); expect(document.body.style.userSelect).toBe("");
  });
});
