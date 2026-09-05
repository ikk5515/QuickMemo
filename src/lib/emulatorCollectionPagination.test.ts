// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listEmulatorCollection } from "../../tests/helpers/secureShareApiEmulator";

const root = "http://127.0.0.1:8080/v1/projects/quickmemo-share-api-test/databases/(default)/documents";
const document = (id: string, ownerUid = "previous-owner") => ({ name: `${root}/notes/${id}`, fields: { ownerUid: { stringValue: ownerUid }, revision: { integerValue: "4" } } });
const page = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => { vi.stubEnv("FIRESTORE_EMULATOR_HOST", "127.0.0.1:8080"); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetAllMocks(); });

describe("emulator collection pagination", () => {
  it("keeps later owners when the server returns a short page with an opaque continuation token", async () => {
    const token = "opaque/+?&x=1# fragment";
    fetchMock.mockResolvedValueOnce(page({ documents: Array.from({ length: 150 }, (_, index) => document(`a-${index}`)), nextPageToken: token }))
      .mockResolvedValueOnce(page({ documents: [document("current-C", "current-owner"), document("current-D", "current-owner")] }));
    const notes = await listEmulatorCollection("notes");
    expect(notes).toHaveLength(152);
    expect(notes.filter(note => note.ownerUid === "current-owner").map(note => [note.__id, note.revision])).toEqual([["current-C", 4], ["current-D", 4]]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = new URL(String(fetchMock.mock.calls[0][0])), second = new URL(String(fetchMock.mock.calls[1][0]));
    expect(first.searchParams.get("pageSize")).toBe("300"); expect(first.searchParams.has("pageToken")).toBe(false);
    expect(second.origin).toBe(first.origin); expect(second.pathname).toBe(first.pathname);
    expect([...second.searchParams.keys()]).toEqual(["pageSize", "pageToken"]);
    expect(second.searchParams.get("pageToken")).toBe(token); expect(second.hash).toBe("");
  });
  it("continues through an empty intermediate page and stops at an empty final token", async () => {
    fetchMock.mockResolvedValueOnce(page({ documents: [document("a")], nextPageToken: "one" }))
      .mockResolvedValueOnce(page({ nextPageToken: "two" }))
      .mockResolvedValueOnce(page({ documents: [document("b")], nextPageToken: "" }));
    expect((await listEmulatorCollection("notes")).map(note => note.__id)).toEqual(["a", "b"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it("rejects a repeated token instead of returning a truncated owner inventory", async () => {
    fetchMock.mockResolvedValueOnce(page({ documents: [document("a")], nextPageToken: "same" }))
      .mockResolvedValueOnce(page({ documents: [document("b")], nextPageToken: "same" }));
    await expect(listEmulatorCollection("notes")).rejects.toThrow("pagination did not advance");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("bounds endless distinct continuation tokens", async () => {
    fetchMock.mockImplementation(async () => page({ nextPageToken: `next-${fetchMock.mock.calls.length}` }));
    await expect(listEmulatorCollection("notes")).rejects.toThrow("pagination limit exceeded");
    expect(fetchMock).toHaveBeenCalledTimes(100);
  });
  it.each([null, 12, {}])("rejects a malformed continuation token (%j)", async (nextPageToken) => {
    fetchMock.mockResolvedValueOnce(page({ nextPageToken }));
    await expect(listEmulatorCollection("notes")).rejects.toThrow("Invalid emulator collection page token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("preserves read failures instead of accepting a partial collection", async () => {
    fetchMock.mockResolvedValueOnce(page({ documents: [document("a")], nextPageToken: "next" }))
      .mockResolvedValueOnce(page({}, 503));
    await expect(listEmulatorCollection("notes")).rejects.toThrow("Emulator request failed (503)");
  });
  it("refuses non-loopback destinations before making a request", async () => {
    vi.stubEnv("FIRESTORE_EMULATOR_HOST", "firestore.googleapis.com:443");
    await expect(listEmulatorCollection("notes")).rejects.toThrow("loopback emulator");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
