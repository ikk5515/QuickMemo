/* global document, window, URL, console */

// Deliberately return no IDs, input values, query strings, content or error text.
// This function also runs directly in jsdom so the log's privacy boundary is tested.
export function captureVaultFailureDom() {
  const count = (selector) => document.querySelectorAll(selector).length;
  const save = document.querySelector(".vault-save-state")?.textContent?.trim() ?? "";
  const saves = {
    "저장됨": "saved", "자동 저장 대기": "dirty", "암호화 저장 중…": "saving",
    "저장 실패 · 다시 시도 필요": "save_failed", "저장 충돌 · 선택 필요": "conflict",
    "오프라인 · 현재 세션 메모리에 보존됨": "offline",
    "암호화 노트 생성 중…": "creating"
  };
  const progress = /^내부 참조 확인 중(?: · (\d{1,6})\/(\d{1,6}))?$/u.exec(save);
  const errors = {
    "암호화 노트 목록을 불러오지 못했습니다.": "note_subscription",
    "폴더 목록을 불러오지 못했습니다.": "folder_subscription",
    "Vault 복호화를 완료하지 못했습니다. 평문 캐시를 비우고 쓰기를 잠갔습니다.": "decryption",
    "서버의 최신 Vault 경로와 revision을 확인한 뒤 다시 시도해주세요.": "path_readiness",
    "암호화된 이름 예약 검증이 끝날 때까지 Vault 저장이 잠깁니다.": "name_readiness",
    "암호화된 이름 무결성 키가 준비될 때까지 Vault 쓰기가 잠깁니다.": "integrity_readiness"
  };
  const sync = document.querySelector(".vault-workspace")?.getAttribute("data-workspace-sync");
  return {
    pathname: ["/app", "/wiki", "/login", "/home", "/setup"].includes(window.location.pathname) ? window.location.pathname : "other",
    loginPresent: Boolean(document.querySelector("main.auth-page.login-layout")),
    unlockPresent: Boolean(document.querySelector(".unlock-panel")),
    workspaceCount: count(".vault-workspace"),
    editorCount: count('.cm-content[contenteditable="true"]'),
    titleInputCount: count('input[aria-label="노트 이름"]'),
    tabCount: count('.vault-tab-bar [role="tab"]'),
    activeTabCount: count('.vault-tab-bar [role="tab"][aria-selected="true"]'),
    wikiPanelCount: count(".wiki-panel"),
    saveCount: count(".vault-save-state"),
    saveState: !save ? "absent" : progress ? "references" : Object.hasOwn(saves, save) ? saves[save] : "other",
    referenceProgress: progress?.[1] ? [Number(progress[1]), Number(progress[2])] : null,
    workspaceSync: ["loading", "pending", "saved", "conflict"].includes(sync) ? sync : "absent",
    errorCodes: [...document.querySelectorAll('[role="alert"]')].slice(0, 8).map((element) => {
      const text = element.textContent?.trim() ?? "";
      return Object.hasOwn(errors, text) ? errors[text] : "other";
    })
  };
}

const endpoints = new Set(["/api/vault-notes", "/api/vault-folders", "/api/vault-integrity"]);
export function vaultDiagnosticEndpoint(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.origin === "http://127.0.0.1:8080"
      && url.pathname === "/v1/projects/quickmemo-share-api-test/databases/(default)/documents:commit") return "firestore_commit";
    return endpoints.has(url.pathname) ? url.pathname : null;
  } catch { return null; }
}

export function observeVaultFailureDiagnostics(page) {
  const started = Date.now(), network = [], pending = new Map();
  let reported = false, creation = 0, phase = "initial";
  const record = (event) => {
    network.push({ ms: Date.now() - started, ...event });
    if (network.length > 40) network.shift();
  };
  const onRequest = (request) => {
    const endpoint = vaultDiagnosticEndpoint(request.url());
    if (!endpoint) return;
    pending.set(request, endpoint);
    if (pending.size > 128) pending.delete(pending.keys().next().value);
    record({ endpoint, event: "request" });
  };
  const onResponse = (response) => {
    const request = response.request(), endpoint = pending.get(request);
    if (!endpoint) return;
    pending.delete(request);
    record({ endpoint, event: "response", status: response.status() });
  };
  const onFailed = (request) => {
    const endpoint = pending.get(request);
    if (!endpoint) return;
    pending.delete(request); record({ endpoint, event: "failed" });
  };
  page.on("request", onRequest); page.on("response", onResponse); page.on("requestfailed", onFailed);
  return {
    beginCreation() { creation += 1; phase = "opening_explorer"; },
    mark(next) {
      if (["create_clicked", "title_ready", "editor_ready", "save_requested", "saved"].includes(next)) phase = next;
    },
    async report() {
      if (reported) return;
      reported = true;
      let dom;
      try { dom = await page.evaluate(captureVaultFailureDom); } catch { dom = { unavailable: true }; }
      console.log(`[vault-flow-failure] ${JSON.stringify({ creation, phase, dom, network, pendingCount: pending.size })}`);
    },
    dispose() {
      page.off("request", onRequest); page.off("response", onResponse); page.off("requestfailed", onFailed);
      pending.clear(); network.length = 0;
    }
  };
}
