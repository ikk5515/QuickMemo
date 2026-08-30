import {
  Copy,
  Link2,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Users,
  X
} from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject
} from "react";
import {
  SecureShareSettingsModal,
  SecureShareSettingsSaveError
} from "../../components/SecureShareSettingsModal";
import {
  SecureShareOwnerCommentsPanel,
  type SecureShareOwnerCommentTarget
} from "../../components/SecureShareOwnerCommentsPanel";
import { hasFeatureAccess } from "../../lib/featureAccess";
import {
  parseSecureShareCommentsResponse,
  type SecureShareCommentsPage
} from "../../lib/secureShareComments";
import type { SecureSharePolicyInput } from "../../lib/secureSharePolicy";
import { parseSecureShareUrl } from "../../lib/secureShareUrl";
import { useModalFocus } from "../../lib/useModalFocus";
import {
  getSecureShareFeatureStatus,
  getSecureShareOwnerDetails,
  listSecureShareComments,
  listOwnedSecureShares,
  revokeSecureShare,
  SecureShareApiError,
  updateSecureShare,
  type SecureShareFeatureStatus,
  type SecureShareListOptions
} from "../../services/secureShares";
import type { SecureShareOwnerSummary, UserProfile } from "../../types";
import type { DecryptedVaultNote } from "./vaultData";
import {
  createVaultSecureShare,
  parseVaultSecureShareList,
  parseVaultSecureShareMutation,
  parseVaultSecureShareOwnerDetails,
  parseVaultSecureShareSummary,
  recoverVaultSecureShareUrl,
  vaultSecureShareBlocksCreation
} from "./vaultSecureShare";
import "./VaultShareManagerDialog.css";

type ShareManagerTab = "link" | "participants";
type ShareManagerPhase = "checking" | "denied" | "error" | "ready" | "unavailable";
type ShareManagerOperation = "checking" | "copying" | "creating" | "editing" | "revoking" | null;

interface VaultShareCreationInput {
  emailFeatureEnabled: boolean;
  idToken: string;
  note: DecryptedVaultNote;
  origin: string;
  policy: SecureSharePolicyInput;
  privateKey: CryptoKey;
  profile: UserProfile;
}

interface VaultShareSecretResult {
  contentKey: string;
  share: SecureShareOwnerSummary;
  url: string;
}

export interface VaultShareManagerDependencies {
  createShare: (input: VaultShareCreationInput) => Promise<VaultShareSecretResult>;
  getFeatureStatus: (signal?: AbortSignal) => Promise<unknown>;
  getShareDetails: (shareId: string, idToken: string) => Promise<unknown>;
  listComments: (
    shareId: string,
    options: {
      cursor?: string;
      idToken: string;
      limit: number;
      signal: AbortSignal;
    }
  ) => Promise<unknown>;
  listShares: (idToken: string, options?: SecureShareListOptions) => Promise<unknown>;
  recoverShareUrl: (input: {
    idToken: string;
    origin: string;
    privateKey: CryptoKey;
    share: SecureShareOwnerSummary;
  }) => Promise<VaultShareSecretResult>;
  revokeShare: (shareId: string, idToken: string, idempotencyKey: string) => Promise<unknown>;
  updateShare: (
    shareId: string,
    input: { idempotencyKey: string; policy: SecureSharePolicyInput },
    idToken: string,
    options: { emailFeatureEnabled: boolean; now: Date }
  ) => Promise<unknown>;
}

const defaultDependencies: VaultShareManagerDependencies = {
  createShare: (input) => createVaultSecureShare(input),
  getFeatureStatus: getSecureShareFeatureStatus,
  getShareDetails: getSecureShareOwnerDetails,
  listComments: listSecureShareComments,
  listShares: listOwnedSecureShares,
  recoverShareUrl: recoverVaultSecureShareUrl,
  revokeShare: revokeSecureShare,
  updateShare: updateSecureShare
};

class VaultShareManagerContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultShareManagerContractError";
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseFeatureStatus(value: unknown): SecureShareFeatureStatus {
  if (
    !isPlainRecord(value)
    || Object.keys(value).some((key) => key !== "emailEnabled" && key !== "v2Enabled")
    || typeof value.emailEnabled !== "boolean"
    || typeof value.v2Enabled !== "boolean"
  ) {
    throw new VaultShareManagerContractError("보안 공유 기능 상태를 안전하게 확인하지 못했습니다.");
  }
  return {
    emailEnabled: value.emailEnabled,
    v2Enabled: value.v2Enabled
  };
}

function parseIdToken(value: unknown) {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 16_384
    || Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    throw new VaultShareManagerContractError("로그인 권한을 안전하게 확인하지 못했습니다.");
  }
  return value;
}

function normalizedShareOrigin(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new VaultShareManagerContractError("보안 공유 주소 기준을 확인하지 못했습니다.");
  }
  if (
    !new Set(["http:", "https:"]).has(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw new VaultShareManagerContractError("보안 공유 주소 기준을 확인하지 못했습니다.");
  }
  return parsed.origin;
}

