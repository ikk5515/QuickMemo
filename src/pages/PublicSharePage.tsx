import { AlertTriangle, Download, Eye, File, Loader2, LockKeyhole } from "lucide-react";
import {
  lazy,
  Suspense,
  type FormEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ReadonlyNoteRenderer } from "../components/ReadonlyNoteRenderer";
import { useAuth } from "../context/AuthContext";
import {
  attachmentDownloadName,
  formatFileSize,
  isPublicShareRasterImageExtension,
  maxAttachmentPreviewBytes,
  maxAttachmentPreviewLabel,
  publicShareAttachmentMimeMatchesExtension,
  safePublicShareAttachmentMimeType
} from "../lib/attachments";
import {
  decryptAttachmentToBlob,
  decryptAttachmentToBytes
} from "../lib/attachmentCrypto";
import {
  decryptText,
  derivePublicShareContentKey,
  importAesKeyBase64Url,
  verifyPublicSharePassword
} from "../lib/crypto";
import {
  parseReadonlyEditorContent,
  type ReadonlyEditorContentFormat
} from "../lib/editorContent";
import { safeRasterImageBytes } from "../lib/safeRasterImage";
import { resolveSecureShareFeatureFlags } from "../lib/secureSharePolicy";
import {
  createSecureShareLoginReturnState
} from "../lib/shareLoginReturn";
import {
  isSecureShareV2Identifier,
  parseSecureShareContentKeyFragment,
  parseSecureSharePath,
  type SecureShareRouteKind
} from "../lib/secureShareUrl";
import {
  type SecureShareSaveCopyProgress
} from "../lib/secureShareSaveCopy";
import {
  decodeTextAttachmentPreview,
  legacyBinaryPreviewAttachmentExtensions,
  legacyBinaryPreviewMessage,
  previewableAttachmentExtensions,
  textPreviewAttachmentExtensions,
  type PublicAttachmentPreviewState
} from "../lib/publicAttachmentPreview";
import {
  getEncryptedPublicShareAttachmentSource,
  getPublicNoteShareAttachments,
  publicShareActive,
  subscribePublicNoteShare,
  type PublicNoteShareAttachmentSnapshot,
  type PublicNoteShareSnapshot
} from "../services/publicShares";
import {
  getSecureShareFeatureStatus,
  getSecureShareLiveSyncStatus
} from "../services/secureShares";
import type { SecurePublicShareCopyPayload } from "../components/SecurePublicShareViewer";
interface PublicShareAttachmentView {
  id: string;
  downloadName: string;
  extension: string;
  mimeType: string;
  originalSize: number;
  source: PublicNoteShareAttachmentSnapshot;
}

const PublicAttachmentPreviewModal = lazy(() => import("../components/PublicAttachmentPreviewModal"));
const SecurePublicShareViewer = lazy(() =>
  import("../components/SecurePublicShareViewer").then((module) => ({
    default: module.SecurePublicShareViewer
  }))
);
interface PublicShareContent {
  attachments: PublicShareAttachmentView[];
  bodyFormat: ReadonlyEditorContentFormat;
  bodyHtml: string;
  fontSize: number;
  title: string;
}

type SecureShareFeatureGateState = "checking" | "enabled" | "unavailable";

class InvalidLegacyPublicShareRouteError extends Error {
  constructor() {
    super("Invalid legacy public share route");
    this.name = "InvalidLegacyPublicShareRouteError";
  }
}

export function legacyPublicShareLoadError(caught: unknown) {
  return caught instanceof InvalidLegacyPublicShareRouteError
    ? "공유 링크가 올바르지 않습니다."
    : "공유 노트를 열 수 없습니다.";
}

export default function PublicSharePage() {
  const location = useLocation();
  const parsedPath = useMemo(
    () => parseSecureSharePath(location.pathname),
    [location.pathname]
  );

  if (!parsedPath || location.search) {
    return <InvalidPublicShareRoute />;
  }

  return isSecureShareV2Identifier(parsedPath.shareId)
    ? (
        <SecurePublicShareRoute
          key={parsedPath.shareId}
          routeKind={parsedPath.routeKind}
          shareId={parsedPath.shareId}
        />
      )
    : parsedPath.routeKind === "standard"
      ? <LegacyPublicSharePage shareId={parsedPath.shareId} />
      : <InvalidPublicShareRoute />;
}

