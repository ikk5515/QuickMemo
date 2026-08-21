import { describe, expect, it } from "vitest";
import {
  VaultInteropWorkerCancelledError,
  VaultInteropWorkerClient,
  VaultInteropWorkerProtocolError,
  VaultInteropWorkerTerminatedError,
  type VaultInteropWorkerTransport
} from "./workerClient";
import { createVaultInteropWorkerRuntime } from "./workerRuntime";
import type {
  VaultInteropWorkerRequest,
  VaultInteropWorkerResponse
} from "./workerProtocol";

class LoopbackWorker implements VaultInteropWorkerTransport {
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessage: ((event: MessageEvent<VaultInteropWorkerResponse>) => void) | null = null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
  requestTransfer: Transferable[] = [];
  responseTransfer: Transferable[] = [];
  terminateCount = 0;

  postMessage(message: VaultInteropWorkerRequest, transfer: Transferable[]): void {
    this.requestTransfer = [...transfer];
    const workerRequest = structuredClone(message, { transfer });
    createVaultInteropWorkerRuntime({
      postMessage: (response, responseTransfer) => {
        this.responseTransfer = [...responseTransfer];
        const mainResponse = structuredClone(response, { transfer: responseTransfer });
        this.onmessage?.(new MessageEvent("message", { data: mainResponse }));
      }
    }).handleRequest(workerRequest);
  }

  terminate(): void {
    this.terminateCount += 1;
  }
}

class HangingWorker implements VaultInteropWorkerTransport {
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessage: ((event: MessageEvent<VaultInteropWorkerResponse>) => void) | null = null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
  terminateCount = 0;

  postMessage(): void {
    // Deliberately left pending to exercise AbortSignal and terminate().
  }

  terminate(): void {
    this.terminateCount += 1;
  }
}

describe("VaultInteropWorkerClient", () => {
  it("round-trips in isolated workers and transfers copied input buffers", async () => {
    const workers: LoopbackWorker[] = [];
    const client = new VaultInteropWorkerClient(() => {
      const worker = new LoopbackWorker();
      workers.push(worker);
      return worker;
    });
    const asset = new Uint8Array([7, 8, 9]);

    const exported = await client.exportVault([
      { path: "Note.md", content: "[[Other]]" },
      { path: "asset.bin", content: asset }
    ]);
    expect([...asset]).toEqual([7, 8, 9]);
    expect(workers[0]?.requestTransfer).toHaveLength(1);
    expect(workers[0]?.requestTransfer[0]).not.toBe(asset.buffer);
    expect(workers[0]?.responseTransfer.length).toBeGreaterThanOrEqual(2);
    expect(workers[0]?.terminateCount).toBe(1);

    const imported = await client.importVault(exported.bytes);
    expect(imported.entries.map((entry) => entry.path)).toEqual(["Note.md", "asset.bin"]);
    expect([...exported.bytes]).not.toHaveLength(0);
    expect(workers[1]?.requestTransfer).toHaveLength(1);
    expect(workers[1]?.requestTransfer[0]).not.toBe(exported.bytes.buffer);
    expect(workers[1]?.terminateCount).toBe(1);
  });

  it("recreates domain errors with their typed public code", async () => {
    const client = new VaultInteropWorkerClient(() => new LoopbackWorker());
    await expect(client.exportVault([
      { path: "../outside.md", content: "secret" }
    ])).rejects.toEqual(expect.objectContaining({
      name: "VaultInteropError",
      code: "invalid-path"
    }));
  });

  it("terminates a running operation when its AbortSignal fires", async () => {
    const worker = new HangingWorker();
    const client = new VaultInteropWorkerClient(() => worker);
    const controller = new AbortController();
    const pending = client.importVault(new Uint8Array([1]), {}, { signal: controller.signal });

    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(VaultInteropWorkerCancelledError);
    expect(worker.terminateCount).toBe(1);
  });

  it("terminates and rejects every active operation without retaining workers", async () => {
    const workers: HangingWorker[] = [];
    const client = new VaultInteropWorkerClient(() => {
      const worker = new HangingWorker();
      workers.push(worker);
      return worker;
    });
    const first = client.importVault(new Uint8Array([1]));
    const second = client.importVault(new Uint8Array([2]));

    client.terminate();

    await expect(first).rejects.toBeInstanceOf(VaultInteropWorkerTerminatedError);
    await expect(second).rejects.toBeInstanceOf(VaultInteropWorkerTerminatedError);
    expect(workers.map((worker) => worker.terminateCount)).toEqual([1, 1]);
    await expect(client.importVault(new Uint8Array([3]))).rejects.toBeInstanceOf(
      VaultInteropWorkerTerminatedError
    );
  });

  it("rejects a mismatched response rather than trusting its payload", async () => {
    const client = new VaultInteropWorkerClient(() => ({
      onerror: null,
      onmessage: null,
      onmessageerror: null,
      postMessage(message) {
        this.onmessage?.(new MessageEvent("message", {
          data: {
            id: message.id,
            type: "import-result",
            result: { entries: [], folders: [], skipped: [], totalBytes: 0, warnings: [] }
          }
        }));
      },
      terminate() {}
    }));

    await expect(client.exportVault([])).rejects.toBeInstanceOf(VaultInteropWorkerProtocolError);
  });
});