function parseSecretResult(
  value: VaultShareSecretResult,
  expectedSourceNoteId: string,
  expectedOrigin: string
) {
  const share = parseVaultSecureShareSummary(value.share);
  const parsedUrl = parseSecureShareUrl(value.url, expectedOrigin);
  if (
    share.sourceNoteId !== expectedSourceNoteId
    || !parsedUrl
    || parsedUrl.shareId !== share.shareId
    || parsedUrl.contentKey !== value.contentKey
  ) {
    throw new VaultShareManagerContractError("보안 공유 링크를 안전하게 확인하지 못했습니다.");
  }
  return { contentKey: value.contentKey, share, url: value.url };
}

function operationId(operation: "revoke" | "update") {
  return `vault_${operation}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function revisionBoundSourceChanged(
  share: SecureShareOwnerSummary,
  note: Pick<DecryptedVaultNote, "attachmentRevision" | "revision">
) {
  return share.sourceSyncMode === "revision_bound"
    && (
      share.sourceRevision !== (note.revision ?? 0)
      || share.sourceAttachmentRevision !== (note.attachmentRevision ?? 0)
    );
}

function shareStatusLabel(
  share: SecureShareOwnerSummary,
  now: number,
  note: Pick<DecryptedVaultNote, "attachmentRevision" | "revision">
) {
  if (share.revokedAt || share.status === "revoked") return "중단됨";
  if (Date.parse(share.expiresAt) <= now || share.status === "expired") return "만료됨";
  if (revisionBoundSourceChanged(share, note)) return "원본 변경됨";
  if (share.status === "pending") return "준비 중";
  if (share.status === "consumed") return "사용 완료";
  return share.ready ? "활성" : "준비 확인 중";
}

function sharePermissionLabel(permission: SecureShareOwnerSummary["permissionLevel"]) {
  if (permission === "comment") return "댓글 가능";
  if (permission === "save_copy") return "복사본 저장 가능";
  return "보기만 가능";
}

function canCopyShare(
  share: SecureShareOwnerSummary,
  now: number,
  note: Pick<DecryptedVaultNote, "attachmentRevision" | "revision">
) {
  return share.status === "active"
    && share.ready
    && !share.revokedAt
    && Date.parse(share.expiresAt) > now
    && !revisionBoundSourceChanged(share, note);
}

function canLoadShareComments(
  share: SecureShareOwnerSummary,
  now: number,
  note: Pick<DecryptedVaultNote, "attachmentRevision" | "id" | "revision">
) {
  return share.permissionLevel === "comment"
    && share.sourceNoteId === note.id
    && share.status === "active"
    && share.ready
    && !share.revokedAt
    && Date.parse(share.expiresAt) > now
    && !revisionBoundSourceChanged(share, note);
}

function canRevokeShare(share: SecureShareOwnerSummary, now: number) {
  return !share.revokedAt
    && Date.parse(share.expiresAt) > now
    && (share.status === "active" || share.status === "consumed" || share.status === "pending");
}

function sortShareHistory(shares: readonly SecureShareOwnerSummary[]) {
  return [...shares].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

const shareDateFormatter = new Intl.DateTimeFormat("ko-KR", {
  dateStyle: "medium",
  timeStyle: "short"
});

function managerErrorMessage(caught: unknown, fallback: string) {
  if (caught instanceof SecureShareApiError || caught instanceof VaultShareManagerContractError) {
    return caught.message;
  }
  return fallback;
}

export function vaultShareManagerAccess(
  note: DecryptedVaultNote,
  profile: UserProfile
): { allowed: true; reason: "" } | { allowed: false; reason: string } {
  if (!profile.isActive || !hasFeatureAccess(profile, "notes")) {
    return { allowed: false, reason: "활성화된 노트 권한이 있어야 공유를 관리할 수 있습니다." };
  }
  if (note.isDeleted || note.ownerUid !== profile.uid) {
    return { allowed: false, reason: "노트 소유자만 활성 노트의 공유를 관리할 수 있습니다." };
  }
  if (note.contentFormat !== "markdown-v1" && note.contentFormat !== "legacy-html-v1") {
    return { allowed: false, reason: "Markdown 또는 기존 노트만 공유할 수 있습니다." };
  }
  if (!profile.publicKeyJwk || typeof profile.publicKeyJwk !== "object") {
    return { allowed: false, reason: "암호화 프로필을 확인한 뒤 다시 시도해주세요." };
  }
  return { allowed: true, reason: "" };
}

async function loadVerifiedHistory(
  input: {
    getIdToken: () => Promise<string>;
    signal?: AbortSignal;
    sourceNoteId: string;
  },
  dependencies: VaultShareManagerDependencies
) {
  const featureStatus = parseFeatureStatus(await dependencies.getFeatureStatus(input.signal));
  if (!featureStatus.v2Enabled) {
    return { featureStatus, idToken: null, shares: [] as SecureShareOwnerSummary[] };
  }

  const idToken = parseIdToken(await input.getIdToken());
  const response = await dependencies.listShares(idToken, {
    limit: 100,
    sourceNoteId: input.sourceNoteId
  });
  let shares: SecureShareOwnerSummary[];
  try {
    shares = parseVaultSecureShareList(response, input.sourceNoteId);
  } catch {
    throw new VaultShareManagerContractError("보안 공유 이력을 안전하게 확인하지 못했습니다.");
  }
  return { featureStatus, idToken, shares: sortShareHistory(shares) };
}

export interface VaultShareManagerDialogProps {
  dependencies?: VaultShareManagerDependencies;
  getIdToken: () => Promise<string>;
  hasUnsharedAssetEmbeds: boolean;
  note: DecryptedVaultNote;
  now?: number;
  onClose: () => void;
  onRequestParticipantSharing?: () => void;
  origin?: string;
  privateKey: CryptoKey;
  profile: UserProfile;
  returnFocusTo?: HTMLElement | null;
}

export function VaultShareManagerDialog({
  dependencies = defaultDependencies,
  getIdToken,
  hasUnsharedAssetEmbeds,
  note,
  now,
  onClose,
  onRequestParticipantSharing,
  origin,
  privateKey,
  profile,
  returnFocusTo
}: VaultShareManagerDialogProps) {
  const titleId = useId();
  const linkTabId = useId();
  const participantTabId = useId();
  const linkPanelId = useId();
  const participantPanelId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const linkTabRef = useRef<HTMLButtonElement>(null);
  const participantTabRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(returnFocusTo ?? null);
  const secretUrlsRef = useRef(new Map<string, string>());
  const sharesRef = useRef<SecureShareOwnerSummary[]>([]);
  const identityRef = useRef("");
  const operationRef = useRef<ShareManagerOperation>(null);
  const access = vaultShareManagerAccess(note, profile);
  const identity = [
    profile.uid,
    note.id,
    note.ownerUid,
    note.isDeleted ? "deleted" : "active",
    note.contentFormat,
    note.revision ?? 0,
    note.attachmentRevision ?? 0,
    access.allowed ? "allowed" : "denied",
    hasUnsharedAssetEmbeds ? "embedded-assets" : "shareable-content"
  ].join("\u0000");
  const [openedAt] = useState(() => Date.now());
  const currentTime = now ?? openedAt;
  const shareOrigin = origin ?? window.location.origin;
  const [activeTab, setActiveTab] = useState<ShareManagerTab>("link");
  const [busy, setBusy] = useState<ShareManagerOperation>(null);
  const [error, setError] = useState("");
  const [fallbackUrl, setFallbackUrl] = useState<{ shareId: string; url: string } | null>(null);
  const [featureStatus, setFeatureStatus] = useState<SecureShareFeatureStatus | null>(null);
  const [notice, setNotice] = useState("");
  const [pendingRevokeId, setPendingRevokeId] = useState<string | null>(null);
  const [phase, setPhase] = useState<ShareManagerPhase>(access.allowed ? "checking" : "denied");
  const [editingInitialPolicy, setEditingInitialPolicy] = useState<SecureSharePolicyInput | null>(null);
  const [editingShareId, setEditingShareId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shares, setShares] = useState<SecureShareOwnerSummary[]>([]);
  const blockingShare = useMemo(
    () => shares.find((share) => vaultSecureShareBlocksCreation(share, currentTime)) ?? null,
    [currentTime, shares]
  );

  function replaceShares(nextShares: SecureShareOwnerSummary[]) {
    sharesRef.current = nextShares;
    setShares(nextShares);
  }

  function updateShares(
    update: (current: SecureShareOwnerSummary[]) => SecureShareOwnerSummary[]
  ) {
    replaceShares(update(sharesRef.current));
  }

  useModalFocus(dialogRef, {
    returnFocusRef: returnFocusRef as RefObject<HTMLElement | null>
  });

  useLayoutEffect(() => {
    sharesRef.current = shares;
  }, [shares]);

  useLayoutEffect(() => {
    const secretUrls = secretUrlsRef.current;
    identityRef.current = identity;
    return () => {
      if (identityRef.current === identity) {
        identityRef.current = "";
        operationRef.current = null;
        secretUrls.clear();
      }
    };
  }, [identity]);

  function clearSecretMemory() {
    secretUrlsRef.current.clear();
    setFallbackUrl(null);
  }

  function applyVerifiedHistory(result: Awaited<ReturnType<typeof loadVerifiedHistory>>) {
    setFeatureStatus(result.featureStatus);
    replaceShares(result.shares);
    setPendingRevokeId(null);
    if (result.featureStatus.v2Enabled) {
      const reusableUrlIds = new Set(
        result.shares
          .filter((share) => canCopyShare(share, currentTime, note))
          .map((share) => share.shareId)
      );
      for (const shareId of secretUrlsRef.current.keys()) {
        if (!reusableUrlIds.has(shareId)) secretUrlsRef.current.delete(shareId);
      }
      setFallbackUrl((current) => current && reusableUrlIds.has(current.shareId) ? current : null);
      setPhase("ready");
      return true;
    }
    clearSecretMemory();
    setPhase("unavailable");
    return false;
  }

  function currentCommentShare(
    target: SecureShareOwnerCommentTarget,
    expectedIdentity: string
  ) {
    if (
      identityRef.current !== expectedIdentity
      || target.sourceNoteId !== note.id
    ) {
      throw new VaultShareManagerContractError("댓글을 확인할 보안 공유가 변경되었습니다.");
    }

    const currentShare = sharesRef.current.find((share) => share.shareId === target.shareId);
    const eligibilityTime = now ?? Date.now();
    if (
      !currentShare
      || currentShare.sourceNoteId !== target.sourceNoteId
      || currentShare.policyVersion !== target.policyVersion
      || !canLoadShareComments(currentShare, eligibilityTime, note)
    ) {
      throw new VaultShareManagerContractError("댓글을 확인할 활성 보안 공유를 찾지 못했습니다.");
    }
    return currentShare;
  }

  async function loadOwnerComments(
    target: SecureShareOwnerCommentTarget,
    cursor: string | null,
    signal: AbortSignal
  ): Promise<SecureShareCommentsPage> {
    const expectedIdentity = identity;
    currentCommentShare(target, expectedIdentity);
    if (signal.aborted) {
      throw new DOMException("댓글 불러오기가 취소되었습니다.", "AbortError");
    }

    const idToken = parseIdToken(await getIdToken());
    if (signal.aborted) {
      throw new DOMException("댓글 불러오기가 취소되었습니다.", "AbortError");
    }
    currentCommentShare(target, expectedIdentity);

    const response = await dependencies.listComments(target.shareId, {
      ...(cursor ? { cursor } : {}),
      idToken,
      limit: 20,
      signal
    });
    if (signal.aborted) {
      throw new DOMException("댓글 불러오기가 취소되었습니다.", "AbortError");
    }
    const currentShare = currentCommentShare(target, expectedIdentity);
    const page = parseSecureShareCommentsResponse(
      response,
      currentShare.showCommenterIpPrefix === true
    );
    if (!page) {
      throw new VaultShareManagerContractError("보안 공유 댓글 응답을 안전하게 확인하지 못했습니다.");
    }
    return page;
  }

  useEffect(() => {
    const controller = new AbortController();
    const expectedIdentity = identity;
    secretUrlsRef.current.clear();
    operationRef.current = null;
    setBusy(null);
    setError("");
    setFallbackUrl(null);
    setFeatureStatus(null);
    setNotice("");
    setPendingRevokeId(null);
    setEditingInitialPolicy(null);
    setEditingShareId(null);
    setSettingsOpen(false);
    sharesRef.current = [];
    setShares([]);

    if (!access.allowed) {
      setPhase("denied");
      return () => controller.abort();
    }

    setPhase("checking");
    void loadVerifiedHistory(
      { getIdToken, signal: controller.signal, sourceNoteId: note.id },
      dependencies
    ).then((result) => {
      if (!controller.signal.aborted && identityRef.current === expectedIdentity) {
        applyVerifiedHistory(result);
      }
    }).catch((caught) => {
      if (!controller.signal.aborted && identityRef.current === expectedIdentity) {
        setError(managerErrorMessage(caught, "보안 공유 이력을 불러오지 못했습니다."));
        setPhase("error");
      }
    });

    return () => controller.abort();
    // The identity signature intentionally reloads only when the security scope changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [access.allowed, access.reason, dependencies, getIdToken, identity, note.id]);

  useEffect(() => () => {
    secretUrlsRef.current.clear();
  }, []);

  function beginOperation(operation: Exclude<ShareManagerOperation, null>) {
    if (operationRef.current) return false;
    operationRef.current = operation;
    setBusy(operation);
    setError("");
    setNotice("");
    return true;
  }

  function finishOperation(operation: Exclude<ShareManagerOperation, null>) {
    if (operationRef.current === operation) {
      operationRef.current = null;
      setBusy(null);
    }
  }

  function closeManager() {
    if (operationRef.current) return;
    clearSecretMemory();
    onClose();
  }

  async function refreshHistory() {
    if (!access.allowed || !beginOperation("checking")) return;
    const expectedIdentity = identity;
    try {
      const result = await loadVerifiedHistory({ getIdToken, sourceNoteId: note.id }, dependencies);
      if (identityRef.current !== expectedIdentity) return;
      applyVerifiedHistory(result);
      setNotice(result.featureStatus.v2Enabled ? "공유 이력을 새로 확인했습니다." : "");
    } catch (caught) {
      if (identityRef.current !== expectedIdentity) return;
      setError(managerErrorMessage(caught, "보안 공유 이력을 불러오지 못했습니다."));
      setPhase("error");
    } finally {
      finishOperation("checking");
    }
  }

  function requestCreate() {
    if (
      phase !== "ready"
      || !access.allowed
      || operationRef.current
      || hasUnsharedAssetEmbeds
      || blockingShare
    ) return;
    setEditingInitialPolicy(null);
    setEditingShareId(null);
    setSettingsOpen(true);
  }

  async function requestEdit(share: SecureShareOwnerSummary) {
    if (
      phase !== "ready"
      || !access.allowed
      || !canCopyShare(share, currentTime, note)
      || !beginOperation("editing")
    ) return;
    const expectedIdentity = identity;
    try {
      const idToken = parseIdToken(await getIdToken());
      const details = parseVaultSecureShareOwnerDetails(
        await dependencies.getShareDetails(share.shareId, idToken)
      );
      if (
        details.share.shareId !== share.shareId
        || details.share.sourceNoteId !== note.id
        || !canCopyShare(details.share, currentTime, note)
      ) {
        throw new VaultShareManagerContractError("변경할 보안 공유의 활성 상태를 확인하지 못했습니다.");
      }
      if (identityRef.current !== expectedIdentity) return;
      updateShares((current) => current.map((candidate) => (
        candidate.shareId === details.share.shareId ? details.share : candidate
      )));
      setEditingShareId(details.share.shareId);
      setEditingInitialPolicy(details.initialPolicy);
      setSettingsOpen(true);
    } catch (caught) {
      if (identityRef.current === expectedIdentity) {
        setError(managerErrorMessage(caught, "보안 공유 설정을 불러오지 못했습니다."));
      }
    } finally {
      finishOperation("editing");
    }
  }

  async function createShare(policy: SecureSharePolicyInput) {
    if (hasUnsharedAssetEmbeds) {
      throw new SecureShareSettingsSaveError(
        "공유되지 않은 첨부 자산이 있어 보안 링크 생성을 중단했습니다. 첨부를 제거하거나 자산 공유 지원 후 다시 시도해주세요."
      );
    }
    if (phase !== "ready" || !access.allowed || !beginOperation("creating")) {
      throw new SecureShareSettingsSaveError("공유 상태 확인이 끝난 뒤 다시 시도해주세요.");
    }

    const expectedIdentity = identity;
    try {
      const verified = await loadVerifiedHistory({ getIdToken, sourceNoteId: note.id }, dependencies);
      if (identityRef.current !== expectedIdentity) {
        throw new VaultShareManagerContractError("열린 노트가 변경되어 공유 생성을 중단했습니다.");
      }
      if (!applyVerifiedHistory(verified) || !verified.idToken) {
        throw new VaultShareManagerContractError("현재 보안 공유 기능을 사용할 수 없습니다.");
      }
      if (verified.shares.some((share) => vaultSecureShareBlocksCreation(share, currentTime))) {
        throw new VaultShareManagerContractError(
          "이미 활성 또는 준비 중인 보안 링크가 있습니다. 먼저 기존 링크를 중단해주세요."
        );
      }
      if (policy.accessMode === "allowed_emails" && !verified.featureStatus.emailEnabled) {
        throw new VaultShareManagerContractError(
          "현재 서버에서 이메일 지정 공유를 사용할 수 없습니다. 다른 공유 대상을 선택해주세요."
        );
      }

      const result = parseSecretResult(await dependencies.createShare({
        emailFeatureEnabled: verified.featureStatus.emailEnabled,
        idToken: verified.idToken,
        note,
        origin: normalizedShareOrigin(shareOrigin),
        policy,
        privateKey,
        profile
      }), note.id, normalizedShareOrigin(shareOrigin));
      if (
        result.share.status !== "active"
        || !result.share.ready
        || !vaultSecureShareBlocksCreation(result.share, currentTime)
        || result.share.sourceRevision !== (note.revision ?? 0)
      ) {
        throw new VaultShareManagerContractError("생성된 보안 링크의 활성 상태를 확인하지 못했습니다.");
      }
      if (identityRef.current !== expectedIdentity) return;

      secretUrlsRef.current.set(result.share.shareId, result.url);
      updateShares((current) => sortShareHistory([
        result.share,
        ...current.filter((share) => share.shareId !== result.share.shareId)
      ]));
      setSettingsOpen(false);
      setNotice("보안 링크를 만들었습니다. 링크 키는 이 화면의 메모리에만 유지됩니다.");
    } catch (caught) {
      throw new SecureShareSettingsSaveError(
        managerErrorMessage(caught, "보안 링크를 만들지 못했습니다. 다시 시도해주세요.")
      );
    } finally {
      finishOperation("creating");
    }
  }

  async function saveShareSettings(policy: SecureSharePolicyInput) {
    const shareId = editingShareId;
    if (!shareId) return createShare(policy);
    if (
      phase !== "ready"
      || !access.allowed
      || !featureStatus?.v2Enabled
      || !beginOperation("editing")
    ) {
      throw new SecureShareSettingsSaveError("공유 상태 확인이 끝난 뒤 다시 시도해주세요.");
    }
    const expectedIdentity = identity;
    try {
      if (policy.accessMode === "allowed_emails" && !featureStatus.emailEnabled) {
        throw new VaultShareManagerContractError(
          "현재 서버에서 이메일 지정 공유를 사용할 수 없습니다. 다른 공유 대상을 선택해주세요."
        );
      }
      const idToken = parseIdToken(await getIdToken());
      const updated = parseVaultSecureShareMutation(await dependencies.updateShare(
        shareId,
        { idempotencyKey: operationId("update"), policy },
        idToken,
        { emailFeatureEnabled: featureStatus.emailEnabled, now: new Date(currentTime) }
      ), shareId);
      if (updated.sourceNoteId !== note.id || identityRef.current !== expectedIdentity) {
        throw new VaultShareManagerContractError("변경된 보안 공유의 원본 노트를 확인하지 못했습니다.");
      }
      updateShares((current) => current.map((share) => share.shareId === shareId ? updated : share));
      setEditingInitialPolicy(null);
      setEditingShareId(null);
      setSettingsOpen(false);
      setNotice("보안 공유 설정을 저장했습니다.");
    } catch (caught) {
      throw new SecureShareSettingsSaveError(
        managerErrorMessage(caught, "보안 공유 설정을 저장하지 못했습니다. 다시 시도해주세요.")
      );
    } finally {
      finishOperation("editing");
    }
  }

  async function copyShare(share: SecureShareOwnerSummary) {
    if (
      phase !== "ready"
      || !canCopyShare(share, currentTime, note)
      || !beginOperation("copying")
    ) return;
    const expectedIdentity = identity;
    try {
      let url = secretUrlsRef.current.get(share.shareId) ?? "";
      if (!url) {
        const idToken = parseIdToken(await getIdToken());
        const recovered = parseSecretResult(await dependencies.recoverShareUrl({
          idToken,
          origin: normalizedShareOrigin(shareOrigin),
          privateKey,
          share
        }), note.id, normalizedShareOrigin(shareOrigin));
        if (recovered.share.shareId !== share.shareId) {
          throw new VaultShareManagerContractError("보안 공유 링크의 대상을 확인하지 못했습니다.");
        }
        if (identityRef.current !== expectedIdentity) return;
        updateShares((current) => current.map((item) =>
          item.shareId === recovered.share.shareId ? recovered.share : item
        ));
        if (!canCopyShare(recovered.share, currentTime, note)) {
          secretUrlsRef.current.delete(share.shareId);
          setFallbackUrl((current) => current?.shareId === share.shareId ? null : current);
          setNotice("이 보안 링크는 더 이상 활성 상태가 아니어서 주소를 복사하지 않았습니다.");
          return;
        }
        url = recovered.url;
        secretUrlsRef.current.set(share.shareId, url);
      }

      if (!navigator.clipboard?.writeText) {
        throw new Error("clipboard_unavailable");
      }
      try {
        await navigator.clipboard.writeText(url);
        if (identityRef.current === expectedIdentity) {
          setFallbackUrl(null);
          setNotice("보안 공유 주소를 복사했습니다.");
        }
      } catch {
        if (identityRef.current === expectedIdentity) {
          setFallbackUrl({ shareId: share.shareId, url });
          setNotice("자동 복사 권한이 없어 읽기 전용 주소를 표시했습니다. 직접 선택해 복사해주세요.");
        }
      }
    } catch (caught) {
      if (caught instanceof Error && caught.message === "clipboard_unavailable") {
        const url = secretUrlsRef.current.get(share.shareId);
        if (url && identityRef.current === expectedIdentity) {
          setFallbackUrl({ shareId: share.shareId, url });
          setNotice("자동 복사를 지원하지 않아 읽기 전용 주소를 표시했습니다. 직접 선택해 복사해주세요.");
        }
      } else if (identityRef.current === expectedIdentity) {
        setError(managerErrorMessage(caught, "보안 공유 주소를 복구하지 못했습니다."));
      }
    } finally {
      finishOperation("copying");
    }
  }

  async function confirmRevoke(share: SecureShareOwnerSummary) {
    if (phase !== "ready" || !canRevokeShare(share, currentTime) || !beginOperation("revoking")) return;
    const expectedIdentity = identity;
    try {
      const idToken = parseIdToken(await getIdToken());
      const revoked = parseVaultSecureShareMutation(
        await dependencies.revokeShare(share.shareId, idToken, operationId("revoke")),
        share.shareId
      );
      if (
        revoked.sourceNoteId !== note.id
        || revoked.status !== "revoked"
        || !revoked.revokedAt
      ) {
        throw new VaultShareManagerContractError("보안 공유 중단 상태를 안전하게 확인하지 못했습니다.");
      }
      if (identityRef.current !== expectedIdentity) return;

      secretUrlsRef.current.delete(share.shareId);
      setFallbackUrl((current) => current?.shareId === share.shareId ? null : current);
      updateShares((current) => current.map((item) => item.shareId === share.shareId ? revoked : item));
      setPendingRevokeId(null);
      setNotice("보안 링크를 중단했습니다.");
    } catch (caught) {
      if (identityRef.current === expectedIdentity) {
        setError(managerErrorMessage(caught, "보안 링크를 중단하지 못했습니다."));
      }
    } finally {
      finishOperation("revoking");
    }
  }

  function openParticipantSharing() {
    if (
      !access.allowed
      || (hasUnsharedAssetEmbeds && participantCount === 0)
      || !onRequestParticipantSharing
      || operationRef.current
    ) return;
    clearSecretMemory();
    onClose();
    onRequestParticipantSharing();
  }

  const participantCount = note.participantUids.filter((uid) => uid !== profile.uid).length;
  const createDisabled = phase !== "ready"
    || Boolean(busy)
    || Boolean(blockingShare)
    || hasUnsharedAssetEmbeds;

  function handleTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    let nextTab: ShareManagerTab | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp" || event.key === "Home") {
      nextTab = "link";
    } else if (event.key === "ArrowRight" || event.key === "ArrowDown" || event.key === "End") {
      nextTab = "participants";
    }
    if (!nextTab) return;
    event.preventDefault();
    setActiveTab(nextTab);
    (nextTab === "link" ? linkTabRef : participantTabRef).current?.focus();
  }

  return (
    <div
      className="vault-share-manager-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !operationRef.current && !settingsOpen) {
          closeManager();
        }
      }}
      role="presentation"
    >
      <section
        aria-busy={Boolean(busy)}
        aria-labelledby={titleId}
        aria-modal="true"
        className="vault-share-manager"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !operationRef.current && !settingsOpen) {
            event.preventDefault();
            closeManager();
          }
        }}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="vault-share-manager-header">
          <div>
            <span className="vault-share-manager-kicker">
              <ShieldCheck aria-hidden="true" size={16} /> 안전한 노트 공유
            </span>
            <h2 id={titleId}>{note.title || "제목 없음"}</h2>
          </div>
          <button
            aria-label="노트 공유 관리 창 닫기"
            className="icon-button"
            disabled={Boolean(busy)}
            onClick={closeManager}
            type="button"
          >
            <X aria-hidden="true" size={18} />
          </button>
        </header>

        <div aria-label="공유 방식" className="vault-share-manager-tabs" role="tablist">
          <button
            aria-controls={linkPanelId}
            aria-selected={activeTab === "link"}
            className={activeTab === "link" ? "active" : ""}
            id={linkTabId}
            onClick={() => setActiveTab("link")}
            onKeyDown={handleTabKeyDown}
            ref={linkTabRef}
            role="tab"
            tabIndex={activeTab === "link" ? 0 : -1}
            type="button"
          >
            <Link2 aria-hidden="true" size={16} /> 보안 링크
          </button>
          <button
            aria-controls={participantPanelId}
            aria-selected={activeTab === "participants"}
            className={activeTab === "participants" ? "active" : ""}
            id={participantTabId}
            onClick={() => setActiveTab("participants")}
            onKeyDown={handleTabKeyDown}
            ref={participantTabRef}
            role="tab"
            tabIndex={activeTab === "participants" ? 0 : -1}
            type="button"
          >
            <Users aria-hidden="true" size={16} /> QuickMemo 사용자
          </button>
        </div>

        {activeTab === "link" ? (
          <div
            aria-labelledby={linkTabId}
            className="vault-share-manager-panel"
            id={linkPanelId}
            role="tabpanel"
          >
            <p className="vault-share-manager-description">
              공유 키는 서버가 아니라 링크의 fragment와 현재 열린 화면의 메모리에만 유지됩니다.
              링크에는 저장된 현재 버전의 암호화 스냅샷이 담깁니다. 원본 노트의 내용이나 첨부가 변경되면
              기존 링크는 즉시 접근할 수 없게 되며, 변경 내용을 공유하려면 새 링크를 만들어야 합니다.
            </p>
            {hasUnsharedAssetEmbeds ? (
              <p className="form-error" role="alert">
                이 노트에는 아직 ACL과 재암호화를 안전하게 전달할 수 없는 첨부 자산이 있습니다.
                첨부를 제거하거나 자산 공유가 지원될 때까지 새 보안 링크와 사용자 공유를 만들 수 없습니다.
              </p>
            ) : null}

            {phase === "checking" ? (
              <div className="vault-share-manager-state" role="status">
                <Loader2 aria-hidden="true" className="spin" size={18} /> 보안 공유 상태를 확인하는 중…
              </div>
            ) : null}
            {phase === "denied" ? <p className="form-error" role="alert">{access.reason}</p> : null}
            {phase === "unavailable" ? (
              <p className="form-error" role="alert">현재 서버에서 보안 공유 기능을 사용할 수 없습니다.</p>
            ) : null}
            {error ? <p className="form-error" role="alert">{error}</p> : null}
            {notice ? <p className="vault-share-manager-notice" role="status">{notice}</p> : null}

            {phase === "error" ? (
              <button
                className="secondary-button vault-share-manager-retry"
                disabled={Boolean(busy)}
                onClick={() => void refreshHistory()}
                type="button"
              >
                <RefreshCw aria-hidden="true" size={15} /> 다시 확인
              </button>
            ) : null}

            {phase === "ready" ? (
              <>
                <div className="vault-share-manager-toolbar">
                  <div>
                    <strong>이 노트의 링크 이력</strong>
                    <small>{shares.length}개 · 서버에서 노트별로 확인됨</small>
                  </div>
                  <button
                    aria-label="보안 공유 이력 새로고침"
                    className="icon-button"
                    disabled={Boolean(busy)}
                    onClick={() => void refreshHistory()}
                    type="button"
                  >
                    <RefreshCw aria-hidden="true" size={16} />
                  </button>
                </div>

                {shares.length ? (
                  <ul className="vault-share-manager-list">
                    {shares.map((share) => {
                      const copyable = canCopyShare(share, currentTime, note);
                      const revocable = canRevokeShare(share, currentTime);
                      const revokePending = pendingRevokeId === share.shareId;
                      const statusLabel = shareStatusLabel(share, currentTime, note);
                      return (
                        <li key={share.shareId}>
                          <div className="vault-share-manager-item-heading">
                            <span className={`vault-share-manager-status status-${statusLabel.replaceAll(" ", "-")}`}>
                              {statusLabel}
                            </span>
                            <small>{shareDateFormatter.format(new Date(share.createdAt))}</small>
                          </div>
                          <p>{sharePermissionLabel(share.permissionLevel)} · {share.successfulAccessCount}회 접근</p>
                          <div className="vault-share-manager-item-actions">
                            {copyable ? (
                              <button
                                className="secondary-button"
                                disabled={Boolean(busy)}
                                onClick={() => void copyShare(share)}
                                type="button"
                              >
                                {busy === "copying"
                                  ? <Loader2 aria-hidden="true" className="spin" size={15} />
                                  : <Copy aria-hidden="true" size={15} />}
                                주소 복사
                              </button>
                            ) : null}
                            {copyable ? (
                              <button
                                className="secondary-button"
                                disabled={Boolean(busy)}
                                onClick={() => void requestEdit(share)}
                                type="button"
                              >
                                설정 변경
                              </button>
                            ) : null}
                            {revocable && !revokePending ? (
                              <button
                                className="secondary-button vault-share-manager-danger"
                                disabled={Boolean(busy)}
                                onClick={() => setPendingRevokeId(share.shareId)}
                                type="button"
                              >
                                <Trash2 aria-hidden="true" size={15} /> 링크 중단
                              </button>
                            ) : null}
                            {revocable && revokePending ? (
                              <div className="vault-share-manager-confirm" role="group" aria-label="링크 중단 확인">
                                <span>정말 중단할까요?</span>
                                <button
                                  className="danger-button"
                                  disabled={Boolean(busy)}
                                  onClick={() => void confirmRevoke(share)}
                                  type="button"
                                >중단</button>
                                <button
                                  className="secondary-button"
                                  disabled={Boolean(busy)}
                                  onClick={() => setPendingRevokeId(null)}
                                  type="button"
                                >취소</button>
                              </div>
                            ) : null}
                          </div>
                          {fallbackUrl?.shareId === share.shareId ? (
                            <label className="vault-share-manager-fallback">
                              <span>복사할 보안 공유 주소</span>
                              <input
                                aria-describedby={`${linkPanelId}-fallback-help`}
                                aria-label="복사할 보안 공유 주소"
                                onFocus={(event) => event.currentTarget.select()}
                                readOnly
                                value={fallbackUrl.url}
                              />
                              <small id={`${linkPanelId}-fallback-help`}>
                                주소에는 복호화 키가 포함됩니다. 의도한 사람에게만 전달하세요.
                              </small>
                            </label>
                          ) : null}
                          {canLoadShareComments(share, currentTime, note) ? (
                            <SecureShareOwnerCommentsPanel
                              disabled={Boolean(busy)}
                              onLoadComments={loadOwnerComments}
                              share={share}
                            />
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="vault-share-manager-empty">아직 만든 보안 링크가 없습니다.</p>
                )}

                {blockingShare ? (
                  <p className="vault-share-manager-blocked" role="status">
                    활성, 준비 중 또는 원본이 변경된 링크를 중단한 뒤 새 링크를 만들 수 있습니다.
                  </p>
                ) : null}
                <button
                  data-dialog-initial-focus
                  disabled={createDisabled}
                  onClick={requestCreate}
                  type="button"
                >
                  {busy === "checking"
                    ? <Loader2 aria-hidden="true" className="spin" size={16} />
                    : <Link2 aria-hidden="true" size={16} />}
                  새 보안 링크 만들기
                </button>
              </>
            ) : null}
          </div>
        ) : (
          <div
            aria-labelledby={participantTabId}
            className="vault-share-manager-panel vault-share-manager-participants"
            id={participantPanelId}
            role="tabpanel"
          >
            <Users aria-hidden="true" size={30} />
            <h3>QuickMemo 사용자와 암호화 공유</h3>
            <p>
              선택한 사용자의 공개키로만 노트 키를 다시 감쌉니다. 현재 소유자 외 {participantCount}명이 공유 대상입니다.
            </p>
            {!access.allowed ? <p className="form-error" role="alert">{access.reason}</p> : null}
            {hasUnsharedAssetEmbeds ? (
              <p className="form-error" role="alert">
                공유되지 않은 첨부 자산이 있어 새 사용자를 추가할 수 없습니다.
                {participantCount > 0 ? " 기존 사용자 공유를 모두 해제하는 작업만 열 수 있습니다." : " 첨부를 제거한 뒤 다시 시도해주세요."}
              </p>
            ) : null}
            <button
              disabled={
                !access.allowed
                || (hasUnsharedAssetEmbeds && participantCount === 0)
                || !onRequestParticipantSharing
                || Boolean(busy)
              }
              onClick={openParticipantSharing}
              type="button"
            >
              <Users aria-hidden="true" size={16} /> 사용자 공유 설정 열기
            </button>
            {!onRequestParticipantSharing ? (
              <small>사용자 공유 화면이 연결되지 않았습니다.</small>
            ) : null}
          </div>
        )}
      </section>

      {settingsOpen && featureStatus?.v2Enabled ? (
        <SecureShareSettingsModal
          emailFeatureEnabled={featureStatus.emailEnabled}
          hasStoredPassword={editingInitialPolicy?.passwordEnabled === true}
          initialValue={editingInitialPolicy ?? undefined}
          mode={editingShareId ? "edit" : "create"}
          now={new Date(currentTime)}
          onClose={() => {
            if (busy !== "creating" && busy !== "editing") {
              setEditingInitialPolicy(null);
              setEditingShareId(null);
              setSettingsOpen(false);
            }
          }}
          onSave={saveShareSettings}
          saving={busy === "creating" || busy === "editing"}
        />
      ) : null}
    </div>
  );
}
