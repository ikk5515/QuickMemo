import { describe, expect, it } from "vitest";
import { resolveAlreadyPersistedWorkspaceSave } from "./workspaceSaveQueue";

describe("Vault workspace save queue", () => {
  it("settles a duplicate queued state that an earlier task already persisted", () => {
    const scheduledState = { activeTabId: "entry:base" };
    expect(resolveAlreadyPersistedWorkspaceSave({
      debouncePending: false,
      pendingState: scheduledState,
      scheduledState
    })).toEqual({ pendingState: null, savePending: false });
  });

  it("does not clear a newer state that replaced the already-persisted task", () => {
    const scheduledState = { activeTabId: "entry:base" };
    const newerState = { activeTabId: "entry:note" };
    expect(resolveAlreadyPersistedWorkspaceSave({
      debouncePending: false,
      pendingState: newerState,
      scheduledState
    })).toEqual({ pendingState: newerState, savePending: true });
  });

  it("keeps the indicator pending while a newer debounce is scheduled", () => {
    const scheduledState = { activeTabId: "entry:base" };
    expect(resolveAlreadyPersistedWorkspaceSave({
      debouncePending: true,
      pendingState: scheduledState,
      scheduledState
    })).toEqual({ pendingState: null, savePending: true });
  });
});
