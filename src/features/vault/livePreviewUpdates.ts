/** Invalidates mounted preview roots without replacing CodeMirror state or DOM. */
export class LivePreviewUpdates {
  private version = 0;
  private readonly listeners = new Set<() => void>();

  readonly getSnapshot = () => this.version;

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  refresh(): void {
    this.version += 1;
    this.listeners.forEach((listener) => listener());
  }
}
