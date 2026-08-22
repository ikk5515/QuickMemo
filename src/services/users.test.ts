import { beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeUserProfile } from "./users";

const mocks = vi.hoisted(() => ({
  doc: vi.fn(() => ({ path: "users/user-a" })),
  onSnapshot: vi.fn(() => vi.fn())
}));

vi.mock("firebase/firestore", () => ({
  collection: vi.fn(),
  deleteField: vi.fn(),
  doc: mocks.doc,
  getDoc: vi.fn(),
  limit: vi.fn(),
  onSnapshot: mocks.onSnapshot,
  orderBy: vi.fn(),
  query: vi.fn(),
  serverTimestamp: vi.fn(),
  updateDoc: vi.fn(),
  where: vi.fn()
}));

vi.mock("../lib/firebase", () => ({ db: {} }));

describe("subscribeUserProfile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.onSnapshot.mockReturnValue(vi.fn());
  });

  it("does not invalidate a verified session from an empty cache snapshot", () => {
    const callback = vi.fn();
    subscribeUserProfile("user-a", callback);
    const subscriptionCall = (mocks.onSnapshot.mock.calls as unknown[][]).at(-1);
    const onNext = subscriptionCall?.[1] as ((snapshot: {
      data: () => unknown;
      exists: () => boolean;
      metadata: { fromCache: boolean };
    }) => void);

    onNext({
      data: () => undefined,
      exists: () => false,
      metadata: { fromCache: true }
    });

    expect(callback).not.toHaveBeenCalled();
  });

  it("reports a server-confirmed deletion and an existing cached profile", () => {
    const callback = vi.fn();
    subscribeUserProfile("user-a", callback);
    const subscriptionCall = (mocks.onSnapshot.mock.calls as unknown[][]).at(-1);
    const onNext = subscriptionCall?.[1] as ((snapshot: {
      data: () => unknown;
      exists: () => boolean;
      metadata: { fromCache: boolean };
    }) => void);
    const profile = { isActive: true, uid: "user-a" };

    onNext({
      data: () => profile,
      exists: () => true,
      metadata: { fromCache: true }
    });
    onNext({
      data: () => undefined,
      exists: () => false,
      metadata: { fromCache: false }
    });

    expect(callback).toHaveBeenNthCalledWith(1, profile, { fromCache: true });
    expect(callback).toHaveBeenNthCalledWith(2, null, { fromCache: false });
  });
});
