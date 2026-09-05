/* global document, window, console */
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureVaultFailureDom, observeVaultFailureDiagnostics, vaultDiagnosticEndpoint } from "../../tests/e2e/vault-failure-diagnostics.mjs";

afterEach(() => { document.body.replaceChildren(); window.history.replaceState(null, "", "/"); vi.restoreAllMocks(); });

describe("safe Vault failure diagnostics", () => {
  it("reports reference progress and document counts without note content, IDs or URL parameters", () => {
    window.history.replaceState(null, "", "/app?note=private-note&token=private-token");
    document.body.innerHTML = `<div class="vault-workspace" data-workspace-sync="pending"><input aria-label="노트 이름" value="private-title"><div class="cm-content" contenteditable="true">private-body</div><div class="vault-tab-bar"><button role="tab" aria-selected="true" id="entry:private-note">private-title</button></div><span class="vault-save-state">내부 참조 확인 중 · 0/0</span><span role="alert">폴더 목록을 불러오지 못했습니다.</span><span role="alert">private-error-with-secret</span></div>`;
    const result = captureVaultFailureDom();
    expect(result).toMatchObject({ pathname: "/app", editorCount: 1, titleInputCount: 1, tabCount: 1, activeTabCount: 1, saveState: "references", referenceProgress: [0, 0], workspaceSync: "pending", errorCodes: ["folder_subscription", "other"] });
    expect(JSON.stringify(result)).not.toContain("private-");
  });
  it("only emits allowlisted routes, save states and endpoints", () => {
    window.history.replaceState(null, "", "/wiki/private-slug?note=private-id");
    document.body.innerHTML = '<span class="vault-save-state">private-sensitive-status</span><div class="vault-workspace" data-workspace-sync="private-sync"></div>';
    expect(captureVaultFailureDom()).toMatchObject({ pathname: "other", saveState: "other", workspaceSync: "absent" });
    expect(vaultDiagnosticEndpoint("http://localhost:4174/api/vault-notes?action=create&note=private-id")).toBe("/api/vault-notes");
    expect(vaultDiagnosticEndpoint("http://localhost:4174/api/private-id")).toBeNull();
    expect(vaultDiagnosticEndpoint("private-malformed-url")).toBeNull();
    const commit = "/v1/projects/quickmemo-share-api-test/databases/(default)/documents:commit";
    expect(vaultDiagnosticEndpoint(`http://127.0.0.1:8080${commit}?token=private-token`)).toBe("firestore_commit");
    expect(vaultDiagnosticEndpoint(`https://firestore.googleapis.com${commit}`)).toBeNull();
    expect(vaultDiagnosticEndpoint(`http://127.0.0.1:8080${commit.replace("quickmemo-share-api-test", "private-project")}`)).toBeNull();
  });
  it("recognizes the actual login markup and a cleared or locked workspace without reading account labels", () => {
    window.history.replaceState(null, "", "/login?returnTo=private-path");
    document.body.innerHTML = '<main class="auth-page login-layout"><button>private-account</button></main>';
    expect(captureVaultFailureDom()).toMatchObject({ pathname: "/login", loginPresent: true, workspaceCount: 0, editorCount: 0, tabCount: 0, saveCount: 0 });
    document.body.innerHTML = '<div class="unlock-panel">private-owner</div>';
    expect(captureVaultFailureDom()).toMatchObject({ loginPresent: false, unlockPresent: true, editorCount: 0 });
    expect(JSON.stringify(captureVaultFailureDom())).not.toContain("private-");
  });
  it("logs once only on report, bounds network history and never reads payloads or request failures", async () => {
    const page = new EventEmitter();
    page.evaluate = vi.fn(async (capture) => capture());
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const diagnostics = observeVaultFailureDiagnostics(page);
    diagnostics.beginCreation(); diagnostics.mark("save_requested"); diagnostics.mark("private-phase");
    const forbiddenRead = vi.fn(() => { throw new Error("private-value"); });
    for (let index = 0; index < 25; index += 1) {
      const request = { url: () => "http://localhost:4174/api/vault-folders?uid=private-uid", postData: forbiddenRead, headers: forbiddenRead, failure: forbiddenRead };
      page.emit("request", request);
      page.emit("response", { request: () => request, status: () => 200, json: forbiddenRead, text: forbiddenRead });
    }
    const failed = { url: () => "http://localhost:4174/api/vault-integrity?secret=private-secret", failure: forbiddenRead };
    page.emit("request", failed); page.emit("requestfailed", failed);
    expect(log).not.toHaveBeenCalled();
    await diagnostics.report(); await diagnostics.report();
    expect(log).toHaveBeenCalledTimes(1); expect(forbiddenRead).not.toHaveBeenCalled();
    const line = log.mock.calls[0][0], result = JSON.parse(line.slice("[vault-flow-failure] ".length));
    expect(result).toMatchObject({ creation: 1, phase: "save_requested", pendingCount: 0 });
    expect(result.network).toHaveLength(40); expect(result.network.at(-1)).toMatchObject({ endpoint: "/api/vault-integrity", event: "failed" });
    expect(line).not.toContain("private-"); expect(line).not.toContain("?");
    diagnostics.dispose();
    for (const event of ["request", "response", "requestfailed"]) expect(page.listenerCount(event)).toBe(0);
  });
  it("handles an unavailable page without replacing the original test failure with a sensitive browser error", async () => {
    const page = new EventEmitter(); page.evaluate = vi.fn().mockRejectedValue(new Error("private-page-error"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const diagnostics = observeVaultFailureDiagnostics(page);
    await expect(diagnostics.report()).resolves.toBeUndefined();
    expect(log.mock.calls[0][0]).toContain('"unavailable":true');
    expect(log.mock.calls[0][0]).not.toContain("private-page-error");
    diagnostics.dispose();
  });
});
