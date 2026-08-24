import { Loader2, MessageCircle, RotateCcw } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  mergeSecureShareComments,
  type SecureShareCommentDto,
  type SecureShareCommentsPage
} from "../lib/secureShareComments";
import type { SecureShareOwnerSummary } from "../types";

export interface SecureShareOwnerCommentTarget {
  policyVersion: number;
  shareId: string;
  sourceNoteId: string;
}

export type SecureShareOwnerCommentLoader = (
  target: SecureShareOwnerCommentTarget,
  cursor: string | null,
  signal: AbortSignal
) => Promise<SecureShareCommentsPage>;

const secureShareOwnerCommentDateFormatter = new Intl.DateTimeFormat("ko-KR", {
  dateStyle: "medium",
  timeStyle: "short"
});

interface SecureShareOwnerCommentsState {
  error: string;
  items: SecureShareCommentDto[];
  loading: boolean;
  loadingMore: boolean;
  nextCursor: string | null;
  policyVersion: number;
  shareId: string;
}

function initialSecureShareOwnerCommentsState(
  target: SecureShareOwnerCommentTarget
): SecureShareOwnerCommentsState {
  return {
    error: "",
    items: [],
    loading: true,
    loadingMore: false,
    nextCursor: null,
    policyVersion: target.policyVersion,
    shareId: target.shareId
  };
}

function secureShareCommentBadgeLabel(badge: SecureShareCommentDto["badge"]) {
  if (badge === "admin") {
    return "관리자";
  }
  if (badge === "owner") {
    return "소유자";
  }
  if (badge === "quickmemo_user") {
    return "QuickMemo 사용자";
  }
  if (badge === "email_verified") {
    return "이메일 인증됨";
  }
  return "게스트";
}

function SecureShareOwnerCommentIdentity({
  displayName,
  ipPrefix
}: {
  displayName: string;
  ipPrefix?: string;
}) {
  if (!ipPrefix) {
    return <strong>{displayName}</strong>;
  }

  return (
    <span className="secure-share-comment-author-identity">
      <span className="sr-only">{displayName}, 네트워크 대역 {ipPrefix}</span>
      <strong aria-hidden="true">{displayName}</strong>
      <span aria-hidden="true" className="secure-share-comment-ip-prefix">
        ({ipPrefix})
      </span>
    </span>
  );
}

