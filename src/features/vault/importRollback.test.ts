import { describe, expect, it, vi } from "vitest";
import { compensateCreatedVaultImportEntries } from "./importRollback";

describe("compensateCreatedVaultImportEntries", () => {
  it("soft-deletes only supplied import entries in reverse creation order", async () => {
    const softDelete = vi.fn(async (entry: { noteId: string; revision: number }) => {
      expect(entry.noteId).toBeTruthy();
    });
    const result = await compensateCreatedVaultImportEntries([
      { noteId: "first", revision: 1 },
      { noteId: "second", revision: 2 }
    ], softDelete);

    expect(softDelete.mock.calls.map(([entry]) => entry.noteId)).toEqual(["second", "first"]);
    expect(result).toEqual({ attempted: 2, cleanupFailed: 0, softDeleted: 2 });
  });

  it("continues compensation after a soft-delete failure and reports the residue", async () => {
    const softDelete = vi.fn(async ({ noteId }: { noteId: string }) => {
      if (noteId === "second") {
        throw new Error("transient");
      }
    });
    await expect(compensateCreatedVaultImportEntries([
      { noteId: "first", revision: 1 },
      { noteId: "second", revision: 1 }
    ], softDelete)).resolves.toEqual({ attempted: 2, cleanupFailed: 1, softDeleted: 1 });
    expect(softDelete).toHaveBeenCalledTimes(2);
  });
});
