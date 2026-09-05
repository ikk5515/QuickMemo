import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultVaultWorkspaceState } from "../features/vault/workspaceState";
import { vaultWorkspaceWithGraphViewport } from "./VaultPage";

const source = readFileSync(join(process.cwd(), "src/pages/VaultPage.tsx"), "utf8");

function sourceBetween(start: string, end: string) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("Vault graph viewport persistence", () => {
  it("immutably patches only the selected graph viewport", () => {
    const workspace = createDefaultVaultWorkspaceState();
    const globalViewport = { centerX: 12, centerY: -8, zoom: 1.5 };
    const withGlobal = vaultWorkspaceWithGraphViewport(workspace, "global", globalViewport);

    expect(withGlobal).not.toBe(workspace);
    expect(withGlobal.globalGraph).not.toBe(workspace.globalGraph);
    expect(withGlobal.localGraph).toBe(workspace.localGraph);
    expect(withGlobal.globalGraph.viewport).toEqual(globalViewport);
    expect(withGlobal.globalGraph.viewport).not.toBe(globalViewport);

    const localViewport = { centerX: -21, centerY: 34, zoom: 0.75 };
    const withLocal = vaultWorkspaceWithGraphViewport(withGlobal, "local", localViewport);
    expect(withLocal.globalGraph).toBe(withGlobal.globalGraph);
    expect(withLocal.localGraph).not.toBe(withGlobal.localGraph);
    expect(withLocal.localGraph.viewport).toEqual(localViewport);
    expect(withLocal.localGraph.viewport).not.toBe(localViewport);
  });

  it("records every interaction in refs before scheduling one trailing state commit", () => {
    const globalQueue = sourceBetween(
      "const queueGlobalGraphViewport = useCallback((viewport: GraphViewport) => {",
      "const queueLocalGraphViewport = useCallback((viewport: GraphViewport) => {"
    );
    const localQueue = sourceBetween(
      "const queueLocalGraphViewport = useCallback((viewport: GraphViewport) => {",
      'const activeMobileDrawer = surface === "memo" && mobileLayout'
    );

    for (const [queue, scope] of [[globalQueue, "global"], [localQueue, "local"]] as const) {
      const refWrite = queue.indexOf(`${scope}ViewportRef.current = latestViewport`);
      const workspaceWrite = queue.indexOf("latestWorkspaceStateRef.current = vaultWorkspaceWithGraphViewport(");
      const saveCancellation = queue.indexOf("cancelScheduledWorkspaceSave()");
      const timer = queue.indexOf("window.setTimeout(() => {");
      const stateCommit = queue.indexOf(scope === "global" ? "setGlobalViewport(" : "setLocalViewport(");

      expect(refWrite).toBeGreaterThan(-1);
      expect(workspaceWrite).toBeGreaterThan(refWrite);
      expect(saveCancellation).toBeGreaterThan(workspaceWrite);
      expect(timer).toBeGreaterThan(saveCancellation);
      expect(stateCommit).toBeGreaterThan(timer);
      expect(queue.match(scope === "global" ? /setGlobalViewport\(/gu : /setLocalViewport\(/gu)).toHaveLength(1);
      expect(queue).toContain("GRAPH_VIEWPORT_COMMIT_DELAY_MS");
    }
  });

  it("builds render and encrypted-save snapshots from the latest viewport refs", () => {
    expect(source.match(/globalViewport: globalViewportRef\.current/gu)).toHaveLength(2);
    expect(source.match(/localViewport: localViewportRef\.current/gu)).toHaveLength(2);
    expect(source).toContain("onViewportChange={queueGlobalGraphViewport}");
    expect(source).toContain("onViewportChange={queueLocalGraphViewport}");
    expect(source).not.toContain("onViewportChange={setGlobalViewport}");
    expect(source).not.toContain("onViewportChange={setLocalViewport}");
  });

  it("uses immediate viewport application for restore and graph bookmarks", () => {
    const restore = sourceBetween(
      "const applyRestoredWorkspace = useCallback((",
      "function keepCurrentWorkspaceAfterConflict()"
    );
    const bookmark = sourceBetween("function bookmarkGlobalGraph(", "function addSearchBookmark(");
    const openBookmark = sourceBetween("function openVaultBookmark(", "function removeVaultBookmark(");
    const command = sourceBetween("function handleCommand(", "function renderMarkdownCodeBlock(");

    expect(restore).toContain("applyGlobalGraphViewport(restored.globalGraph.viewport)");
    expect(restore).toContain("applyLocalGraphViewport(restored.localGraph.viewport)");
    expect(restore).toContain("latestWorkspaceStateRef.current = restored");
    expect(bookmark).toContain("viewport: globalViewportRef.current");
    expect(openBookmark).toContain("applyGlobalGraphViewport(bookmark.viewport)");
    expect(command).toContain("applyGlobalGraphViewport(bookmark.viewport)");
  });

  it("flushes, unload-checks, resolves conflicts, and cleans up from the latest refs", () => {
    const flush = sourceBetween(
      "async function flushWorkspaceBeforeExit() {",
      "async function flushVaultBeforeExit()"
    );
    const keepCurrent = sourceBetween(
      "function keepCurrentWorkspaceAfterConflict()",
      "async function reloadWorkspaceConflictRemote()"
    );
    const plaintextClear = source.match(
      /const clearVaultPlaintextForAccessScope = useCallback\(\(\) => \{[\s\S]*?\n\s{2}\}, \[\]\);/u
    )?.[0] ?? "";
    const unmountCleanup = sourceBetween(
      "useEffect(() => () => {\n    // WebCrypto work cannot be cancelled.",
      "  useEffect(() => {\n    decodedAssetCacheRef.current.clear();"
    );

    expect(flush.indexOf("commitPendingGraphViewports()")).toBeLessThan(
      flush.indexOf("const initialLatest = latestWorkspaceStateRef.current")
    );
    expect(flush.indexOf("cancelScheduledWorkspaceSave()")).toBeLessThan(
      flush.indexOf("const initialLatest = latestWorkspaceStateRef.current")
    );
    expect(flush).toContain("getCurrentState: () => latestWorkspaceStateRef.current");
    expect(source).toContain("JSON.stringify(latestWorkspaceStateRef.current) !== lastSavedWorkspaceRef.current");
    expect(keepCurrent).toContain("pendingWorkspaceStateRef.current = latestWorkspaceStateRef.current");
    expect(plaintextClear).toContain("window.clearTimeout(globalViewportCommitTimerRef.current)");
    expect(plaintextClear).toContain("window.clearTimeout(localViewportCommitTimerRef.current)");
    expect(unmountCleanup).toContain("window.clearTimeout(globalViewportCommitTimerRef.current)");
    expect(unmountCleanup).toContain("window.clearTimeout(localViewportCommitTimerRef.current)");
    expect(source).toContain("captureVaultWorkspaceLayout(latestWorkspaceStateRef.current)");
  });

  it("keeps auto-lock bounded grace active until deferred viewports and encrypted saves settle", () => {
    const guard = sourceBetween(
      "privateKeyAutoLockGuardRef.current = () => Boolean(",
      "const cancelScheduledWorkspaceSave = useCallback"
    );

    expect(guard).toContain("globalViewportCommitTimerRef.current !== null");
    expect(guard).toContain("localViewportCommitTimerRef.current !== null");
    expect(guard).toContain("workspaceSaveDebounceTimerRef.current !== null");
    expect(guard).toContain("workspaceSavePending");
    expect(guard).toContain("JSON.stringify(latestWorkspaceStateRef.current) !== lastSavedWorkspaceRef.current");
    expect(guard).toContain("registerPrivateKeyAutoLockGuard(");
  });
});
