/* global document, window, URL */
import { writeFile } from "node:fs/promises";

const observers = new WeakMap();
const origins = new Set(["http://127.0.0.1:4174", "http://127.0.0.1:8080", "http://127.0.0.1:9099"]);
const endpoints = new Set(["/api/published-wikis", "/api/vault-integrity", "/api/vault-notes", "/api/vault-folders"]);
const phases = new Set(["setup", "private-note", "individual-note", "root-folder", "initial-published-note", "initial-publication",
  "descendant-folder", "descendant-note", "descendant-publication", "source-folder", "source-note", "image-file-selection", "image-embed-insertion", "image-publication"]);

// Never retain headers, query strings, bodies, IDs, exception text, or remote URLs.
export function diagnosticEndpoint(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  if (!origins.has(url.origin)) return null;
  if (endpoints.has(url.pathname)) return url.pathname;
  for (const [rpc, restName] of [["Commit", "commit"], ["BatchGetDocuments", "batchGet"], ["RunQuery", "runQuery"], ["Listen/channel", ""], ["Write/channel", ""]]) {
    if (url.pathname.endsWith(`/${rpc}`) || (restName && url.pathname.endsWith(`:${restName}`))) return `firestore:${rpc}`;
  }
  return null;
}

export function observeWikiFixtureDiagnostics(page) {
  observers.get(page)?.stop();
  const started = Date.now();
  let phase = "setup";
  const events = [];
  const append = (event) => {
    events.push({ ms: Date.now() - started, phase, ...event });
    if (events.length > 120) events.shift();
  };
  const response = (value) => {
    const endpoint = diagnosticEndpoint(value.url());
    if (endpoint) append({ type: "response", endpoint, status: value.status() });
  };
  const failed = (value) => {
    const endpoint = diagnosticEndpoint(value.url());
    if (endpoint) append({ type: "requestfailed", endpoint });
  };
  // Do not observe native dialogs here: merely adding a dialog listener changes
  // Playwright's automatic dismissal behavior. Prompt assertions own their handler.
  page.on("response", response); page.on("requestfailed", failed);
  const stop = () => {
    page.off("response", response); page.off("requestfailed", failed);
  };
  observers.set(page, { events, stop, phase: () => phase });
  return { mark(value) { if (phases.has(value)) phase = value; } };
}

export async function finishWikiFixtureDiagnostics(page, testInfo) {
  const observer = observers.get(page);
  if (!observer) return;
  observers.delete(page); observer.stop();
  if (testInfo.status === testInfo.expectedStatus) return;
  // This observer belongs exclusively to synthetic loopback tests. A wrong
  // origin fails closed without reading the page or writing a snapshot.
  let origin;
  try { origin = new URL(page.url()).origin; } catch { return; }
  if (origin !== "http://127.0.0.1:4174") return;
  const state = await page.evaluate(() => {
    if (window.location.origin !== "http://127.0.0.1:4174") return null;
    const save = document.querySelector(".vault-save-state")?.textContent ?? "";
    const saveState = save === "저장됨" ? "saved" : save.includes("저장 실패") ? "failed"
      : save.includes("내부 참조") ? "path-rewrite" : save.includes("생성 중") ? "creating"
      : save.includes("충돌") ? "conflict" : save.includes("암호화 저장") ? "saving" : "other-or-absent";
    const workspace = document.querySelector(".vault-workspace")?.getAttribute("data-workspace-sync");
    const control = (selector) => {
      const element = document.querySelector(selector);
      return { present: Boolean(element), disabled: element ? element.matches(":disabled") : null };
    };
    return {
      saveState,
      workspace: ["saved", "pending", "conflict", "loading"].includes(workspace) ? workspace : "other-or-absent",
      tabCount: document.querySelectorAll('.vault-tab-bar [role="tab"]').length,
      selectedTabCount: document.querySelectorAll('.vault-tab-bar [role="tab"][aria-selected="true"]').length,
      explorerItemCount: document.querySelectorAll('.vault-left-panel [role="treeitem"]').length,
      editorCount: document.querySelectorAll(".cm-content").length,
      editableEditorCount: document.querySelectorAll('.cm-content[contenteditable="true"]').length,
      alertCount: document.querySelectorAll('[role="alert"]').length,
      title: control('input[aria-label="노트 이름"]'),
      createNote: control('.vault-panel-toolbar button[aria-label="새 노트"]'),
      createFolder: control('.vault-panel-toolbar button[aria-label="새 폴더"]'),
      addImage: control('button[aria-label="이미지 파일 추가"]')
    };
  }).catch(() => null);
  const body = JSON.stringify({ phase: observer.phase(), state, events: observer.events }, null, 2);
  await writeFile(testInfo.outputPath("wiki-fixture-diagnostic.json"), body);
  await testInfo.attach("wiki-fixture-diagnostic", { contentType: "application/json", body });
}
