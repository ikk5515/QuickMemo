import { describe, expect, it } from "vitest";
import { parseObsidianMarkdown } from "./markdown";
import { matchesVaultSearchQuery, vaultSearchQueryUsesRegex } from "./query";
import type { VaultIndexEntry } from "./types";

const content = `---
status: active
---
# 첫 섹션

일반 문장 todo

- [ ] 실제 작업 deploy

# 둘째 섹션

별도 블록 release
`;
const entry: VaultIndexEntry = { id: "note", kind: "markdown", path: "Note.md", content };
const metadata = parseObsidianMarkdown(entry.id, entry.path, content);

describe("structured vault search fields", () => {
  it("limits task searches to Markdown task lines", () => {
    expect(matchesVaultSearchQuery("task:deploy", entry, metadata)).toBe(true);
    expect(matchesVaultSearchQuery("task:todo", entry, metadata)).toBe(false);
  });

  it("supports line, block, and section text fields", () => {
    expect(matchesVaultSearchQuery("line:release", entry, metadata)).toBe(true);
    expect(matchesVaultSearchQuery("block:실제", entry, metadata)).toBe(true);
    expect(matchesVaultSearchQuery("section:둘째", entry, metadata)).toBe(true);
  });

  it("can disable regular expressions for non-preemptible main-thread fallbacks", () => {
    expect(matchesVaultSearchQuery("content:/deploy/", entry, metadata)).toBe(true);
    expect(matchesVaultSearchQuery(
      "content:/(a+)+$/",
      entry,
      metadata,
      { allowRegex: false }
    )).toBe(false);
  });

  it("detects nested regular expressions before entering degraded main-thread search", () => {
    expect(vaultSearchQueryUsesRegex("tag:#work OR (content:/deploy/ -file:draft)")).toBe(true);
    expect(vaultSearchQueryUsesRegex("tag:#work path:Projects -file:draft")).toBe(false);
  });
});
