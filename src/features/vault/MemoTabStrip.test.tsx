import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoTabMotionBoundary, MemoTabStrip } from "./MemoTabStrip";

let reduced = false;
let notifyMedia: (() => void) | undefined;
const animations: { target: HTMLElement; frames: Keyframe[]; animation: Animation }[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  reduced = false;
  animations.length = 0;
  vi.stubGlobal("matchMedia", () => ({
    get matches() { return reduced; },
    addEventListener: (_event: string, fn: () => void) => { notifyMedia = fn; },
    removeEventListener: () => { notifyMedia = undefined; }
  }));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const position = this.getAttribute("role") === "presentation" ? [...(this.parentElement?.children ?? [])].indexOf(this) : 0;
    return { x: position * 190, y: 0, width: 190, height: 40, top: 0, left: position * 190, right: position * 190 + 190, bottom: 40, toJSON: () => ({}) };
  });
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, writable: true, value: vi.fn(function (this: HTMLElement, frames: Keyframe[]) {
    const animation = { onfinish: null, oncancel: null, cancel: vi.fn(() => animation.oncancel?.call(animation, new Event("cancel") as AnimationPlaybackEvent)) } as unknown as Animation;
    animations.push({ target: this, frames, animation });
    return animation;
  }) });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
});

const scope = {};
function Workspace({ boundary, ids = ["A", "B", "C"], active = "C", securityScope = scope, generation = 1, title = "B" }: {
  boundary: MemoTabMotionBoundary; ids?: string[]; active?: string; securityScope?: object; generation?: number; title?: string;
}) {
  return <div className="vault-tab-group">
    <MemoTabStrip accessGeneration={generation} activeTabId={active} boundary={boundary} className="vault-tab-strip" orderKey={JSON.stringify(ids)} scope={securityScope} role="tablist">
      {ids.map((id) => <div key={id} role="presentation"><button aria-selected={active === id} id={id} role="tab">{id === "B" ? title : id}</button><button aria-label={`close ${id}`} /></div>)}
    </MemoTabStrip>
    <section className="vault-editor-pane"><input aria-label="draft" defaultValue="preserved" /></section>
  </div>;
}

