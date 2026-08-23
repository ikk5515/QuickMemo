import { describe, expect, it, vi } from "vitest";
import {
  constructWithFrameDeferredResizeObserver,
  installFrameDeferredResizeObserver
} from "./frameDeferredResizeObserver";

describe("constructWithFrameDeferredResizeObserver", () => {
  it("installs one app-level adapter and restores the native constructor on request", () => {
    class NativeResizeObserver implements ResizeObserver {
      disconnect() {}
      observe() {}
      unobserve() {}
    }
    const originalDescriptor = Object.getOwnPropertyDescriptor(window, "ResizeObserver");
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: NativeResizeObserver,
      writable: true
    });
    try {
      const restore = installFrameDeferredResizeObserver(window);
      const installed = window.ResizeObserver;
      expect(installed).not.toBe(NativeResizeObserver);
      const nestedRestore = installFrameDeferredResizeObserver(window);
      expect(window.ResizeObserver).toBe(installed);
      nestedRestore();
      expect(window.ResizeObserver).toBe(installed);
      restore();
      expect(window.ResizeObserver).toBe(NativeResizeObserver);
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(window, "ResizeObserver", originalDescriptor);
      } else {
        delete (window as Partial<typeof window>).ResizeObserver;
      }
    }
  });

  it("coalesces widget resize deliveries into one frame and restores the native constructor", () => {
    const callbacks: {
      frame: FrameRequestCallback | null;
      native: ResizeObserverCallback | null;
    } = { frame: null, native: null };
    const observed = new Set<Element>();
    class NativeResizeObserver implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        callbacks.native = callback;
      }
      disconnect() {
        observed.clear();
      }
      observe(target: Element) {
        observed.add(target);
      }
      unobserve(target: Element) {
        observed.delete(target);
      }
    }
    const originalDescriptor = Object.getOwnPropertyDescriptor(window, "ResizeObserver");
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callbacks.frame = callback;
      return 7;
    });
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {
      callbacks.frame = null;
    });
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: NativeResizeObserver,
      writable: true
    });

    try {
      const delivered = vi.fn();
      const widgetObserverRef: { current: ResizeObserver | null } = { current: null };
      constructWithFrameDeferredResizeObserver(window, () => {
        widgetObserverRef.current = new ResizeObserver(delivered);
      });
      expect(window.ResizeObserver).toBe(NativeResizeObserver);
      const widgetObserver = widgetObserverRef.current as unknown as ResizeObserver;

      const first = document.createElement("div");
      const second = document.createElement("div");
      widgetObserver.observe(first);
      widgetObserver.observe(second);
      const firstEntry = { target: first } as unknown as ResizeObserverEntry;
      const latestFirstEntry = { target: first } as unknown as ResizeObserverEntry;
      const secondEntry = { target: second } as unknown as ResizeObserverEntry;
      callbacks.native?.([firstEntry, secondEntry], widgetObserver);
      callbacks.native?.([latestFirstEntry], widgetObserver);
      expect(delivered).not.toHaveBeenCalled();
      expect(requestFrame).toHaveBeenCalledTimes(1);

      const callback = callbacks.frame;
      callbacks.frame = null;
      callback?.(0);
      expect(delivered).toHaveBeenCalledTimes(1);
      expect(delivered.mock.calls[0]?.[0]).toEqual([latestFirstEntry, secondEntry]);

      callbacks.native?.([firstEntry], widgetObserver);
      widgetObserver.disconnect();
      expect(cancelFrame).toHaveBeenCalledWith(7);
      expect(observed).toHaveLength(0);
    } finally {
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
      if (originalDescriptor) {
        Object.defineProperty(window, "ResizeObserver", originalDescriptor);
      } else {
        delete (window as Partial<typeof window>).ResizeObserver;
      }
    }
  });
});
