type BrowserWindow = Window & typeof globalThis;

const frameDeferredConstructors = new WeakSet<object>();

function frameDeferredResizeObserverConstructor(
  browserWindow: BrowserWindow,
  NativeResizeObserver: typeof ResizeObserver
): typeof ResizeObserver {
  const FrameDeferredResizeObserver = class FrameDeferredResizeObserver implements ResizeObserver {
    private readonly callback: ResizeObserverCallback;
    private readonly nativeObserver: ResizeObserver;
    private pendingEntries = new Map<Element, ResizeObserverEntry>();
    private pendingFrame = 0;

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
      this.nativeObserver = new NativeResizeObserver((entries) => {
        for (const entry of entries) {
          this.pendingEntries.set(entry.target, entry);
        }
        if (this.pendingFrame !== 0) {
          return;
        }
        this.pendingFrame = browserWindow.requestAnimationFrame(() => {
          this.pendingFrame = 0;
          if (this.pendingEntries.size === 0) {
            return;
          }
          const pending = [...this.pendingEntries.values()];
          this.pendingEntries.clear();
          this.callback(pending, this);
        });
      });
    }

    disconnect() {
      this.nativeObserver.disconnect();
      this.pendingEntries.clear();
      if (this.pendingFrame !== 0) {
        browserWindow.cancelAnimationFrame(this.pendingFrame);
        this.pendingFrame = 0;
      }
    }

    observe(target: Element, options?: ResizeObserverOptions) {
      this.nativeObserver.observe(target, options);
    }

    unobserve(target: Element) {
      this.nativeObserver.unobserve(target);
      this.pendingEntries.delete(target);
    }
  };
  frameDeferredConstructors.add(FrameDeferredResizeObserver);
  return FrameDeferredResizeObserver;
}

function restoreResizeObserver(
  browserWindow: BrowserWindow,
  ownDescriptor: PropertyDescriptor | undefined
) {
  if (ownDescriptor) {
    Object.defineProperty(browserWindow, "ResizeObserver", ownDescriptor);
  } else {
    delete (browserWindow as Partial<BrowserWindow>).ResizeObserver;
  }
}

/** Installs the deferred observer before React mounts third-party UI widgets. */
export function installFrameDeferredResizeObserver(browserWindow: BrowserWindow): () => void {
  const NativeResizeObserver = browserWindow.ResizeObserver;
  if (
    typeof NativeResizeObserver !== "function"
    || frameDeferredConstructors.has(NativeResizeObserver)
  ) {
    return () => undefined;
  }

  const ownDescriptor = Object.getOwnPropertyDescriptor(browserWindow, "ResizeObserver");
  const DeferredResizeObserver = frameDeferredResizeObserverConstructor(browserWindow, NativeResizeObserver);
  try {
    Object.defineProperty(browserWindow, "ResizeObserver", {
      configurable: true,
      enumerable: ownDescriptor?.enumerable ?? true,
      value: DeferredResizeObserver,
      writable: true
    });
  } catch {
    return () => undefined;
  }

  let restored = false;
  return () => {
    if (restored || browserWindow.ResizeObserver !== DeferredResizeObserver) {
      return;
    }
    restored = true;
    restoreResizeObserver(browserWindow, ownDescriptor);
  };
}

/**
 * Constructs a third-party widget with a frame-deferred ResizeObserver.
 *
 * CodeMirror installs its observer synchronously while its scroll DOM is still
 * being attached. WebKit can otherwise report an undelivered notification when
 * the observer writes editor geometry in that same delivery frame. JavaScript
 * cannot interleave another task during `construct`, and the native global is
 * restored in `finally`, so only observers created by this one widget use the
 * adapter.
 */
export function constructWithFrameDeferredResizeObserver<T>(
  browserWindow: BrowserWindow,
  construct: () => T
): T {
  const NativeResizeObserver = browserWindow.ResizeObserver;
  if (typeof NativeResizeObserver !== "function") {
    return construct();
  }
  if (frameDeferredConstructors.has(NativeResizeObserver)) {
    return construct();
  }

  const ownDescriptor = Object.getOwnPropertyDescriptor(browserWindow, "ResizeObserver");
  const DeferredResizeObserver = frameDeferredResizeObserverConstructor(browserWindow, NativeResizeObserver);
  try {
    Object.defineProperty(browserWindow, "ResizeObserver", {
      configurable: true,
      enumerable: ownDescriptor?.enumerable ?? true,
      value: DeferredResizeObserver,
      writable: true
    });
  } catch {
    return construct();
  }

  try {
    return construct();
  } finally {
    restoreResizeObserver(browserWindow, ownDescriptor);
  }
}
