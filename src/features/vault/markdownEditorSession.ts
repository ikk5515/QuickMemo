import type { EditorView } from "@codemirror/view";

export interface MarkdownEditorSnapshot {
  state: { doc: string; selection?: unknown; history?: unknown };
  scrollTop: number;
  scrollLeft: number;
  /** CM's document anchor and offset, with no DOM/view or document text. */
  scrollSnapshot?: ReturnType<EditorView["scrollSnapshot"]>;
}

/** Plaintext editor history stays in this explicitly scoped, bounded memory cache only. */
export class MarkdownEditorSessionStore {
  private snapshots = new Map<string, { snapshot: MarkdownEditorSnapshot; size: number }>();
  private totalSize = 0;
  private epoch = 0;

  constructor(readonly scopeKey: string, private readonly maximumDocuments = 40, private readonly maximumCharacters = 4_000_000) {}

  get generation() { return this.epoch; }

  read(scopeKey: string, documentKey: string, source: string): MarkdownEditorSnapshot | null {
    if (!scopeKey || scopeKey !== this.scopeKey) return null;
    const entry = this.snapshots.get(documentKey);
    if (!entry || entry.snapshot.state.doc !== source) return null;
    this.snapshots.delete(documentKey);
    this.snapshots.set(documentKey, entry);
    return entry.snapshot;
  }

  write(scopeKey: string, documentKey: string, generation: number, snapshot: MarkdownEditorSnapshot) {
    if (!scopeKey || scopeKey !== this.scopeKey || generation !== this.epoch) return;
    this.delete(documentKey);
    const size = JSON.stringify(snapshot.state).length;
    if (size > this.maximumCharacters || this.maximumDocuments < 1) return;
    while (this.snapshots.size >= this.maximumDocuments || this.totalSize + size > this.maximumCharacters) {
      const oldest = this.snapshots.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
    this.snapshots.set(documentKey, { snapshot, size });
    this.totalSize += size;
  }

  delete(documentKey: string) {
    this.totalSize -= this.snapshots.get(documentKey)?.size ?? 0;
    this.snapshots.delete(documentKey);
  }

  clear() {
    this.epoch += 1;
    this.snapshots.clear();
    this.totalSize = 0;
  }
}
