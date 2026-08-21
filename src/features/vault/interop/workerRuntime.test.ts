import { describe, expect, it } from "vitest";
import { VaultInteropError } from "./types";
import { createVaultInteropWorkerRuntime } from "./workerRuntime";
import type { VaultInteropWorkerResponse } from "./workerProtocol";

function runRequest(request: unknown) {
  let response: VaultInteropWorkerResponse | undefined;
  let transfer: Transferable[] = [];
  let closed = false;
  createVaultInteropWorkerRuntime({
    postMessage: (nextResponse, nextTransfer) => {
      response = nextResponse;
      transfer = nextTransfer;
    },
    close: () => {
      closed = true;
    }
  }).handleRequest(request);
  return { response, transfer, closed };
}

describe("vault interoperability worker runtime", () => {
  it("exports and transfers both archive and manifest byte buffers", () => {
    const result = runRequest({
      id: "export-1",
      type: "export",
      sources: [
        { path: "Note.md", content: "# Note" },
        { path: "asset.bin", content: new Uint8Array([1, 2, 3]) }
      ],
      options: {}
    });

    expect(result.closed).toBe(true);
    expect(result.response?.type).toBe("export-result");
    if (result.response?.type !== "export-result") {
      throw new Error("Unexpected response");
    }
    expect(result.response.result.bytes.byteLength).toBeGreaterThan(0);
    const resultBuffers = [
      result.response.result.bytes.buffer,
      ...result.response.result.manifest.entries.map((entry) => entry.bytes.buffer)
    ];
    expect(result.transfer).toHaveLength(new Set(resultBuffers).size);
    expect(new Set(result.transfer)).toEqual(new Set(resultBuffers));
  });

  it("imports an archive and transfers every returned entry buffer", () => {
    const exported = runRequest({
      id: "export-2",
      type: "export",
      sources: [{ path: "한글/노트.md", content: "본문" }],
      options: {}
    });
    if (exported.response?.type !== "export-result") {
      throw new Error("Unexpected response");
    }

    const imported = runRequest({
      id: "import-1",
      type: "import",
      bytes: exported.response.result.bytes,
      options: {}
    });
    expect(imported.response?.type).toBe("import-result");
    if (imported.response?.type !== "import-result") {
      throw new Error("Unexpected response");
    }
    expect(imported.response.result.entries[0]?.text).toBe("본문");
    expect(imported.transfer).toEqual([
      imported.response.result.entries[0]?.bytes.buffer
    ]);
  });

  it("serializes typed failures without paths or exception messages", () => {
    const result = runRequest({
      id: "bad-path",
      type: "export",
      sources: [{ path: "../private-note.md", content: "private body" }],
      options: {}
    });

    expect(result.response).toEqual({
      id: "bad-path",
      type: "error",
      error: { kind: "vault", code: "invalid-path" }
    });
    expect(JSON.stringify(result.response)).not.toContain("private-note");
    expect(JSON.stringify(result.response)).not.toContain("private body");
  });

  it("returns a generic typed protocol error for malformed requests", () => {
    const result = runRequest({ id: "invalid", type: "import", bytes: "not bytes", options: {} });
    expect(result.response).toEqual({
      id: "invalid",
      type: "error",
      error: { kind: "worker", code: "invalid-request" }
    });
  });

  it("preserves VaultInteropError as the public domain error type", () => {
    const error = new VaultInteropError("zip-invalid");
    expect(error.code).toBe("zip-invalid");
  });
});
