import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "src/pages/VaultPage.tsx"), "utf8");
const paneTreeSource = readFileSync(join(process.cwd(), "src/features/vault/WorkspacePaneTree.tsx"), "utf8");

function sourceBetween(start: string, end: string) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("Vault entry open intent wiring", () => {
  it("opens group intents in a bounded nested tab group instead of flattening them", () => {
    const openEntry = sourceBetween(
      "function openEntry(\n",
      "async function createEntry("
    );
    expect(openEntry).toContain('intent.target === "new-group"');
    expect(openEntry).toContain("planWorkspaceGroupSplit(newGroupDirection)");
    expect(openEntry).toContain("newGroupPlan?.groupId ?? activeTabGroupId");
    expect(openEntry).toContain("workspaceEntryTabId(entryId, targetGroupId)");
    expect(openEntry).toContain('targetGroupId === "primary" ? {} : { instanceId: targetGroupId }');
    expect(openEntry).toContain("openWorkspaceTabInGroup(tabGroups, nextTab.id, targetGroupId, replaceTabId)");
    expect(openEntry).toContain("setWorkspaceLayout(newGroupPlan.layout)");
    expect(openEntry).toContain("setActiveTabGroupId(groupPlan.activeTabGroupId)");
  });

  it("routes file-tree modifier clicks through the group-aware common opener", () => {
    const treeRender = sourceBetween("<VaultFileTree", '<section aria-label="Daily Notes"');
    const treeComponentStart = source.indexOf("function VaultFileTree(");
    expect(treeComponentStart).toBeGreaterThanOrEqual(0);
    const treeComponent = source.slice(treeComponentStart);
    expect(treeRender).toContain("onOpenEntry={openEntry}");
    expect(treeComponent).toContain("onOpenEntry(note.id, graphOpenIntentFromModifiers(event))");
  });

  it("routes Quick Switcher group requests through the group-aware common opener", () => {
    const quickSwitcherOpen = sourceBetween(
      "function handleQuickSwitcherOpen(",
      "function bookmarkGlobalGraph("
    );
    expect(quickSwitcherOpen).toContain('metadata.target === "new-tab-group"');
    expect(quickSwitcherOpen).toContain('? "new-group"');
    expect(quickSwitcherOpen).toContain("openEntry(entry.id, { target })");
  });

  it("routes Graph note requests through the group-aware common opener", () => {
    const graphOpen = sourceBetween(
      "function handleGraphNodeOpen(",
      "function handleMarkdownTagClick("
    );
    expect(graphOpen).toContain("openEntry(entryId, intent)");
    expect(source).toContain("onNodeOpen={stableHandleGraphNodeOpen}");
  });

  it("renders a recursive desktop layout and a single-surface mobile group selector", () => {
    expect(source).toContain("<WorkspacePaneTree");
    expect(source).toContain("layout={workspaceLayout}");
    expect(paneTreeSource).toContain("<WorkspacePaneNodeView node={node.first}");
    expect(paneTreeSource).toContain("paneByGroupId.get(activeGroupId)");
    expect(source).toContain('aria-label="탭 그룹 선택"');
    expect(source).toContain("<InactiveWorkspacePane");
  });

  it("keeps inactive Markdown panes editable and persists their dirty drafts", () => {
    const inactivePane = sourceBetween(
      "function InactiveWorkspacePane({",
      "interface VaultWorkspaceConflictState"
    );
    expect(inactivePane).toContain("<VaultMarkdownEditor");
    expect(inactivePane).toContain("onChange={onChange}");
    expect(inactivePane).toContain("onSave={onSave}");
    expect(source).toContain("if (groupActiveEntryId) updateEntryDraft(groupActiveEntryId, { body })");
    expect(source).toContain("const dirtyEntryIds = Object.entries(drafts)");
    expect(source).toContain("() => void saveEntry(entryId)");
  });

  it("resizes with an animation-frame CSS update and commits React state once on release", () => {
    const resizeStart = paneTreeSource.indexOf("function WorkspaceSplitView");
    expect(resizeStart).toBeGreaterThanOrEqual(0);
    const resize = paneTreeSource.slice(resizeStart);
    expect(resize).toContain("window.requestAnimationFrame");
    expect(resize).toContain('style.setProperty(\n        "--vault-split-ratio"');
    expect(resize).toContain("onResize(node.id, ratio)");
    expect(resize).toContain("onLostPointerCapture={handlePointerEnd}");
    expect(resize).toContain('window.addEventListener("blur", commitResize)');
  });
});
