import { Component, createRef, type HTMLAttributes } from "react";

const MOTION_DURATION = 170;
const MOTION_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

interface MotionMember {
  clear(): void;
  prepareClose(tabId: string): void;
}

/** Plaintext boundaries can synchronously remove every transient title. */
export class MemoTabMotionBoundary {
  private readonly members = new Set<MotionMember>();

  register(member: MotionMember) {
    this.members.add(member);
    return () => { member.clear(); this.members.delete(member); };
  }

  clear() {
    for (const member of this.members) member.clear();
  }

  prepareClose(tabId: string) {
    for (const member of this.members) member.prepareClose(tabId);
  }
}

interface MemoTabStripProps extends Pick<HTMLAttributes<HTMLDivElement>, "aria-label" | "children" | "className" | "onKeyDown" | "role"> {
  activeTabId: string | null;
  boundary: MemoTabMotionBoundary;
  /** Opaque owner/key identity; never persisted or exposed in the DOM. */
  scope: object;
  accessGeneration: number;
  orderKey: string;
}

type Geometry = Map<string, { x: number; width: number }>;
type Snapshot = { reset: true } | { reset: false; geometry: Geometry | null; activeChanged: boolean } | null;

/**
 * Visual ownership only: React still removes logical tabs/editors immediately.
 * The pre-commit snapshot is limited to structural changes, never keystrokes.
 */
export class MemoTabStrip extends Component<MemoTabStripProps, Record<string, never>, Snapshot> {
  private readonly strip = createRef<HTMLDivElement>();
  private readonly exitLayer = createRef<HTMLDivElement>();
  private readonly animations = new Set<Animation>();
  private readonly exits = new Map<string, { element: HTMLElement; animation: Animation; timer: number }>();
  private panelAnimation: Animation | null = null;
  private unregister: (() => void) | null = null;
  private media: MediaQueryList | null = null;
  private closingFocus: HTMLElement | null = null;

  private tabs() {
    return [...(this.strip.current?.querySelectorAll<HTMLButtonElement>(':scope > [role="presentation"] > [role="tab"]') ?? [])];
  }

  private measure(): Geometry {
    return new Map(this.tabs().map((tab) => {
      const rect = tab.parentElement!.getBoundingClientRect();
      return [tab.id, { x: rect.x, width: rect.width }];
    }));
  }

  private reduced() {
    return this.media?.matches ?? true;
  }

  private animate(element: HTMLElement, frames: Keyframe[]) {
    if (typeof element.animate !== "function" || this.reduced()) return null;
    const animation = element.animate(frames, { duration: MOTION_DURATION, easing: MOTION_EASING });
    this.animations.add(animation);
    animation.onfinish = () => { this.animations.delete(animation); };
    animation.oncancel = () => { this.animations.delete(animation); };
    return animation;
  }

  private removeExit = (id: string) => {
    const exit = this.exits.get(id);
    if (!exit) return;
    this.exits.delete(id);
    window.clearTimeout(exit.timer);
    this.animations.delete(exit.animation);
    exit.animation.cancel();
    exit.element.remove();
  };

  clear = () => {
    for (const id of this.exits.keys()) this.removeExit(id);
    for (const animation of this.animations) animation.cancel();
    this.animations.clear();
    this.panelAnimation = null;
    this.closingFocus = null;
    this.exitLayer.current?.replaceChildren();
  };

  prepareClose = (tabId: string) => {
    const tab = this.tabs().find((candidate) => candidate.id === tabId);
    const strip = this.strip.current;
    const layer = this.exitLayer.current;
    if (!tab || !strip || !layer) return;
    const source = tab.parentElement!;
    const focused = source.ownerDocument.activeElement;
    if (focused instanceof HTMLElement && source.contains(focused)) this.closingFocus = focused;
    if (this.reduced()) return;
    const rect = source.getBoundingClientRect();
    const stripRect = strip.getBoundingClientRect();
    const labelFont = getComputedStyle(tab).font;
    this.removeExit(tabId);
    // Only text is retained. No clone of an editor, interactive node, id, or
    // event handler survives close, and DOM text assignment cannot create HTML.
    const ghost = document.createElement("span");
    ghost.className = `vault-tab-exit${tab.getAttribute("aria-selected") === "true" ? " active" : ""}`;
    ghost.dataset.memoExitId = tabId;
    ghost.inert = true;
    ghost.setAttribute("aria-hidden", "true");
    ghost.textContent = tab.textContent;
    ghost.style.left = `${rect.x - stripRect.x + strip.scrollLeft}px`;
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    ghost.style.font = labelFont;
    ghost.style.lineHeight = `${rect.height}px`;
    layer.append(ghost);
    const animation = this.animate(ghost, [
      { opacity: 1, transform: "translateY(0)" },
      { opacity: 0, transform: "translateY(-5px)" }
    ]);
    if (!animation) { ghost.remove(); return; }
    const timer = window.setTimeout(() => this.removeExit(tabId), MOTION_DURATION + 40);
    this.exits.set(tabId, { element: ghost, animation, timer });
    animation.onfinish = () => this.removeExit(tabId);
  };

