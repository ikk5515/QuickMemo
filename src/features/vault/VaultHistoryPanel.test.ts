import { describe, expect, it } from "vitest";
import type { DecryptedVaultNote } from "./vaultData";
import { parseVaultHistorySnapshot } from "./VaultHistoryPanel";

const note = {
  contentFormat: "markdown-v1",
  entryKind: "markdown",
  id: "note-a"
} as DecryptedVaultNote;

describe("Vault File Recovery snapshot", () => {
  it("accepts only bounded snapshots matching the current entry format", () => {
    expect(parseVaultHistorySnapshot(JSON.stringify({
      body: "# 이전 버전",
      contentFormat: "markdown-v1",
      entryKind: "markdown",
      folderId: null,
      title: "이전"
    }), note)).toMatchObject({ body: "# 이전 버전", title: "이전" });
    expect(parseVaultHistorySnapshot(JSON.stringify({
      body: "{}",
      contentFormat: "json-canvas-v1",
      entryKind: "canvas",
      folderId: null,
      title: "위조"
    }), note)).toBeNull();
    expect(parseVaultHistorySnapshot("not-json", note)).toBeNull();
  });
});
