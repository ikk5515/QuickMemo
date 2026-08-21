import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  downloadBlob,
  OBJECT_URL_REVOCATION_DELAY_MS
} from "./browserDownload";

describe("downloadBlob", () => {
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("clicks an attached anchor and defers blob URL revocation for WebKit", () => {
    const clickedWhileAttached: boolean[] = [];
    URL.createObjectURL = vi.fn(() => "blob:vault-export");
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function click(this: HTMLAnchorElement) {
      clickedWhileAttached.push(document.body.contains(this));
    });

    downloadBlob(new Blob(["vault"]), "QuickMemo-Vault.zip");

    expect(clickedWhileAttached).toEqual([true]);
    expect(document.querySelector("a")).toBeNull();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(OBJECT_URL_REVOCATION_DELAY_MS - 1);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:vault-export");
  });

  it("still removes the anchor and schedules revocation when the click throws", () => {
    URL.createObjectURL = vi.fn(() => "blob:failed-export");
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {
      throw new Error("click failed");
    });

    expect(() => downloadBlob(new Blob(), "Vault.zip")).toThrow("click failed");
    expect(document.querySelector("a")).toBeNull();
    vi.advanceTimersByTime(OBJECT_URL_REVOCATION_DELAY_MS);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:failed-export");
  });
});