  private stopPanelMotion = () => {
    this.panelAnimation?.cancel();
    this.panelAnimation = null;
  };

  private mediaChanged = () => { if (this.reduced()) this.clear(); };

  componentDidMount() {
    this.media = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    this.media?.addEventListener("change", this.mediaChanged);
    this.unregister = this.props.boundary.register(this);
    const group = this.strip.current?.closest(".vault-tab-group");
    group?.addEventListener("keydown", this.stopPanelMotion, true);
    group?.addEventListener("pointerdown", this.stopPanelMotion, true);
    group?.addEventListener("compositionstart", this.stopPanelMotion, true);
  }

  getSnapshotBeforeUpdate(previous: MemoTabStripProps): Snapshot {
    if (previous.scope !== this.props.scope || previous.accessGeneration !== this.props.accessGeneration || previous.boundary !== this.props.boundary) return { reset: true };
    const orderChanged = previous.orderKey !== this.props.orderKey;
    const activeChanged = previous.activeTabId !== this.props.activeTabId;
    if ((!orderChanged && !activeChanged) || this.reduced()) return null;
    return { reset: false, geometry: orderChanged ? this.measure() : null, activeChanged };
  }

  componentDidUpdate(previous: MemoTabStripProps, _state: Record<string, never>, snapshot: Snapshot) {
    if (previous.boundary !== this.props.boundary) {
      this.unregister?.();
      this.unregister = this.props.boundary.register(this);
    }
    if (snapshot?.reset) { this.clear(); return; }
    if (this.closingFocus && !this.closingFocus.isConnected) {
      const currentFocus = this.strip.current?.ownerDocument.activeElement;
      if (currentFocus === this.strip.current?.ownerDocument.body) this.tabs().find((tab) => tab.id === this.props.activeTabId)?.focus({ preventScroll: true });
    }
    this.closingFocus = null;
    if (!snapshot) return;
    const tabs = this.tabs();
    // A rapid reopen immediately supersedes its noninteractive exit title.
    for (const tab of tabs) this.removeExit(tab.id);
    if (snapshot.geometry) {
      // Cancel only prior position/entry animations before the batched final
      // layout read. Exit fades retain their independent short lifetime.
      const exitAnimations = new Set([...this.exits.values()].map((exit) => exit.animation));
      for (const animation of this.animations) {
        if (!exitAnimations.has(animation) && animation !== this.panelAnimation) animation.cancel();
      }
      const finalGeometry = this.measure();
      for (const tab of tabs) {
        const element = tab.parentElement!;
        const before = snapshot.geometry.get(tab.id);
        const after = finalGeometry.get(tab.id)!;
        if (!before) {
          this.animate(element, [{ opacity: 0, transform: "translateX(10px)" }, { opacity: 1, transform: "translateX(0)" }]);
        } else if (Math.abs(before.x - after.x) > 0.5) {
          this.animate(element, [{ transform: `translateX(${before.x - after.x}px)` }, { transform: "translateX(0)" }]);
        }
      }
    }
    if (snapshot.activeChanged) {
      this.stopPanelMotion();
      const panel = this.strip.current?.closest(".vault-tab-group")?.querySelector<HTMLElement>(":scope > .vault-editor-pane");
      if (panel) this.panelAnimation = this.animate(panel, [{ opacity: 0.6, transform: "translateX(5px)" }, { opacity: 1, transform: "translateX(0)" }]);
    }
  }

  componentWillUnmount() {
    this.unregister?.();
    this.unregister = null;
    this.clear();
    this.media?.removeEventListener("change", this.mediaChanged);
    const group = this.strip.current?.closest(".vault-tab-group");
    group?.removeEventListener("keydown", this.stopPanelMotion, true);
    group?.removeEventListener("pointerdown", this.stopPanelMotion, true);
    group?.removeEventListener("compositionstart", this.stopPanelMotion, true);
    this.media = null;
  }

  render() {
    const { children, className, onKeyDown, role } = this.props;
    return <div aria-label={this.props["aria-label"]} className={className} onKeyDown={onKeyDown} role={role} ref={this.strip}>
      {children}
      <div aria-hidden="true" className="vault-tab-exit-layer" inert ref={this.exitLayer} />
    </div>;
  }
}
