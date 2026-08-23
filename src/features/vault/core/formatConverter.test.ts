import { describe, expect, it } from "vitest";
import {
  assertFormatConversionSourceUnchanged,
  planLegacyVaultFormatConversion
} from "./formatConverter";

const source = {
  body: "<h1>원본</h1><script>bad()</script>",
  contentFormat: "legacy-html-v1" as const,
  folderId: "folder-1",
  id: "legacy-1",
  revision: 7,
  title: "기존 노트"
};

describe("Vault format conversion plan", () => {
  it("keeps the original immutable and creates a copy-only lossy preview", () => {
    const plan = planLegacyVaultFormatConversion(source);
    expect(plan.copy).toMatchObject({
      folderId: "folder-1",
      sourceEntryId: "legacy-1",
      sourceRevision: 7,
      title: "기존 노트 Markdown"
    });
    expect(plan.copy.body).toContain("# 원본");
    expect(plan.copy.body).not.toContain("bad()");
    expect(plan.preview.lossy).toBe(true);
    expect(source.body).toContain("<script>");
  });

  it("rejects a source that changed after preview", () => {
    const plan = planLegacyVaultFormatConversion(source);
    expect(() => assertFormatConversionSourceUnchanged(plan, { ...source, revision: 8 })).toThrow("변경");
    expect(() => assertFormatConversionSourceUnchanged(plan, source)).not.toThrow();
  });
});
