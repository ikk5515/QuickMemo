import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CANVAS_ENTRY_AUTOSAVE_IDLE_MS,
  EntryIdleDebounce,
  MARKDOWN_ENTRY_AUTOSAVE_IDLE_MS,
  entryAutosaveRetryDelayMs,
  vaultEntryAutosaveIdleMs
} from "./entryAutosave";

afterEach(() => {
  vi.useRealTimers();
});

describe("EntryIdleDebounce", () => {
  it("resets only the entry that changed and ignores unchanged render versions", () => {
    vi.useFakeTimers();
    const debounce = new EntryIdleDebounce();
    const saveA = vi.fn();
    const saveB = vi.fn();
    const draftA1 = {};
    const draftA2 = {};
    const draftB = {};

    debounce.schedule("a", draftA1, MARKDOWN_ENTRY_AUTOSAVE_IDLE_MS, saveA);
    vi.advanceTimersByTime(1_000);
    debounce.schedule("b", draftB, MARKDOWN_ENTRY_AUTOSAVE_IDLE_MS, saveB);
    debounce.schedule("a", draftA1, MARKDOWN_ENTRY_AUTOSAVE_IDLE_MS, saveA);
    vi.advanceTimersByTime(1_000);
    debounce.schedule("a", draftA2, MARKDOWN_ENTRY_AUTOSAVE_IDLE_MS, saveA);

    vi.advanceTimersByTime(3_999);
    expect(saveB).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(saveB).toHaveBeenCalledOnce();
    expect(saveA).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(saveA).toHaveBeenCalledOnce();
  });

  it("waits for a full idle window after the final character of sustained input", () => {
    vi.useFakeTimers();
    const debounce = new EntryIdleDebounce();
    const save = vi.fn();

    debounce.schedule("note", { body: "a" }, MARKDOWN_ENTRY_AUTOSAVE_IDLE_MS, save);
    vi.advanceTimersByTime(1_000);
    debounce.schedule("note", { body: "ab" }, MARKDOWN_ENTRY_AUTOSAVE_IDLE_MS, save);
    vi.advanceTimersByTime(1_000);
    debounce.schedule("note", { body: "abc" }, MARKDOWN_ENTRY_AUTOSAVE_IDLE_MS, save);

    // Both earlier deadlines pass while the latest draft is still inside its
    // own idle window. No network save should start during active typing.
    vi.advanceTimersByTime(MARKDOWN_ENTRY_AUTOSAVE_IDLE_MS - 1);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(save).toHaveBeenCalledOnce();
  });

  it("cancels explicit saves and entries that are no longer dirty", () => {
    vi.useFakeTimers();
    const debounce = new EntryIdleDebounce();
    const saveA = vi.fn();
    const saveB = vi.fn();
    debounce.schedule("a", {}, MARKDOWN_ENTRY_AUTOSAVE_IDLE_MS, saveA);
    debounce.schedule("b", {}, CANVAS_ENTRY_AUTOSAVE_IDLE_MS, saveB);

    debounce.cancel("a");
    debounce.retain(new Set());
    vi.runAllTimers();
    expect(saveA).not.toHaveBeenCalled();
    expect(saveB).not.toHaveBeenCalled();
    expect(debounce.has("a")).toBe(false);
    expect(debounce.has("b")).toBe(false);
  });

  it("gives Canvas a longer idle window than Markdown", () => {
    expect(MARKDOWN_ENTRY_AUTOSAVE_IDLE_MS).toBe(5_000);
    expect(CANVAS_ENTRY_AUTOSAVE_IDLE_MS).toBe(15_000);
    expect(vaultEntryAutosaveIdleMs("markdown")).toBe(MARKDOWN_ENTRY_AUTOSAVE_IDLE_MS);
    expect(vaultEntryAutosaveIdleMs("canvas")).toBe(CANVAS_ENTRY_AUTOSAVE_IDLE_MS);
    expect(CANVAS_ENTRY_AUTOSAVE_IDLE_MS).toBeGreaterThan(MARKDOWN_ENTRY_AUTOSAVE_IDLE_MS);
  });

  it("uses a finite exponential retry window after an encrypted save failure", () => {
    expect(entryAutosaveRetryDelayMs(1)).toBe(1_000);
    expect(entryAutosaveRetryDelayMs(3)).toBe(4_000);
    expect(entryAutosaveRetryDelayMs(5)).toBe(16_000);
    expect(entryAutosaveRetryDelayMs(6)).toBeNull();
    expect(entryAutosaveRetryDelayMs(0)).toBeNull();
  });

  it("keeps an ordinary thinking pause free of encrypted Markdown writes", () => {
    vi.useFakeTimers();
    const debounce = new EntryIdleDebounce();
    const save = vi.fn();

    debounce.schedule("markdown", { body: "[[노트" }, MARKDOWN_ENTRY_AUTOSAVE_IDLE_MS, save);
    vi.advanceTimersByTime(3_000);
    expect(save).not.toHaveBeenCalled();
    debounce.schedule("markdown", { body: "[[노트]]" }, MARKDOWN_ENTRY_AUTOSAVE_IDLE_MS, save);
    vi.advanceTimersByTime(4_999);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(save).toHaveBeenCalledOnce();
  });

  it("does not save a one-character Canvas edit during a normal editing pause", () => {
    vi.useFakeTimers();
    const debounce = new EntryIdleDebounce();
    const save = vi.fn();

    debounce.schedule("canvas", { body: "a" }, CANVAS_ENTRY_AUTOSAVE_IDLE_MS, save);
    vi.advanceTimersByTime(14_999);
    expect(save).not.toHaveBeenCalled();
    expect(debounce.has("canvas")).toBe(true);

    vi.advanceTimersByTime(1);
    expect(save).toHaveBeenCalledOnce();
    expect(debounce.has("canvas")).toBe(false);
  });

  it("restarts the complete Canvas idle window after every local edit", () => {
    vi.useFakeTimers();
    const debounce = new EntryIdleDebounce();
    const save = vi.fn();

    debounce.schedule("canvas", { body: "a" }, CANVAS_ENTRY_AUTOSAVE_IDLE_MS, save);
    vi.advanceTimersByTime(10_000);
    debounce.schedule("canvas", { body: "ab" }, CANVAS_ENTRY_AUTOSAVE_IDLE_MS, save);
    vi.advanceTimersByTime(10_000);
    expect(save).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5_000);
    expect(save).toHaveBeenCalledOnce();
  });
});
