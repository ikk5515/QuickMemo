import { describe, expect, it } from "vitest";
import { MarkdownEditorSessionStore } from "./markdownEditorSession";

describe("MarkdownEditorSessionStore", () => {
  const snapshot = (doc: string) => ({ state: { doc }, scrollTop: 100, scrollLeft: 0 });

  it("isolates owners and rejects a stale body or writes after access revocation", () => {
    const store = new MarkdownEditorSessionStore("owner");
    const generation = store.generation;
    store.write("other", "note", generation, snapshot("private"));
    expect(store.read("owner", "note", "private")).toBeNull();
    store.write("owner", "note", generation, snapshot("private"));
    expect(store.read("other", "note", "private")).toBeNull();
    expect(store.read("owner", "note", "remote revision")).toBeNull();
    expect(store.read("owner", "note", "private")?.scrollTop).toBe(100);
    store.clear();
    store.write("owner", "note", generation, snapshot("late unmount"));
    expect(store.read("owner", "note", "late unmount")).toBeNull();
  });

  it("bounds retained history by document count and serialized size", () => {
    const store = new MarkdownEditorSessionStore("owner", 2, 100);
    for (const id of ["a", "b", "c"]) store.write("owner", id, store.generation, snapshot(id));
    expect(store.read("owner", "a", "a")).toBeNull();
    expect(store.read("owner", "b", "b")).not.toBeNull();
    store.write("owner", "large", store.generation, snapshot("x".repeat(200)));
    expect(store.read("owner", "large", "x".repeat(200))).toBeNull();
    store.delete("b");
    expect(store.read("owner", "b", "b")).toBeNull();
  });
});