describe("Memo visual motion lifetime", () => {
  it("removes the logical middle tab immediately, retaining only inert escaped title text while neighbors move", () => {
    const boundary = new MemoTabMotionBoundary();
    const view = render(<Workspace boundary={boundary} title="<img src=x onerror=alert(1)>" />);
    act(() => boundary.prepareClose("B"));
    view.rerender(<Workspace boundary={boundary} ids={["A", "C"]} />);
    expect(screen.getAllByRole("tab").map((tab) => tab.id)).toEqual(["A", "C"]);
    const ghost = view.container.querySelector<HTMLElement>(".vault-tab-exit")!;
    expect(ghost.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(ghost.inert).toBe(true);
    expect(ghost).toHaveAttribute("aria-hidden", "true");
    expect(ghost.querySelector("button,input,img,[id],[role=tab]")).toBeNull();
    expect(ghost.id).toBe("");
    expect(animations.some(({ target, frames }) => target === screen.getByRole("tab", { name: "C" }).parentElement && frames[0].transform === "translateX(190px)")).toBe(true);
    act(() => vi.advanceTimersByTime(210));
    expect(view.container.querySelector(".vault-tab-exit")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["scope", "generation", "synchronous-boundary", "unmount"])("discards transient plaintext and animations on %s invalidation", (reason) => {
    const boundary = new MemoTabMotionBoundary();
    const view = render(<Workspace boundary={boundary} />);
    act(() => boundary.prepareClose("B"));
    view.rerender(<Workspace boundary={boundary} ids={["A", "C"]} />);
    expect(view.container.querySelector(".vault-tab-exit")).not.toBeNull();
    if (reason === "scope") view.rerender(<Workspace boundary={boundary} ids={["A", "C"]} securityScope={{}} />);
    if (reason === "generation") view.rerender(<Workspace boundary={boundary} ids={["A", "C"]} generation={2} />);
    if (reason === "synchronous-boundary") boundary.clear();
    if (reason === "unmount") view.unmount();
    expect(view.container.querySelector(".vault-tab-exit")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(animations.every(({ animation }) => vi.mocked(animation.cancel).mock.calls.length > 0)).toBe(true);
  });

  it("does not retain a title for remote removal and cancels an exit when the same tab is reopened", () => {
    const boundary = new MemoTabMotionBoundary();
    const view = render(<Workspace boundary={boundary} />);
    view.rerender(<Workspace boundary={boundary} ids={["A", "C"]} />);
    expect(view.container.querySelector(".vault-tab-exit")).toBeNull();
    view.rerender(<Workspace boundary={boundary} />);
    act(() => boundary.prepareClose("B"));
    view.rerender(<Workspace boundary={boundary} ids={["A", "C"]} />);
    view.rerender(<Workspace boundary={boundary} />);
    expect(view.container.querySelector(".vault-tab-exit")).toBeNull();
    expect(view.container.querySelectorAll('[id="B"]')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not measure or animate metadata/draft updates and never remounts the editor for active changes", () => {
    const boundary = new MemoTabMotionBoundary();
    const view = render(<Workspace boundary={boundary} />);
    const input = screen.getByRole("textbox", { name: "draft" });
    fireEvent.change(input, { target: { value: "dirty 한국어 日本語" } });
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockClear();
    view.rerender(<Workspace boundary={boundary} title="changed title" />);
    expect(HTMLElement.prototype.getBoundingClientRect).not.toHaveBeenCalled();
    expect(animations).toHaveLength(0);
    view.rerender(<Workspace boundary={boundary} active="A" title="changed title" />);
    expect(screen.getByRole("textbox", { name: "draft" })).toBe(input);
    expect(input).toHaveValue("dirty 한국어 日本語");
    expect(animations).toHaveLength(1);
    fireEvent.compositionStart(input);
    expect(animations[0].animation.cancel).toHaveBeenCalledOnce();
  });

  it("uses immediate states for reduced motion, including preference changes during an exit", () => {
    reduced = true;
    const boundary = new MemoTabMotionBoundary();
    const view = render(<Workspace boundary={boundary} />);
    act(() => boundary.prepareClose("B"));
    view.rerender(<Workspace boundary={boundary} ids={["A", "C"]} active="A" />);
    expect(animations).toHaveLength(0);
    expect(view.container.querySelector(".vault-tab-exit")).toBeNull();
    reduced = false;
    view.rerender(<Workspace boundary={boundary} />);
    act(() => boundary.prepareClose("B"));
    view.rerender(<Workspace boundary={boundary} ids={["A", "C"]} />);
    expect(view.container.querySelector(".vault-tab-exit")).not.toBeNull();
    reduced = true;
    act(() => notifyMedia?.());
    expect(view.container.querySelector(".vault-tab-exit")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("restores closing-button focus identically with reduced=%s and does not steal new focus", (preference) => {
    reduced = preference;
    const boundary = new MemoTabMotionBoundary();
    const view = render(<Workspace boundary={boundary} />);
    screen.getByRole("button", { name: "close B" }).focus();
    act(() => boundary.prepareClose("B"));
    view.rerender(<Workspace boundary={boundary} ids={["A", "C"]} />);
    expect(screen.getByRole("tab", { name: "C" })).toHaveFocus();
    view.rerender(<Workspace boundary={boundary} />);
    screen.getByRole("button", { name: "close B" }).focus();
    act(() => boundary.prepareClose("B"));
    screen.getByRole("textbox", { name: "draft" }).focus();
    view.rerender(<Workspace boundary={boundary} ids={["A", "C"]} />);
    expect(screen.getByRole("textbox", { name: "draft" })).toHaveFocus();
  });

  it.each([
    { name: "left", before: ["A", "B", "C"], closing: "A", after: ["B", "C"], active: "C" },
    { name: "active", before: ["A", "B", "C"], closing: "C", after: ["A", "B"], active: "B" },
    { name: "final", before: ["A"], closing: "A", after: [], active: "" }
  ])("cleans up the $name tab without retaining an interactive node", ({ before, closing, after, active }) => {
    const boundary = new MemoTabMotionBoundary();
    const view = render(<Workspace boundary={boundary} ids={before} active={before.at(-1)} />);
    act(() => boundary.prepareClose(closing));
    view.rerender(<Workspace boundary={boundary} ids={after} active={active} />);
    expect(screen.queryAllByRole("tab").map((tab) => tab.id)).toEqual(after);
    const ghost = view.container.querySelector<HTMLElement>(".vault-tab-exit");
    expect(ghost?.inert).toBe(true);
    expect(ghost?.querySelectorAll("button,input,[id]")).toHaveLength(0);
    act(() => vi.advanceTimersByTime(210));
    expect(view.container.querySelector(".vault-tab-exit")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("animates an order change from the rendered positions and retains the same tab DOM", () => {
    const boundary = new MemoTabMotionBoundary();
    const view = render(<Workspace boundary={boundary} />);
    const a = screen.getByRole("tab", { name: "A" });
    view.rerender(<Workspace boundary={boundary} ids={["C", "A", "B"]} />);
    expect(screen.getByRole("tab", { name: "A" })).toBe(a);
    expect(animations.some(({ target, frames }) => target === a.parentElement && frames[0].transform === "translateX(-190px)")).toBe(true);
  });
});