function SecurePublicShareRoute({
  routeKind,
  shareId
}: {
  routeKind: SecureShareRouteKind;
  shareId: string;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const { firebaseUser, loading: authLoading, privateKey, profile } = useAuth();
  const parsedFragment = useMemo(
    () => parseSecureShareContentKeyFragment(location.hash, routeKind),
    [location.hash, routeKind]
  );
  const [featureGateState, setFeatureGateState] = useState<SecureShareFeatureGateState>("checking");
  const [liveContentSyncEnabled, setLiveContentSyncEnabled] = useState(false);
  const [idTokenState, setIdTokenState] = useState<{ token: string; uid: string } | null>(null);
  const [tokenError, setTokenError] = useState("");
  const [copyProgress, setCopyProgress] = useState<SecureShareSaveCopyProgress | null>(null);
  const [copyResult, setCopyResult] = useState("");
  const [copyError, setCopyError] = useState("");
  const [copyRunning, setCopyRunning] = useState(false);
  const copyAbortControllerRef = useRef<AbortController | null>(null);
  const copyLifecycleGenerationRef = useRef(0);
  const authenticatedProfile = Boolean(
    firebaseUser
    && profile
    && profile.isActive
    && firebaseUser.uid === profile.uid
  );
  const idToken = authenticatedProfile
    && idTokenState
    && idTokenState.uid === firebaseUser?.uid
    ? idTokenState.token
    : undefined;
  const copyLifecycleIdentityRef = useRef({
    authenticatedProfile,
    contentKey: parsedFragment?.contentKey ?? null,
    firebaseUser,
    idToken,
    privateKey,
    profile,
    shareId
  });

  useLayoutEffect(() => {
    copyLifecycleIdentityRef.current = {
      authenticatedProfile,
      contentKey: parsedFragment?.contentKey ?? null,
      firebaseUser,
      idToken,
      privateKey,
      profile,
      shareId
    };
  }, [
    authenticatedProfile,
    firebaseUser,
    idToken,
    parsedFragment?.contentKey,
    privateKey,
    profile,
    shareId
  ]);

  useEffect(() => {
    if (!parsedFragment) {
      return undefined;
    }

    const clientFlags = resolveSecureShareFeatureFlags();

    if (!clientFlags.clientV2Enabled) {
      setLiveContentSyncEnabled(false);
      setFeatureGateState("unavailable");
      return undefined;
    }

    const controller = new AbortController();
    setLiveContentSyncEnabled(false);
    setFeatureGateState("checking");

    void Promise.all([
      getSecureShareFeatureStatus(controller.signal),
      getSecureShareLiveSyncStatus(controller.signal)
        .catch(() => ({ enabled: false }))
    ])
      .then(([serverStatus, liveSyncStatus]) => {
        if (!controller.signal.aborted) {
          const flags = resolveSecureShareFeatureFlags({
            ...serverStatus,
            liveContentSyncEnabled: liveSyncStatus.enabled
          });
          setLiveContentSyncEnabled(flags.liveContentSyncEnabled);
          setFeatureGateState(
            flags.v2Enabled ? "enabled" : "unavailable"
          );
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setLiveContentSyncEnabled(false);
          setFeatureGateState("unavailable");
        }
      });

    return () => controller.abort();
  }, [parsedFragment, shareId]);

  useEffect(() => {
    let active = true;
    const uid = featureGateState === "enabled" && authenticatedProfile
      ? firebaseUser?.uid
      : null;

    setIdTokenState(null);
    setTokenError("");

    if (!uid || !firebaseUser) {
      return () => {
        active = false;
      };
    }

    void firebaseUser.getIdToken()
      .then((token) => {
        if (active && firebaseUser.uid === uid) {
          setIdTokenState({ token, uid });
        }
      })
      .catch(() => {
        if (active) {
          setTokenError("QuickMemo 로그인 토큰을 확인하지 못했습니다.");
        }
      });

    return () => {
      active = false;
    };
  }, [authenticatedProfile, featureGateState, firebaseUser]);

  useLayoutEffect(() => {
    const generation = copyLifecycleGenerationRef.current + 1;
    copyLifecycleGenerationRef.current = generation;
    copyAbortControllerRef.current?.abort();
    copyAbortControllerRef.current = null;
    setCopyProgress(null);
    setCopyResult("");
    setCopyError("");
    setCopyRunning(false);

    return () => {
      if (copyLifecycleGenerationRef.current === generation) {
        copyLifecycleGenerationRef.current += 1;
      }
      copyAbortControllerRef.current?.abort();
      copyAbortControllerRef.current = null;
    };
  }, [
    authenticatedProfile,
    firebaseUser,
    idToken,
    parsedFragment?.contentKey,
    privateKey,
    profile,
    shareId
  ]);

  const requireLogin = useCallback(() => {
    const returnState = createSecureShareLoginReturnState(
      location.pathname,
      location.hash
    );

    if (!returnState) {
      setCopyError("로그인 후 돌아올 보안 공유 주소를 확인하지 못했습니다.");
      return;
    }

    navigate("/login", {
      state: returnState
    });
  }, [location.hash, location.pathname, navigate]);

  const saveCopy = useCallback(async (payload: SecurePublicShareCopyPayload) => {
    const operationGeneration = copyLifecycleGenerationRef.current;
    const operationIsCurrent = () => {
      const current = copyLifecycleIdentityRef.current;

      return operationGeneration === copyLifecycleGenerationRef.current
        && current.authenticatedProfile === authenticatedProfile
        && current.contentKey === (parsedFragment?.contentKey ?? null)
        && current.firebaseUser === firebaseUser
        && current.idToken === idToken
        && current.privateKey === privateKey
        && current.profile === profile
        && current.shareId === shareId;
    };

    if (!operationIsCurrent()) {
      throw new Error("로그인 상태가 변경되어 복사본 저장을 중단했습니다.");
    }
    if (copyAbortControllerRef.current) {
      const message = "이미 복사본 저장 작업이 진행 중입니다.";
      setCopyError(message);
      throw new Error(message);
    }
    if (
      !firebaseUser
      || !profile
      || !privateKey
      || !idToken
      || firebaseUser.uid !== profile.uid
      || !authenticatedProfile
    ) {
      const message = "활성 QuickMemo 노트 권한과 암호화 키를 확인해주세요.";
      setCopyError(message);
      throw new Error(message);
    }

    const controller = new AbortController();
    copyAbortControllerRef.current = controller;
    setCopyRunning(true);
    setCopyError("");
    setCopyResult("");
    setCopyProgress({
      fileCount: payload.attachments.length,
      fileIndex: 0,
      fileName: "",
      loadedBytes: 0,
      percent: 0,
      phase: "preparing",
      totalBytes: 0
    });

    try {
      const { saveSecureShareCopy } = await import("../lib/secureShareSaveCopy");
      if (!operationIsCurrent()) {
        controller.abort();
        throw new Error("로그인 상태가 변경되어 복사본 저장을 중단했습니다.");
      }
      await saveSecureShareCopy({
        payload,
        privateKey,
        profile,
        signal: controller.signal,
        onProgress: (progress) => {
          if (operationIsCurrent()) {
            setCopyProgress(progress);
          }
        }
      });
      if (!operationIsCurrent()) {
        return;
      }
      setCopyResult("보안 공유의 독립 복사본을 QuickMemo에 저장했습니다.");
    } catch (caught) {
      if (!operationIsCurrent()) {
        throw caught;
      }
      const message = caught instanceof Error && caught.name === "SecureShareSaveCopyError"
        ? caught.message
        : "복사본 저장 중 오류가 발생했습니다.";
      setCopyProgress(null);
      setCopyResult("");
      setCopyError(message);
      throw caught;
    } finally {
      if (copyAbortControllerRef.current === controller) {
        copyAbortControllerRef.current = null;
      }
      if (operationIsCurrent()) {
        setCopyRunning(false);
      }
    }
  }, [
    authenticatedProfile,
    firebaseUser,
    idToken,
    parsedFragment?.contentKey,
    privateKey,
    profile,
    shareId
  ]);

  if (!parsedFragment) {
    return <InvalidPublicShareRoute />;
  }

  if (featureGateState === "checking") {
    return (
      <main className="public-share-page">
        <section className="secure-public-share-state" aria-live="polite">
          <Loader2 aria-hidden="true" className="spin" size={24} />
          <h1>보안 공유를 확인하는 중</h1>
          <p>잠시만 기다려주세요.</p>
        </section>
      </main>
    );
  }

  if (featureGateState === "unavailable") {
    return <SecureShareUnavailableState />;
  }

  if (
    authLoading
    || (authenticatedProfile && !idToken && !tokenError)
  ) {
    return (
      <main className="public-share-page">
        <section className="secure-public-share-state" aria-live="polite">
          <Loader2 aria-hidden="true" className="spin" size={24} />
          <h1>보안 공유 로그인 상태 확인 중</h1>
          <p>잠시만 기다려주세요.</p>
        </section>
      </main>
    );
  }

  return (
    <main className="public-share-page">
      {tokenError && <p className="secure-public-share-error" role="alert">{tokenError}</p>}
      {(copyProgress || copyResult || copyError) && (
        <section className="secure-public-share-viewer" aria-live="polite">
          {copyProgress && copyProgress.phase !== "complete" && (
            <>
              <strong>{secureShareCopyProgressLabel(copyProgress)}</strong>
              {copyProgress.totalBytes > 0 && (
                <progress
                  aria-label="복사본 저장 진행률"
                  max={100}
                  value={Math.min(100, Math.max(0, copyProgress.percent))}
                />
              )}
              {copyRunning && copyProgress.phase !== "cleaning_up" && (
                <button
                  className="secondary-button danger"
                  onClick={() => {
                    copyAbortControllerRef.current?.abort();
                    setCopyResult("취소 요청을 처리하고 생성된 데이터를 정리하는 중입니다.");
                    setCopyProgress((current) =>
                      current ? { ...current, phase: "cleaning_up", percent: 0 } : current
                    );
                  }}
                  type="button"
                >
                  복사본 저장 취소
                </button>
              )}
            </>
          )}
          {copyResult && <p className="secure-public-share-notice" role="status">{copyResult}</p>}
          {copyError && <p className="secure-public-share-error" role="alert">{copyError}</p>}
        </section>
      )}
      <Suspense fallback={<section className="secure-public-share-state">보안 공유 화면을 불러오는 중...</section>}>
        <SecurePublicShareViewer
          contentKey={parsedFragment.contentKey}
          idToken={idToken}
          isAuthenticated={Boolean(authenticatedProfile && idToken)}
          liveContentSyncEnabled={liveContentSyncEnabled}
          onRequireLogin={requireLogin}
          onSaveCopy={saveCopy}
          shareId={shareId}
        />
      </Suspense>
    </main>
  );
}

function SecureShareUnavailableState() {
  return (
    <main className="public-share-page">
      <section className="secure-public-share-state error" role="alert">
        <AlertTriangle aria-hidden="true" size={28} />
        <h1>보안 공유를 사용할 수 없습니다.</h1>
        <p>링크가 만료되었거나 현재 사용할 수 없습니다.</p>
      </section>
    </main>
  );
}

function InvalidPublicShareRoute() {
  return (
    <main className="public-share-page">
      <section className="secure-public-share-state error" role="alert">
        <AlertTriangle aria-hidden="true" size={28} />
        <h1>보안 공유 링크가 올바르지 않습니다.</h1>
        <p>전달받은 주소 전체를 다시 확인해주세요.</p>
      </section>
    </main>
  );
}

function secureShareCopyProgressLabel(progress: SecureShareSaveCopyProgress) {
  if (progress.phase === "preparing") {
    return "복사본 저장을 준비하는 중입니다.";
  }
  if (progress.phase === "creating_note") {
    return "암호화된 새 노트를 만드는 중입니다.";
  }
  if (progress.phase === "activating") {
    return "첨부파일을 확인하고 새 노트를 활성화하는 중입니다.";
  }
  if (progress.phase === "cleaning_up") {
    return "생성된 일부 데이터를 안전하게 정리하는 중입니다.";
  }
  if (progress.phase === "complete") {
    return "복사본 저장을 완료했습니다.";
  }

  const fileLabel = progress.fileCount > 0
    ? `파일 ${progress.fileIndex}/${progress.fileCount} · ${progress.fileName}`
    : "";
  const phaseLabel = progress.phase === "downloading"
    ? "복사 권한으로 가져오는 중"
    : progress.phase === "encrypting"
      ? "새 노트 키로 암호화 중"
      : "암호화된 첨부파일 업로드 중";

  return `${fileLabel} · ${phaseLabel}`;
}

function LegacyPublicSharePage({ shareId }: { shareId: string }) {
  const [title, setTitle] = useState("");
  const [bodyFormat, setBodyFormat] = useState<ReadonlyEditorContentFormat>("html");
  const [bodyHtml, setBodyHtml] = useState("");
  const [fontSize, setFontSize] = useState(17);
  const [attachments, setAttachments] = useState<PublicShareAttachmentView[]>([]);
  const [share, setShare] = useState<PublicNoteShareSnapshot | null>(null);
  const [shareKeyValue, setShareKeyValue] = useState<string | null>(null);
  const [attachmentPreview, setAttachmentPreview] = useState<PublicAttachmentPreviewState | null>(null);
  const [attachmentAction, setAttachmentAction] = useState<{ id: string; kind: "download" | "preview" } | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [passwordRequired, setPasswordRequired] = useState(false);
  const [passwordInput, setPasswordInput] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const objectUrlsRef = useRef(new Set<string>());
  const downloadObjectUrlsRef = useRef(new Set<string>());
  const downloadCleanupTimersRef = useRef(new Set<number>());
  const contentKeyRef = useRef<CryptoKey | null>(null);
  const passwordSignatureRef = useRef<string | null>(null);
  const attachmentActionGenerationRef = useRef(0);
  const passwordUnlockGenerationRef = useRef(0);

  const revokeAttachmentUrls = useCallback(() => {
    objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    objectUrlsRef.current.clear();
  }, []);

  const revokeDownloadUrls = useCallback(() => {
    downloadCleanupTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
    downloadCleanupTimersRef.current.clear();
    downloadObjectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    downloadObjectUrlsRef.current.clear();
  }, []);

  const applyShareContent = useCallback((content: PublicShareContent) => {
    attachmentActionGenerationRef.current += 1;
    revokeAttachmentUrls();
    revokeDownloadUrls();
    setTitle(content.title);
    setBodyFormat(content.bodyFormat);
    setBodyHtml(content.bodyHtml);
    setFontSize(content.fontSize);
    setAttachments(content.attachments);
    setAttachmentError(null);
    setPasswordRequired(false);
  }, [revokeAttachmentUrls, revokeDownloadUrls]);

  const clearShareContent = useCallback(() => {
    attachmentActionGenerationRef.current += 1;
    passwordUnlockGenerationRef.current += 1;
    revokeAttachmentUrls();
    revokeDownloadUrls();
    setTitle("");
    setBodyFormat("html");
    setBodyHtml("");
    setAttachments([]);
    setAttachmentPreview(null);
    setAttachmentAction(null);
    setAttachmentError(null);
  }, [revokeAttachmentUrls, revokeDownloadUrls]);

  useEffect(() => {
    let active = true;
    let updateVersion = 0;

    async function applyShareUpdate(nextShare: PublicNoteShareSnapshot, nextShareKeyValue: string, shareKey: CryptoKey) {
      const currentVersion = (updateVersion += 1);
      passwordUnlockGenerationRef.current += 1;
      setUnlocking(false);

      if (!publicShareActive(nextShare)) {
        throw new Error("공유 링크가 만료되었거나 중단되었습니다.");
      }

      setShare(nextShare);
      setShareKeyValue(nextShareKeyValue);

      if (nextShare.passwordHash) {
        const nextSignature = publicSharePasswordSignature(nextShare);

        if (!contentKeyRef.current || passwordSignatureRef.current !== nextSignature) {
          contentKeyRef.current = null;
          passwordSignatureRef.current = null;
          clearShareContent();
          setPasswordRequired(true);
          return;
        }
      } else {
        contentKeyRef.current = shareKey;
        passwordSignatureRef.current = null;
      }

      const contentKey = contentKeyRef.current ?? shareKey;
      const content = await decryptPublicShareContent(shareId ?? "", nextShare, contentKey);

      if (!active || currentVersion !== updateVersion) {
        return;
      }

      applyShareContent(content);
    }

    async function loadShare() {
      setLoading(true);
      passwordUnlockGenerationRef.current += 1;
      setError(null);
      setPasswordRequired(false);
      setPasswordInput("");
      setPasswordError(null);
      setAttachments([]);
      setShare(null);
      setShareKeyValue(null);
      contentKeyRef.current = null;
      passwordSignatureRef.current = null;
      setTitle("");
      setBodyHtml("");
      revokeAttachmentUrls();
      revokeDownloadUrls();

      try {
        const shareKeyValue = shareKeyFromHash();

        if (!shareId || !shareKeyValue) {
          throw new InvalidLegacyPublicShareRouteError();
        }

        const shareKey = await importAesKeyBase64Url(shareKeyValue);

        return subscribePublicNoteShare(
          shareId,
          (nextShare) => {
            if (!nextShare) {
              updateVersion += 1;
              clearShareContent();
              setShare(null);
              setShareKeyValue(null);
              contentKeyRef.current = null;
              passwordSignatureRef.current = null;
              setError("공유 링크가 만료되었거나 중단되었습니다.");
              setLoading(false);
              return;
            }

            void applyShareUpdate(nextShare, shareKeyValue, shareKey)
              .then(() => {
                if (active) {
                  setError(null);
                  setLoading(false);
                }
              })
              .catch(() => {
                if (active) {
                  clearShareContent();
                  setError("공유 노트를 열 수 없습니다.");
                  setLoading(false);
                }
              });
          },
          () => {
            if (active) {
              updateVersion += 1;
              clearShareContent();
              setShare(null);
              setShareKeyValue(null);
              contentKeyRef.current = null;
              passwordSignatureRef.current = null;
              setError("공유 링크 상태를 불러오지 못했습니다.");
              setLoading(false);
            }
          }
        );
      } catch (loadError) {
        if (active) {
          updateVersion += 1;
          clearShareContent();
          setShare(null);
          setShareKeyValue(null);
          contentKeyRef.current = null;
          passwordSignatureRef.current = null;
          setError(legacyPublicShareLoadError(loadError));
          setLoading(false);
        }
      }
    }

    let unsubscribe: (() => void) | undefined;
    void loadShare().then((nextUnsubscribe) => {
      if (!active) {
        nextUnsubscribe?.();
        return;
      }

      unsubscribe = nextUnsubscribe;
    });

    return () => {
      active = false;
      updateVersion += 1;
      attachmentActionGenerationRef.current += 1;
      passwordUnlockGenerationRef.current += 1;
      unsubscribe?.();
      revokeAttachmentUrls();
      revokeDownloadUrls();
      contentKeyRef.current = null;
      passwordSignatureRef.current = null;
    };
  }, [applyShareContent, clearShareContent, revokeAttachmentUrls, revokeDownloadUrls, shareId]);

  async function handlePasswordSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!shareId || !share || !shareKeyValue || !share.passwordHash) {
      setPasswordError("공유 링크를 다시 열어주세요.");
      return;
    }

    const unlockGeneration = passwordUnlockGenerationRef.current + 1;
    passwordUnlockGenerationRef.current = unlockGeneration;
    setUnlocking(true);
    setPasswordError(null);

    try {
      const trimmedPassword = passwordInput.trim();
      const unlocked = await verifyPublicSharePassword(trimmedPassword, share.passwordHash, shareKeyValue);

      if (passwordUnlockGenerationRef.current !== unlockGeneration) {
        return;
      }

      if (!unlocked) {
        setPasswordError("비밀번호가 올바르지 않습니다.");
        return;
      }

      const contentKey = await derivePublicShareContentKey(shareKeyValue, trimmedPassword, share.passwordHash);

      if (passwordUnlockGenerationRef.current !== unlockGeneration) {
        return;
      }

      contentKeyRef.current = contentKey;
      passwordSignatureRef.current = publicSharePasswordSignature(share);
      const content = await decryptPublicShareContent(shareId, share, contentKey);

      if (passwordUnlockGenerationRef.current !== unlockGeneration) {
        return;
      }

      applyShareContent(content);
      setPasswordInput("");
    } catch {
      if (passwordUnlockGenerationRef.current === unlockGeneration) {
        setPasswordError("공유 노트를 여는 중 문제가 발생했습니다.");
      }
    } finally {
      if (passwordUnlockGenerationRef.current === unlockGeneration) {
        setUnlocking(false);
      }
    }
  }

  function previewObjectUrl(bytes: Uint8Array, type: string) {
    const blobPart =
      bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes.buffer
        : (() => {
            const copy = new Uint8Array(bytes.byteLength);
            copy.set(bytes);
            return copy.buffer;
          })();
    const url = URL.createObjectURL(new Blob([blobPart], { type }));

    objectUrlsRef.current.add(url);
    return url;
  }

  function closeAttachmentPreview() {
    attachmentActionGenerationRef.current += 1;
    setAttachmentPreview(null);
    setAttachmentAction((current) => (current?.kind === "preview" ? null : current));
    revokeAttachmentUrls();
  }

  async function decryptAttachmentBlobForAction(attachment: PublicShareAttachmentView) {
    const contentKey = contentKeyRef.current;

    if (!contentKey) {
      throw new Error("공유 첨부파일 복호화 키를 찾을 수 없습니다.");
    }

    return decryptPublicAttachmentBlob(attachment.source, contentKey);
  }

  async function decryptAttachmentBytesForAction(attachment: PublicShareAttachmentView) {
    const contentKey = contentKeyRef.current;

    if (!contentKey) {
      throw new Error("공유 첨부파일 복호화 키를 찾을 수 없습니다.");
    }

    return decryptPublicAttachmentBytes(attachment.source, contentKey);
  }

  async function downloadAttachment(attachment: PublicShareAttachmentView) {
    const actionGeneration = attachmentActionGenerationRef.current + 1;
    attachmentActionGenerationRef.current = actionGeneration;
    setAttachmentAction({ id: attachment.id, kind: "download" });
    setAttachmentError(null);

    try {
      const blob = await decryptAttachmentBlobForAction(attachment);

      if (attachmentActionGenerationRef.current !== actionGeneration) {
        return;
      }

      const url = URL.createObjectURL(blob);
      downloadObjectUrlsRef.current.add(url);
      const cleanupTimer = window.setTimeout(() => {
        downloadCleanupTimersRef.current.delete(cleanupTimer);

        if (downloadObjectUrlsRef.current.delete(url)) {
          URL.revokeObjectURL(url);
        }
      }, 1000);
      downloadCleanupTimersRef.current.add(cleanupTimer);
      const anchor = document.createElement("a");

      anchor.href = url;
      anchor.download = attachment.downloadName;
      anchor.rel = "noopener noreferrer";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch {
      if (attachmentActionGenerationRef.current === actionGeneration) {
        setAttachmentError("첨부파일을 다운로드하지 못했습니다.");
      }
    } finally {
      if (attachmentActionGenerationRef.current === actionGeneration) {
        setAttachmentAction((current) => (current?.id === attachment.id && current.kind === "download" ? null : current));
      }
    }
  }

  async function openAttachmentPreview(attachment: PublicShareAttachmentView) {
    const fileName = attachment.downloadName;
    const extension = attachment.extension.toLowerCase();
    const actionGeneration = attachmentActionGenerationRef.current + 1;
    attachmentActionGenerationRef.current = actionGeneration;

    setAttachmentAction({ id: attachment.id, kind: "preview" });
    setAttachmentError(null);
    revokeAttachmentUrls();

    try {
      if (attachment.originalSize > maxAttachmentPreviewBytes) {
        setAttachmentPreview({
          fileName,
          kind: "unsupported",
          label: "대용량 파일 미리보기 안내",
          text: `미리보기는 ${maxAttachmentPreviewLabel} 이하 파일만 지원합니다. 원본 파일은 다운로드해서 확인해주세요.`
        });
        return;
      }

      const bytes = await decryptAttachmentBytesForAction(attachment);

      if (attachmentActionGenerationRef.current !== actionGeneration) {
        return;
      }

      if (isImageAttachment(attachment)) {
        const imageMimeType = safePublicShareAttachmentMimeType(extension);

        if (!safeRasterImageBytes(bytes, imageMimeType)) {
          setAttachmentPreview({
            fileName,
            kind: "unsupported",
            label: "안전한 이미지 미리보기 안내",
            text: extension === "gif"
              ? "움직이는 GIF는 과도한 CPU·메모리 사용을 막기 위해 미리보기를 제공하지 않습니다. 다운로드해서 확인해주세요."
              : "이미지 크기나 형식이 안전 제한을 벗어나 미리보기를 제공하지 않습니다. 다운로드해서 확인해주세요.",
            url: previewObjectUrl(bytes, "application/octet-stream")
          });
          return;
        }

        const imageUrl = previewObjectUrl(bytes, imageMimeType);

        setAttachmentPreview({
          fileName,
          kind: "image",
          label: "이미지 미리보기",
          url: imageUrl
        });
        return;
      }

      const downloadUrl = previewObjectUrl(bytes, "application/octet-stream");

      if (!previewableAttachmentExtensions.has(extension)) {
        setAttachmentPreview({
          fileName,
          kind: "unsupported",
          label: "미리보기",
          text: "이 파일 형식은 브라우저 미리보기를 지원하지 않습니다. 다운로드해서 확인해주세요.",
          url: downloadUrl
        });
        return;
      }

      if (extension === "pdf") {
        setAttachmentPreview({ bytes, fileName, kind: "pdf", label: "PDF 미리보기", url: downloadUrl });
        return;
      }

      if (extension === "docx") {
        const { renderSafeDocxPreviewSrcDoc } = await import("../lib/documentPreview");
        const srcDoc = await renderSafeDocxPreviewSrcDoc(bytes);

        if (attachmentActionGenerationRef.current !== actionGeneration) {
          return;
        }

        setAttachmentPreview(
          srcDoc
            ? { fileName, kind: "docx", label: "DOCX 양식 미리보기", srcDoc, url: downloadUrl }
            : {
                fileName,
                kind: "unsupported",
                label: "DOCX 미리보기 안내",
                text: "DOCX 양식 미리보기를 안전하게 만들지 못했습니다. 원본 파일은 다운로드해서 확인해주세요.",
                url: downloadUrl
              }
        );
        return;
      }

      if (extension === "hwp") {
        const { extractHwpPreviewHtml } = await import("../lib/documentPreview");
        const preview = await extractHwpPreviewHtml(bytes);

        if (attachmentActionGenerationRef.current !== actionGeneration) {
          return;
        }

        setAttachmentPreview(
          preview.html
            ? {
                fileName,
                html: preview.html,
                kind: "html",
                label: "HWP 안전 본문 미리보기",
                url: downloadUrl
              }
              : {
                  fileName,
                  kind: "unsupported",
                  label: "HWP 미리보기 안내",
                  text: "HWP 미리보기가 안전 제한을 초과했거나 지원하지 않는 문서입니다. 원본 파일은 다운로드해서 확인해주세요.",
                  url: downloadUrl
                }
        );
        return;
      }

      if (extension === "hwpx") {
        const { extractHwpxPreviewHtml } = await import("../lib/documentPreview");
        const html = extractHwpxPreviewHtml(bytes);

        if (attachmentActionGenerationRef.current !== actionGeneration) {
          return;
        }

        setAttachmentPreview({
          fileName,
          html,
          kind: html ? "html" : "unsupported",
          label: "HWPX 문서 미리보기",
          text: html ? undefined : "HWPX 문서에서 안전하게 표시할 본문을 찾지 못했습니다.",
          url: downloadUrl
        });
        return;
      }

      if (extension === "xlsx") {
        const { extractXlsxPreviewHtml } = await import("../lib/documentPreview");
        const html = extractXlsxPreviewHtml(bytes);

        if (attachmentActionGenerationRef.current !== actionGeneration) {
          return;
        }

        setAttachmentPreview({
          fileName,
          html,
          kind: html ? "html" : "unsupported",
          label: "XLSX 스프레드시트 미리보기",
          text: html ? undefined : "XLSX 파일에서 안전하게 표시할 시트 내용을 찾지 못했습니다.",
          url: downloadUrl
        });
        return;
      }

      if (textPreviewAttachmentExtensions.has(extension)) {
        setAttachmentPreview({
          fileName,
          kind: "text",
          label: `${extension.toUpperCase()} 미리보기`,
          text: decodeTextAttachmentPreview(bytes, extension),
          url: downloadUrl
        });
        return;
      }

      if (legacyBinaryPreviewAttachmentExtensions.has(extension)) {
        setAttachmentPreview({
          fileName,
          kind: "unsupported",
          label: `${extension.toUpperCase()} 미리보기 안내`,
          text: legacyBinaryPreviewMessage(extension),
          url: downloadUrl
        });
      }
    } catch {
      if (attachmentActionGenerationRef.current === actionGeneration) {
        revokeAttachmentUrls();
        setAttachmentPreview(null);
        setAttachmentError("첨부파일 미리보기를 열지 못했습니다.");
      }
    } finally {
      if (attachmentActionGenerationRef.current === actionGeneration) {
        setAttachmentAction((current) => (current?.id === attachment.id && current.kind === "preview" ? null : current));
      }
    }
  }

  return (
    <main className="public-share-page">
      <section className="public-share-document">
        {loading ? (
          <div className="public-share-state">
            <Loader2 className="spin" size={28} />
            공유 노트를 여는 중...
          </div>
        ) : error ? (
          <div className="public-share-state error">
            <AlertTriangle size={30} />
            <h1>공유 노트를 열 수 없습니다</h1>
            <p>{error}</p>
          </div>
        ) : passwordRequired ? (
          <form className="public-share-state public-share-password-state" onSubmit={handlePasswordSubmit}>
            <LockKeyhole size={30} />
            <h1>비밀번호가 필요합니다</h1>
            <label>
              <span>비밀번호</span>
              <input
                autoComplete="current-password"
                autoFocus
                onChange={(event) => setPasswordInput(event.target.value)}
                placeholder="공유 비밀번호"
                type="password"
                value={passwordInput}
              />
            </label>
            <button disabled={unlocking || !passwordInput.trim()} type="submit">
              {unlocking ? <Loader2 className="spin" size={16} /> : <LockKeyhole size={16} />}
              확인
            </button>
            {passwordError && <p className="form-error">{passwordError}</p>}
          </form>
        ) : (
          <>
            <header className="public-share-header">
              <h1>{title}</h1>
            </header>
            <ReadonlyNoteRenderer
              as="article"
              className="note-preview-body public-share-body"
              content={bodyHtml}
              contentFormat={bodyFormat}
              fontSize={fontSize}
            />
            {attachments.length > 0 && (
              <section className="public-share-attachments" aria-label="공유 첨부파일">
                <h2>
                  <File size={17} />
                  첨부파일
                </h2>
                {attachmentError && <p className="form-error">{attachmentError}</p>}
                <div className="public-share-attachment-list">
                  {attachments.map((attachment) => (
                    <article className="public-share-attachment" key={attachment.id}>
                      <span className="public-share-file-icon">
                        <File size={18} />
                      </span>
                      <div>
                        <strong>{attachment.downloadName}</strong>
                        <span>
                          {attachment.extension.toUpperCase()} · {formatFileSize(attachment.originalSize)}
                        </span>
                      </div>
                      <div className="public-share-attachment-actions">
                        <button
                          className="secondary-button public-share-download"
                          disabled={attachmentAction?.id === attachment.id && attachmentAction.kind === "preview"}
                          type="button"
                          onClick={() => void openAttachmentPreview(attachment)}
                        >
                          {attachmentAction?.id === attachment.id && attachmentAction.kind === "preview" ? (
                            <Loader2 className="spin" size={15} />
                          ) : (
                            <Eye size={15} />
                          )}
                          미리보기
                        </button>
                        <button
                          className="secondary-button public-share-download"
                          disabled={attachmentAction?.id === attachment.id && attachmentAction.kind === "download"}
                          type="button"
                          onClick={() => void downloadAttachment(attachment)}
                        >
                          {attachmentAction?.id === attachment.id && attachmentAction.kind === "download" ? (
                            <Loader2 className="spin" size={15} />
                          ) : (
                            <Download size={15} />
                          )}
                          다운로드
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </section>
      {attachmentPreview && (
        <Suspense fallback={<p className="pdf-preview-status" role="status">미리보기 도구를 불러오는 중...</p>}>
          <PublicAttachmentPreviewModal preview={attachmentPreview} onClose={closeAttachmentPreview} />
        </Suspense>
      )}
    </main>
  );
}

async function decryptPublicAttachmentBytes(attachment: PublicNoteShareAttachmentSnapshot, shareKey: CryptoKey) {
  return decryptAttachmentToBytes(attachment, shareKey, await getEncryptedPublicShareAttachmentSource(attachment));
}

async function decryptPublicAttachmentBlob(attachment: PublicNoteShareAttachmentSnapshot, shareKey: CryptoKey) {
  return decryptAttachmentToBlob(attachment, shareKey, await getEncryptedPublicShareAttachmentSource(attachment));
}

async function publicShareAttachmentView(attachment: PublicNoteShareAttachmentSnapshot, contentKey: CryptoKey) {
  if (attachment.privacyVersion !== 1 || !attachment.encryptedFileName) {
    return null;
  }

  const extension = attachment.extension.toLowerCase();
  const mimeType = attachment.mimeType.trim().toLowerCase();
  let fileName = attachment.fileName;

  if (attachment.encryptedFileName) {
    try {
      const decryptedFileName = await decryptText(attachment.encryptedFileName, contentKey);
      const extensionSuffix = `.${extension}`;

      fileName = decryptedFileName.toLowerCase().endsWith(extensionSuffix)
        ? decryptedFileName.slice(0, -extensionSuffix.length)
        : decryptedFileName;
    } catch {
      fileName = attachment.fileName;
    }
  }

  return {
    id: attachment.id,
    downloadName: attachmentDownloadName({ fileName, extension }),
    extension,
    mimeType,
    originalSize: attachment.originalSize,
    source: attachment
  } satisfies PublicShareAttachmentView;
}

async function decryptPublicShareContent(shareId: string, share: PublicNoteShareSnapshot, shareKey: CryptoKey): Promise<PublicShareContent> {
  const [decryptedTitle, decryptedBody, encryptedAttachments] = await Promise.all([
    decryptText(share.encryptedTitle, shareKey),
    decryptText(share.encryptedBody, shareKey),
    getPublicNoteShareAttachments(shareId, share.currentGeneration)
  ]);
  const readonlyBody = parseReadonlyEditorContent(decryptedBody);
  const attachments: PublicShareAttachmentView[] = [];

  for (const attachment of encryptedAttachments) {
    const attachmentView = await publicShareAttachmentView(attachment, shareKey);

    if (attachmentView) {
      attachments.push(attachmentView);
    }
  }

  return {
    title: decryptedTitle || "제목 없음",
    bodyFormat: readonlyBody.contentFormat,
    bodyHtml: readonlyBody.content,
    fontSize: readonlyBody.fontSize,
    attachments
  };
}

function shareKeyFromHash() {
  return parseSecureShareContentKeyFragment(window.location.hash, "standard")?.contentKey ?? null;
}

function isImageAttachment(attachment: PublicShareAttachmentView) {
  return isPublicShareRasterImageExtension(attachment.extension)
    && publicShareAttachmentMimeMatchesExtension(attachment.extension, attachment.mimeType);
}

function publicSharePasswordSignature(share: PublicNoteShareSnapshot) {
  return share.passwordHash
    ? `${share.passwordHash.version}:${share.passwordHash.algorithm}:${share.passwordHash.iterations}:${share.passwordHash.salt}:${share.passwordHash.hash}`
    : null;
}
