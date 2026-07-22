import {
  CalendarSync,
  CheckCircle2,
  CircleAlert,
  CircleMinus,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Unplug,
  X
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { GoogleCalendarConnectionStatus, GoogleCalendarSyncState } from "../services/googleCalendar";

export type GoogleCalendarDialogOperation = "connecting" | "disconnecting" | "syncing" | null;

export interface GoogleCalendarSyncProgress {
  completed: number;
  total: number;
}

interface GoogleCalendarSyncDialogProps {
  backgroundSyncPendingCount?: number;
  connection: GoogleCalendarConnectionStatus;
  eligibleExistingCount: number;
  error: string | null;
  loading: boolean;
  notice: string | null;
  operation: GoogleCalendarDialogOperation;
  progress: GoogleCalendarSyncProgress | null;
  onCancelSync: () => void;
  onClose: () => void;
  onConnect: (syncExisting: boolean) => void;
  onDisconnect: () => void;
  onRefresh: () => void;
  onSyncExisting: () => void;
}

const statusMeta: Record<GoogleCalendarSyncState, {
  Icon: typeof CheckCircle2;
  label: string;
  tone: string;
}> = {
  failed: { Icon: CircleAlert, label: "동기화 실패", tone: "failed" },
  idle: { Icon: CircleMinus, label: "미동기화", tone: "idle" },
  synced: { Icon: CheckCircle2, label: "동기화 완료", tone: "synced" }
};

function formattedSyncTime(value: string | null) {
  if (!value) {
    return "아직 동기화한 일정이 없습니다.";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "최근 동기화 시간이 기록되지 않았습니다.";
  }

  return `${new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date)}에 마지막으로 확인했습니다.`;
}

export function GoogleCalendarSyncDialog({
  backgroundSyncPendingCount = 0,
  connection,
  eligibleExistingCount,
  error,
  loading,
  notice,
  operation,
  progress,
  onCancelSync,
  onClose,
  onConnect,
  onDisconnect,
  onRefresh,
  onSyncExisting
}: GoogleCalendarSyncDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const disconnectTitleId = useId();
  const disconnectDescriptionId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const primaryActionRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const disconnectCancelRef = useRef<HTMLButtonElement>(null);
  const disconnectTriggerRef = useRef<HTMLButtonElement>(null);
  const focusLifecycleRef = useRef(0);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(false);
  const didFocusDefaultActionRef = useRef(false);
  const previousConnectedRef = useRef(connection.connected);
  const previousDisconnectConfirmRef = useRef(false);
  const [syncExistingOnConnect, setSyncExistingOnConnect] = useState(false);
  const [disconnectConfirm, setDisconnectConfirm] = useState(false);
  const busy = operation !== null;
  const hasStoredConnection = connection.connected || connection.hasStoredConnection;
  const syncState = connection.lastSyncStatus;
  const backgroundSyncing = backgroundSyncPendingCount > 0 || operation === "syncing";
  const stateMeta = statusMeta[syncState];
  const StatusIcon = backgroundSyncing ? LoaderCircle : stateMeta.Icon;
  const statusLabel = backgroundSyncing ? "동기화 중" : stateMeta.label;
  const tone = backgroundSyncing ? "syncing" : stateMeta.tone;

  useEffect(() => {
    onCloseRef.current = onClose;
    busyRef.current = busy;
  }, [busy, onClose]);

  useEffect(() => {
    const focusLifecycle = focusLifecycleRef.current + 1;
    focusLifecycleRef.current = focusLifecycle;
    if (!restoreFocusRef.current) {
      restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    const appRoot = document.getElementById("root");
    const previousAriaHidden = appRoot?.getAttribute("aria-hidden") ?? null;
    const previousBodyOverflow = document.body.style.overflow;
    const previousBodyOverscrollBehavior = document.body.style.overscrollBehavior;

    if (appRoot) {
      appRoot.inert = true;
      appRoot.setAttribute("aria-hidden", "true");
    }
    document.body.style.overflow = "hidden";
    document.body.style.overscrollBehavior = "contain";

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !busyRef.current) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
      );

      if (!focusable?.length) {
        event.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeElement = document.activeElement;

      if (!panelRef.current?.contains(activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }

      if (event.shiftKey && activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener("keydown", handleKeyDown, true);
    const safeInitialFocus = closeButtonRef.current && !closeButtonRef.current.disabled
      ? closeButtonRef.current
      : panelRef.current;
    safeInitialFocus?.focus({ preventScroll: true });

    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      if (appRoot) {
        appRoot.inert = false;
        if (previousAriaHidden === null) {
          appRoot.removeAttribute("aria-hidden");
        } else {
          appRoot.setAttribute("aria-hidden", previousAriaHidden);
        }
      }
      document.body.style.overflow = previousBodyOverflow;
      document.body.style.overscrollBehavior = previousBodyOverscrollBehavior;
      window.setTimeout(() => {
        if (focusLifecycleRef.current === focusLifecycle) {
          restoreFocusRef.current?.focus({ preventScroll: true });
        }
      }, 0);
    };
  }, []);

  useEffect(() => {
    if (loading) {
      const focusTimer = window.setTimeout(() => {
        const fallback = closeButtonRef.current && !closeButtonRef.current.disabled
          ? closeButtonRef.current
          : panelRef.current;

        fallback?.focus({ preventScroll: true });
      }, 0);

      return () => window.clearTimeout(focusTimer);
    }

    if (didFocusDefaultActionRef.current) {
      return;
    }

    const focusTimer = window.setTimeout(() => {
      if (didFocusDefaultActionRef.current) {
        return;
      }

      const preferred = primaryActionRef.current;
      const fallback = closeButtonRef.current && !closeButtonRef.current.disabled
        ? closeButtonRef.current
        : panelRef.current;

      (preferred && !preferred.disabled ? preferred : fallback)?.focus({ preventScroll: true });
      didFocusDefaultActionRef.current = true;
    }, 0);

    return () => window.clearTimeout(focusTimer);
  }, [loading]);

  useEffect(() => {
    const wasConnected = previousConnectedRef.current;
    previousConnectedRef.current = connection.connected;

    if (wasConnected && !connection.connected) {
      setDisconnectConfirm(false);
    }
  }, [connection.connected]);

  useEffect(() => {
    const wasConfirming = previousDisconnectConfirmRef.current;
    previousDisconnectConfirmRef.current = disconnectConfirm;

    if (wasConfirming === disconnectConfirm) {
      return;
    }

    const focusTimer = window.setTimeout(() => {
      if (disconnectConfirm) {
        disconnectCancelRef.current?.focus({ preventScroll: true });
        return;
      }

      const fallback = primaryActionRef.current && !primaryActionRef.current.disabled
        ? primaryActionRef.current
        : closeButtonRef.current && !closeButtonRef.current.disabled
          ? closeButtonRef.current
          : panelRef.current;
      (disconnectTriggerRef.current ?? fallback)?.focus({ preventScroll: true });
    }, 0);

    return () => window.clearTimeout(focusTimer);
  }, [disconnectConfirm]);

  const dialog = (
    <div
      className="google-calendar-sync-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) {
          onClose();
        }
      }}
    >
      <section
        ref={panelRef}
        aria-describedby={disconnectConfirm ? disconnectDescriptionId : descriptionId}
        aria-labelledby={disconnectConfirm ? disconnectTitleId : titleId}
        aria-modal="true"
        className="google-calendar-sync-dialog"
        role={disconnectConfirm ? "alertdialog" : "dialog"}
        tabIndex={-1}
      >
        <header className="google-calendar-sync-header">
          <div className="google-calendar-sync-heading">
            <span className="google-calendar-sync-icon" aria-hidden="true">
              <CalendarSync size={22} />
            </span>
            <div>
              <p>외부 캘린더 연결</p>
              <h2 id={titleId}>Google Calendar 동기화</h2>
            </div>
          </div>
          <div className="google-calendar-sync-header-tools">
            <span className={`google-calendar-sync-badge ${tone}`} role="status">
              <StatusIcon className={backgroundSyncing ? "spin" : undefined} size={15} aria-hidden="true" />
              {statusLabel}
            </span>
            <button
              ref={closeButtonRef}
              className="icon-button google-calendar-sync-close"
              disabled={busy}
              onClick={onClose}
              type="button"
              aria-label="Google Calendar 동기화 창 닫기"
            >
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="google-calendar-sync-body">
          <p className="google-calendar-sync-description" id={descriptionId}>
            QuickMemo 계정마다 Google 계정을 하나씩 연결하고, 날짜가 있는 일반 일정을 한 방향으로 반영합니다.
          </p>

          {loading ? (
            <div className="google-calendar-sync-loading" role="status">
              <LoaderCircle className="spin" size={20} />
              연결 상태를 안전하게 확인하는 중입니다.
            </div>
          ) : (
            <>
              <section className={`google-calendar-account-card ${connection.connected ? "connected" : ""}`}>
                <div>
                  <span className="google-calendar-account-label">연결 계정</span>
                  <strong>
                    {hasStoredConnection
                      ? connection.email || (connection.connected ? "연결된 Google 계정" : "연결 갱신 필요")
                      : "연결된 계정 없음"}
                  </strong>
                  <small>
                    {!connection.configured
                      ? "관리자가 Google Calendar API 설정을 확인해야 합니다."
                      : connection.connected
                      ? `${connection.timeZone || "Asia/Seoul"} 시간대로 자동 동기화됩니다.`
                      : connection.needsReconnect || hasStoredConnection
                        ? "권한이 만료되었습니다. Google 계정을 다시 연결해주세요."
                        : "Google 공식 로그인 화면에서 계정을 선택합니다."}
                  </small>
                </div>
                <span className="google-calendar-account-state" aria-hidden="true">
                  {connection.connected
                    ? <CheckCircle2 size={22} />
                    : hasStoredConnection
                      ? <CircleAlert size={22} />
                      : <CircleMinus size={22} />}
                </span>
              </section>

              {connection.connected && (
                <section className="google-calendar-sync-summary" aria-label="최근 동기화 상태">
                  <div>
                    <span>최근 상태</span>
                    <strong>{statusLabel}</strong>
                  </div>
                  <div>
                    <span>반영한 일정</span>
                    <strong>{connection.syncedCount}개</strong>
                  </div>
                  <p>{formattedSyncTime(connection.lastSyncAt)}</p>
                </section>
              )}

              {progress && progress.total > 0 && (
                <div className="google-calendar-sync-progress" role="status" aria-live="polite">
                  <div>
                    <span>기존 일정 동기화 중</span>
                    <strong>{progress.completed}/{progress.total}</strong>
                  </div>
                  <progress
                    aria-label={`기존 일정 동기화 진행률 ${progress.completed}/${progress.total}`}
                    max={progress.total}
                    value={progress.completed}
                  />
                </div>
              )}

              {error && (
                <div className="google-calendar-sync-error" role="alert">
                  <CircleAlert size={18} aria-hidden="true" />
                  <span>{error}</span>
                </div>
              )}

              {!error && notice && (
                <div className="google-calendar-sync-notice" role="status" aria-live="polite">
                  <CircleMinus size={18} aria-hidden="true" />
                  <span>{notice}</span>
                </div>
              )}

              {!connection.connected && connection.configured && (
                <label className="google-calendar-existing-option">
                  <input
                    checked={syncExistingOnConnect}
                    disabled={busy || eligibleExistingCount === 0}
                    onChange={(event) => setSyncExistingOnConnect(event.target.checked)}
                    type="checkbox"
                  />
                  <span>
                    <strong>기존 일정도 한 번 동기화</strong>
                    <small>
                      날짜가 있는 기존 일정 {eligibleExistingCount}개를 연결 직후 함께 반영합니다. 과거나 완료된 일정도 포함하며, 이미 동기화된 일정은 중복 등록하지 않습니다.
                    </small>
                  </span>
                </label>
              )}

              {connection.connected && (
                <div className="google-calendar-existing-option google-calendar-existing-summary">
                  <CalendarSync size={18} aria-hidden="true" />
                  <span>
                    <strong>기존 일정 동기화 범위</strong>
                    <small>
                      날짜가 있는 기존 일정 {eligibleExistingCount}개가 대상입니다. 과거나 완료된 일정도 포함하며, 이미 동기화된 일정은 중복 등록하지 않습니다.
                    </small>
                  </span>
                </div>
              )}

              <div className="google-calendar-security-note">
                <ShieldCheck size={19} aria-hidden="true" />
                <div>
                  <strong>비밀번호는 QuickMemo에 입력하지 않습니다.</strong>
                  <p>
                    Google 공식 로그인 창에서만 인증하며 제목·날짜·시간만 전송합니다. 상세 내용과 체크리스트는 전송하지 않습니다.
                  </p>
                </div>
              </div>

              {disconnectConfirm ? (
                <div className="google-calendar-disconnect-confirm">
                  <div>
                    <strong id={disconnectTitleId}>이 Google 계정 연결을 해제할까요?</strong>
                    <p id={disconnectDescriptionId}>이미 Google Calendar에 등록된 일정은 유지되고, 이후 자동 동기화만 중단됩니다.</p>
                  </div>
                  <div>
                    <button
                      ref={disconnectCancelRef}
                      disabled={busy}
                      onClick={() => setDisconnectConfirm(false)}
                      type="button"
                    >
                      취소
                    </button>
                    <button
                      className="danger-button"
                      disabled={busy}
                      onClick={onDisconnect}
                      type="button"
                    >
                      {operation === "disconnecting" ? <LoaderCircle className="spin" size={16} /> : <Unplug size={16} />}
                      연결 해제
                    </button>
                  </div>
                </div>
              ) : (
                <footer className="google-calendar-sync-actions">
                  {connection.connected ? (
                    <>
                      <button
                        ref={disconnectTriggerRef}
                        className="secondary-button"
                        disabled={busy}
                        onClick={() => setDisconnectConfirm(true)}
                        type="button"
                      >
                        <Unplug size={16} />
                        연결 해제
                      </button>
                      <button
                        className="secondary-button"
                        disabled={busy}
                        onClick={onRefresh}
                        type="button"
                      >
                        <RefreshCw size={16} />
                        상태 새로고침
                      </button>
                      {operation === "syncing" ? (
                        <button
                          ref={primaryActionRef}
                          className="google-calendar-primary-button"
                          onClick={onCancelSync}
                          type="button"
                        >
                          <X size={16} />
                          동기화 취소
                        </button>
                      ) : (
                        <button
                          ref={primaryActionRef}
                          className="google-calendar-primary-button"
                          disabled={busy || eligibleExistingCount === 0}
                          onClick={onSyncExisting}
                          type="button"
                        >
                          <CalendarSync size={16} />
                          기존 일정 동기화
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      {hasStoredConnection && (
                        <button
                          ref={disconnectTriggerRef}
                          className="secondary-button"
                          disabled={busy}
                          onClick={() => setDisconnectConfirm(true)}
                          type="button"
                        >
                          <Unplug size={16} />
                          연결 해제
                        </button>
                      )}
                      <button
                        ref={primaryActionRef}
                        className="google-calendar-primary-button"
                        disabled={busy || !connection.configured}
                        onClick={() => onConnect(syncExistingOnConnect)}
                        type="button"
                      >
                        {operation === "connecting" ? <LoaderCircle className="spin" size={16} /> : <ExternalLink size={16} />}
                        {operation === "connecting"
                          ? "Google 계정 확인 중"
                          : !connection.configured
                            ? "관리자 설정 필요"
                            : connection.needsReconnect || hasStoredConnection
                              ? "Google 계정 다시 연결"
                              : "Google 계정 연결"}
                      </button>
                    </>
                  )}
                </footer>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );

  return createPortal(dialog, document.body);
}
