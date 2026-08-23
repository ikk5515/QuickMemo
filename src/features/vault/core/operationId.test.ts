import { describe, expect, it } from "vitest";
import { deterministicVaultOperationId } from "./operationId";

describe("deterministic Vault operation ids", () => {
  it("is stable, opaque, and domain separated", async () => {
    const operationId = "123e4567-e89b-12d3-a456-426614174000";
    const job = await deterministicVaultOperationId("vi1_", operationId, "note-composer-job");
    const repeated = await deterministicVaultOperationId("vi1_", operationId, "note-composer-job");
    const target = await deterministicVaultOperationId("vit1_", operationId, "note-composer-entry");

    expect(job).toBe(repeated);
    expect(job).toMatch(/^vi1_[A-Za-z0-9_-]{43}$/u);
    expect(target).toMatch(/^vit1_[A-Za-z0-9_-]{43}$/u);
    expect(job.slice(4)).not.toBe(target.slice(5));
    expect(job).not.toContain(operationId);
  });

  it("rejects malformed or oversized inputs", async () => {
    await expect(deterministicVaultOperationId("vi1_", "short", "note-composer-job")).rejects.toThrow(
      "식별자"
    );
    await expect(deterministicVaultOperationId("vi1_", "valid_operation", "../secret")).rejects.toThrow(
      "용도"
    );
  });
});
