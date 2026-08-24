import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createVaultApiDeadline,
  VaultApiDeadlineError
} from "./vaultApiDeadline";

describe("Vault API deadline", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("releases a stalled operation after the bounded deadline", async () => {
    vi.useFakeTimers();
    const deadline = createVaultApiDeadline(undefined, 25);
    const stalled = deadline.race(new Promise<never>(() => undefined));
    const rejected = expect(stalled).rejects.toBeInstanceOf(VaultApiDeadlineError);

    await vi.advanceTimersByTimeAsync(25);

    await rejected;
    expect(deadline.timedOut()).toBe(true);
    deadline.dispose();
  });

  it("preserves an explicit caller abort separately from a timeout", async () => {
    const controller = new AbortController();
    const reason = new DOMException("cancelled", "AbortError");
    const deadline = createVaultApiDeadline(controller.signal, 1_000);
    const stalled = deadline.race(new Promise<never>(() => undefined));

    controller.abort(reason);

    await expect(stalled).rejects.toBe(reason);
    expect(deadline.timedOut()).toBe(false);
    deadline.dispose();
  });
});
