import { beforeEach, describe, expect, it, vi } from "vitest";

const storageMocks = vi.hoisted(() => ({
  connectStorageEmulator: vi.fn(),
  getBytes: vi.fn(),
  getStorage: vi.fn(),
  ref: vi.fn()
}));

vi.mock("./firebase", () => ({
  app: { name: "quickmemo-test" },
  firebaseEmulatorsEnabled: true,
  legacyFirebaseStorageEnabled: true
}));

vi.mock("firebase/storage", () => storageMocks);

describe("legacy Firebase Storage lazy loader", () => {
  beforeEach(() => {
    storageMocks.connectStorageEmulator.mockClear();
    storageMocks.getBytes.mockReset();
    storageMocks.getStorage.mockClear();
    storageMocks.ref.mockClear();
  });

  it("loads, connects, and reuses the legacy storage instance on demand", async () => {
    const storage = { name: "legacy-storage" };
    const storageRef = { fullPath: "legacy/path" };
    storageMocks.getStorage.mockReturnValue(storage);
    storageMocks.ref.mockReturnValue(storageRef);
    storageMocks.getBytes.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);

    const { getLegacyStorageBytes } = await import("./legacyFirebaseStorage");

    await expect(getLegacyStorageBytes("legacy/path", 1024)).resolves.toEqual(new Uint8Array([1, 2, 3]));
    await expect(getLegacyStorageBytes("legacy/path", 1024)).resolves.toEqual(new Uint8Array([1, 2, 3]));

    expect(storageMocks.getStorage).toHaveBeenCalledTimes(1);
    expect(storageMocks.connectStorageEmulator).toHaveBeenCalledTimes(1);
    expect(storageMocks.connectStorageEmulator).toHaveBeenCalledWith(storage, "127.0.0.1", 9199);
    expect(storageMocks.ref).toHaveBeenCalledWith(storage, "legacy/path");
    expect(storageMocks.getBytes).toHaveBeenCalledWith(storageRef, 1024);
  });

  it("retries a transient module load failure without duplicating successful loads", async () => {
    const { createRetryableModuleLoader } = await import("./legacyFirebaseStorage");
    const moduleValue = { ready: true };
    const importer = vi.fn()
      .mockRejectedValueOnce(new Error("temporary chunk failure"))
      .mockResolvedValue(moduleValue);
    const loadModule = createRetryableModuleLoader(importer);

    await expect(loadModule()).rejects.toThrow("temporary chunk failure");
    await expect(loadModule()).resolves.toBe(moduleValue);
    await expect(loadModule()).resolves.toBe(moduleValue);
    expect(importer).toHaveBeenCalledTimes(2);
  });
});
