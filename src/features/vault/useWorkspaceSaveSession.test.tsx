import { cleanup, renderHook } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useWorkspaceSaveSession, type WorkspaceSaveSessionToken } from "./useWorkspaceSaveSession";

afterEach(cleanup);

const keyA = { type: "private" } as CryptoKey;
const keyB = { type: "private" } as CryptoKey;

describe("workspace write receipt session lifetime", () => {
  it("keeps a successful numeric receipt across same-owner metadata and ACL-like rerenders", () => {
    const revision = { current: 3 as number | undefined };
    const { result, rerender } = renderHook(({ profile, key, visibleEntries }) => {
      void visibleEntries;
      return useWorkspaceSaveSession(profile.uid, key, revision);
    }, { initialProps: { profile: { uid: "owner", displayName: "Before" }, key: keyA, visibleEntries: ["kept", "revoked"] } });
    const token = result.current.capture();
    expect(token).not.toBeNull();
    rerender({ profile: { uid: "owner", displayName: "After" }, key: keyA, visibleEntries: ["kept"] });
    expect(result.current.capture()).toBe(token);
    expect(result.current.acknowledge(token, 4)).toBe(true);
    expect(revision.current).toBe(4);
  });

  it.each(["uid", "key", "locked"])("rejects an old successful receipt after %s changes", (change) => {
    const revision = { current: 3 as number | undefined };
    const { result, rerender } = renderHook(({ uid, key }) => useWorkspaceSaveSession(uid, key, revision), {
      initialProps: { uid: "owner", key: keyA as CryptoKey | null }
    });
    const prior = result.current;
    const token = prior.capture();
    rerender({ uid: change === "uid" ? "other" : "owner", key: change === "locked" ? null : change === "key" ? keyB : keyA });
    expect(prior.isCurrent(token)).toBe(false);
    expect(prior.acknowledge(token, 4)).toBe(false);
    expect(revision.current).toBe(3);
    rerender({ uid: "owner", key: keyA });
    expect(result.current.capture()).not.toBe(token);
    expect(result.current.acknowledge(token, 5)).toBe(false);
    expect(revision.current).toBe(3);
  });

  it("revokes receipts on unmount even when the same UID and key remount", () => {
    const revision = { current: 3 as number | undefined };
    const first = renderHook(() => useWorkspaceSaveSession("owner", keyA, revision));
    const previous = first.result.current;
    const token = previous.capture();
    first.unmount();
    expect(previous.isCurrent(token)).toBe(false);
    expect(previous.acknowledge(token, 4)).toBe(false);
    const second = renderHook(() => useWorkspaceSaveSession("owner", keyA, revision));
    expect(second.result.current.capture()).not.toBe(token);
    expect(second.result.current.acknowledge(token, 4)).toBe(false);
    expect(previous.acknowledge(token, 4)).toBe(false);
    expect(revision.current).toBe(3);
  });

  it("creates a new token for the StrictMode cleanup/setup cycle", () => {
    const revision = { current: 3 as number | undefined };
    const tokens: Array<WorkspaceSaveSessionToken | null> = [];
    const { result } = renderHook(() => {
      const session = useWorkspaceSaveSession("owner", keyA, revision);
      useLayoutEffect(() => { tokens.push(session.capture()); }, [session]);
      return session;
    }, { reactStrictMode: true });
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).not.toBe(tokens[1]);
    expect(result.current.acknowledge(tokens[0], 4)).toBe(false);
    expect(result.current.acknowledge(tokens[1], 4)).toBe(true);
    expect(revision.current).toBe(4);
  });

  it.each([undefined, null, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "4", 1_000_000_000_000])(
    "ignores invalid receipt revision %s", (value) => {
      const revision = { current: 3 as number | undefined };
      const { result } = renderHook(() => useWorkspaceSaveSession("owner", keyA, revision));
      expect(result.current.acknowledge(result.current.capture(), value)).toBe(false);
      expect(revision.current).toBe(3);
    }
  );

  it("never regresses a known revision and accepts initial or duplicate acknowledgements", () => {
    const revision = { current: undefined as number | undefined };
    const { result } = renderHook(() => useWorkspaceSaveSession("owner", keyA, revision));
    const token = result.current.capture();
    expect(result.current.acknowledge(token, 1)).toBe(true);
    expect(result.current.acknowledge(token, 5)).toBe(true);
    expect(result.current.acknowledge(token, 4)).toBe(false);
    expect(revision.current).toBe(5);
    expect(result.current.acknowledge(token, 5)).toBe(true);
    expect(revision.current).toBe(5);
    expect(result.current.acknowledge(null, 6)).toBe(false);
  });
});