export function SecureShareOwnerCommentsPanel({
  disabled,
  onLoadComments,
  share
}: {
  disabled: boolean;
  onLoadComments: SecureShareOwnerCommentLoader;
  share: SecureShareOwnerSummary;
}) {
  const titleId = useId();
  const target = useMemo<SecureShareOwnerCommentTarget>(() => ({
    policyVersion: share.policyVersion,
    shareId: share.shareId,
    sourceNoteId: share.sourceNoteId
  }), [share.policyVersion, share.shareId, share.sourceNoteId]);
  const [reloadEpoch, setReloadEpoch] = useState(0);
  const [state, setState] = useState<SecureShareOwnerCommentsState>(() =>
    initialSecureShareOwnerCommentsState(target)
  );
  const activeControllerRef = useRef<AbortController | null>(null);
  const requestGenerationRef = useRef(0);
  const targetRef = useRef(target);
  const onLoadCommentsRef = useRef(onLoadComments);

  useEffect(() => {
    targetRef.current = target;
    onLoadCommentsRef.current = onLoadComments;
  }, [onLoadComments, target]);

  useEffect(() => () => {
    requestGenerationRef.current += 1;
    activeControllerRef.current?.abort();
    activeControllerRef.current = null;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const generation = requestGenerationRef.current + 1;
    requestGenerationRef.current = generation;
    activeControllerRef.current?.abort();
    activeControllerRef.current = controller;
    setState(initialSecureShareOwnerCommentsState(target));

    void (async () => {
      try {
        const page = await onLoadCommentsRef.current(target, null, controller.signal);

        if (
          controller.signal.aborted
          || requestGenerationRef.current !== generation
          || targetRef.current.shareId !== target.shareId
          || targetRef.current.sourceNoteId !== target.sourceNoteId
          || targetRef.current.policyVersion !== target.policyVersion
        ) {
          return;
        }

        setState({
          error: "",
          items: mergeSecureShareComments([], page.items, false),
          loading: false,
          loadingMore: false,
          nextCursor: page.nextCursor,
          policyVersion: target.policyVersion,
          shareId: target.shareId
        });
      } catch {
        if (
          controller.signal.aborted
          || requestGenerationRef.current !== generation
          || targetRef.current.shareId !== target.shareId
          || targetRef.current.policyVersion !== target.policyVersion
        ) {
          return;
        }

        setState({
          error: "댓글을 불러오지 못했습니다. 다시 시도해주세요.",
          items: [],
          loading: false,
          loadingMore: false,
          nextCursor: null,
          policyVersion: target.policyVersion,
          shareId: target.shareId
        });
      } finally {
        if (activeControllerRef.current === controller) {
          activeControllerRef.current = null;
        }
      }
    })();

    return () => {
      controller.abort();
      if (activeControllerRef.current === controller) {
        activeControllerRef.current = null;
      }
    };
  }, [reloadEpoch, target]);

  const currentState = state.shareId === target.shareId
    && state.policyVersion === target.policyVersion
    ? state
    : initialSecureShareOwnerCommentsState(target);

  function refreshComments() {
    activeControllerRef.current?.abort();
    setState(initialSecureShareOwnerCommentsState(target));
    setReloadEpoch((current) => current + 1);
  }

  async function loadMoreComments() {
    if (
      disabled
      || currentState.loading
      || currentState.loadingMore
      || !currentState.nextCursor
    ) {
      return;
    }

    const cursor = currentState.nextCursor;
    const controller = new AbortController();
    const generation = requestGenerationRef.current + 1;
    requestGenerationRef.current = generation;
    activeControllerRef.current?.abort();
    activeControllerRef.current = controller;
    setState((current) => current.shareId === target.shareId
      && current.policyVersion === target.policyVersion
      ? { ...current, error: "", loadingMore: true }
      : initialSecureShareOwnerCommentsState(target));

    try {
      const page = await onLoadCommentsRef.current(target, cursor, controller.signal);

      if (
        controller.signal.aborted
        || requestGenerationRef.current !== generation
        || targetRef.current.shareId !== target.shareId
        || targetRef.current.sourceNoteId !== target.sourceNoteId
        || targetRef.current.policyVersion !== target.policyVersion
      ) {
        return;
      }

      setState((current) => current.shareId === target.shareId
        && current.policyVersion === target.policyVersion
        ? {
            ...current,
            error: "",
            items: mergeSecureShareComments(current.items, page.items, true),
            loading: false,
            loadingMore: false,
            nextCursor: page.nextCursor
          }
        : current);
    } catch {
      if (
        controller.signal.aborted
        || requestGenerationRef.current !== generation
        || targetRef.current.shareId !== target.shareId
        || targetRef.current.policyVersion !== target.policyVersion
      ) {
        return;
      }

      setState((current) => current.shareId === target.shareId
        && current.policyVersion === target.policyVersion
        ? {
            ...current,
            error: "댓글을 더 불러오지 못했습니다. 다시 시도해주세요.",
            loadingMore: false
          }
        : current);
    } finally {
      if (activeControllerRef.current === controller) {
        activeControllerRef.current = null;
      }
    }
  }

  const commentListId = `secure-share-owner-comment-list-${share.shareId}`;
  const requestBusy = currentState.loading || currentState.loadingMore;

  return (
    <section
      aria-busy={requestBusy ? "true" : undefined}
      aria-labelledby={titleId}
      className="secure-share-owner-comments"
    >
      <header>
        <div>
          <h4 id={titleId}>
            <MessageCircle aria-hidden="true" size={16} />
            댓글
          </h4>
          <span>읽기 전용</span>
        </div>
        <button
          aria-controls={commentListId}
          className="secondary-button"
          disabled={disabled || requestBusy}
          onClick={refreshComments}
          type="button"
        >
          <RotateCcw aria-hidden="true" className={currentState.loading ? "spin" : undefined} size={14} />
          새로고침
        </button>
      </header>
      <p className="secure-share-owner-comments-help">
        공유 URL을 열지 않고 소유자 권한으로 확인합니다. 댓글 작성과 삭제는 공유 화면에서만 가능합니다.
      </p>
      {currentState.loading && (
        <p aria-live="polite" className="public-share-status" role="status">
          댓글을 불러오는 중...
        </p>
      )}
      {currentState.error && (
        <p className="form-error" role="alert">{currentState.error}</p>
      )}
      <div className="secure-share-comment-list" id={commentListId}>
        {currentState.items.map((comment) => (
          <article key={comment.id}>
            <header>
              <div>
                <SecureShareOwnerCommentIdentity
                  displayName={comment.displayName}
                  ipPrefix={comment.ipPrefix}
                />
                <span className="secure-share-comment-author-badge">
                  {secureShareCommentBadgeLabel(comment.badge)}
                </span>
              </div>
              <time dateTime={comment.createdAt}>
                {secureShareOwnerCommentDateFormatter.format(new Date(comment.createdAt))}
              </time>
            </header>
            <p>{comment.body}</p>
          </article>
        ))}
        {!currentState.loading
          && !currentState.error
          && currentState.items.length === 0 && (
            <p className="secure-share-owner-comments-empty">아직 댓글이 없습니다.</p>
          )}
      </div>
      {currentState.nextCursor && (
        <button
          aria-controls={commentListId}
          className="secondary-button secure-share-owner-comments-more"
          disabled={disabled || requestBusy}
          onClick={() => void loadMoreComments()}
          type="button"
        >
          {currentState.loadingMore
            ? <Loader2 aria-hidden="true" className="spin" size={14} />
            : <MessageCircle aria-hidden="true" size={14} />}
          {currentState.loadingMore ? "댓글 불러오는 중..." : "댓글 더 보기"}
        </button>
      )}
    </section>
  );
}
