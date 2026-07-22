import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getNextLibraryItemsPage,
  LibraryItemRevisionConflictError,
  subscribeLibraryItems,
  touchLibraryItemOpened,
  type LibraryItemsCursor
} from "./library";

const mocks = vi.hoisted(() => {
  const transaction = {
    get: vi.fn(),
    update: vi.fn()
  };

  return {
    collection: vi.fn((_db: unknown, path: string) => ({ path })),
    db: { type: "firestore" },
    doc: vi.fn((_db: unknown, path: string, id: string) => ({ id, path })),
    documentId: vi.fn(() => "__name__"),
    getDocs: vi.fn(),
    limit: vi.fn((count: number) => ({ count, type: "limit" })),
    onSnapshot: vi.fn(),
    orderBy: vi.fn((field: string, direction: string) => ({ direction, field, type: "orderBy" })),
    query: vi.fn((...parts: unknown[]) => ({ parts, type: "query" })),
    runTransaction: vi.fn(async (_db: unknown, operation: (value: typeof transaction) => Promise<unknown>) =>
      operation(transaction)
    ),
    serverTimestamp: vi.fn(() => ({ type: "serverTimestamp" })),
    startAfter: vi.fn((...values: unknown[]) => ({ type: "startAfter", values })),
    transaction,
    where: vi.fn((...parts: unknown[]) => ({ parts, type: "where" }))
  };
});

vi.mock("../lib/firebase", () => ({ db: mocks.db }));

vi.mock("firebase/firestore", () => ({
  collection: mocks.collection,
  doc: mocks.doc,
  documentId: mocks.documentId,
  getDoc: vi.fn(),
  getDocs: mocks.getDocs,
  limit: mocks.limit,
  onSnapshot: mocks.onSnapshot,
  orderBy: mocks.orderBy,
  query: mocks.query,
  runTransaction: mocks.runTransaction,
  serverTimestamp: mocks.serverTimestamp,
  setDoc: vi.fn(),
  startAfter: mocks.startAfter,
  where: mocks.where
}));

function documentSnapshot(id: string, updatedAt = { seconds: 100, nanoseconds: 0 }) {
  return {
    data: () => ({
      generationId: `generation-${id}`,
      id,
      lastMutationId: `mutation-${id}`,
      ownerUid: "user-a",
      revision: 1,
      updatedAt
    }),
    id
  };
}

describe("library cursor pagination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.onSnapshot.mockImplementation((_query, onNext) => {
      onNext({ docs: [] });
      return vi.fn();
    });
  });

  it("subscribes to one bounded deterministic owner page and exposes a cursor", () => {
    const callback = vi.fn();
    const documents = Array.from({ length: 121 }, (_, index) => documentSnapshot(`item-${String(index).padStart(3, "0")}`));
    mocks.onSnapshot.mockImplementation((_query, onNext) => {
      onNext({ docs: documents });
      return vi.fn();
    });

    subscribeLibraryItems("user-a", null, callback, vi.fn(), 999);

    expect(mocks.where).toHaveBeenCalledWith("ownerUid", "==", "user-a");
    expect(mocks.orderBy).toHaveBeenCalledWith("updatedAt", "desc");
    expect(mocks.orderBy).toHaveBeenCalledWith("__name__", "desc");
    expect(mocks.limit).toHaveBeenCalledWith(121);
    expect(callback).toHaveBeenCalledWith({
      cursor: {
        id: "item-119",
        updatedAt: documents[119].data().updatedAt
      },
      hasMore: true,
      items: expect.arrayContaining([expect.objectContaining({ id: "item-000" })])
    });
    expect(callback.mock.calls[0]?.[0].items).toHaveLength(120);
  });

  it("loads the next page after both updatedAt and document id and applies only one facet", async () => {
    const cursor = { id: "same-time-b", updatedAt: { seconds: 100, nanoseconds: 0 } as never };
    mocks.getDocs.mockResolvedValue({ docs: [documentSnapshot("same-time-a")] });

    await expect(getNextLibraryItemsPage(
      "user-a",
      { field: "status", value: "archived" },
      cursor,
      120
    )).resolves.toMatchObject({
      cursor: { id: "same-time-a" },
      hasMore: false,
      items: [expect.objectContaining({ id: "same-time-a" })]
    });

    expect(mocks.where).toHaveBeenCalledWith("ownerUid", "==", "user-a");
    expect(mocks.where).toHaveBeenCalledWith("status", "==", "archived");
    expect(mocks.startAfter).toHaveBeenCalledWith(cursor.updatedAt, cursor.id);
    expect(mocks.limit).toHaveBeenCalledWith(121);
  });

  it("keeps a locally-created item visible while its server timestamp is still pending", () => {
    const callback = vi.fn();
    mocks.onSnapshot.mockImplementation((_query, onNext) => {
      onNext({ docs: [documentSnapshot("pending", null as never)] });
      return vi.fn();
    });

    subscribeLibraryItems("user-a", null, callback, vi.fn());

    expect(callback).toHaveBeenCalledWith({
      cursor: null,
      hasMore: false,
      items: [expect.objectContaining({ id: "pending", updatedAt: null })]
    });
  });

  it("keeps a 1,201st item reachable through repeated cursors instead of imposing a total cap", async () => {
    let page = 0;
    mocks.getDocs.mockImplementation(async () => {
      const remaining = 1_201 - page * 120;
      const count = Math.min(121, Math.max(0, remaining));
      const docs = Array.from({ length: count }, (_, index) => documentSnapshot(`item-${page * 120 + index}`));
      page += 1;
      return { docs };
    });

    let cursor: LibraryItemsCursor = {
      id: "head",
      updatedAt: { seconds: 2_000, nanoseconds: 0 } as never
    };
    let total = 0;
    let hasMore = true;

    while (hasMore) {
      const result = await getNextLibraryItemsPage("user-a", null, cursor);
      total += result.items.length;
      hasMore = result.hasMore;
      cursor = result.cursor!;
    }

    expect(total).toBe(1_201);
    expect(mocks.getDocs).toHaveBeenCalledTimes(11);
  });
});

describe("library open metadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.get.mockResolvedValue({
      data: () => ({ generationId: "generation-a", ownerUid: "user-a" }),
      exists: () => true
    });
  });

  it("updates only lastOpenedAt without advancing content mutation metadata", async () => {
    await touchLibraryItemOpened("item-a", "user-a", "generation-a");

    expect(mocks.transaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: "item-a" }),
      { lastOpenedAt: { type: "serverTimestamp" } }
    );
  });

  it("fails closed when a deterministic id has been recreated with another generation", async () => {
    await expect(touchLibraryItemOpened("item-a", "user-a", "generation-stale"))
      .rejects.toBeInstanceOf(LibraryItemRevisionConflictError);
    expect(mocks.transaction.update).not.toHaveBeenCalled();
  });
});
