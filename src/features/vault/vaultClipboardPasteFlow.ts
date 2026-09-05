import type { UserProfile } from "../../types";
import {
  deleteRevisionedNote,
  getVisibleNotesByIdsFromServer,
  VaultNameConflictError
} from "../../services/notes";
import type {
  MarkdownImagePasteContext,
  MarkdownImagePasteResult
} from "./CodeMirrorMarkdownEditor";
import {
  clearPreparedVaultClipboardImages,
  prepareVaultClipboardImages,
  reserveVaultClipboardImageTitles,
  vaultClipboardImageEmbedSource,
  type PreparedVaultClipboardImage
} from "./clipboardImagePaste";
import type { DecryptedVaultNote } from "./vaultData";
import { normalizeVaultPath } from "./interop/path";
import { createEncryptedVaultAsset } from "./vaultPersistence";

const MAXIMUM_CONCURRENT_CLIPBOARD_ASSET_WRITES = 3;
const MAXIMUM_CLIPBOARD_ASSET_NAME_CONFLICT_RETRIES = 3;
export const VAULT_CLIPBOARD_SOURCE_READ_TIMEOUT_MS = 8_000;
export const VAULT_CLIPBOARD_SOURCE_READY_TIMEOUT_MS = 3_000;
export const VAULT_CLIPBOARD_ROLLBACK_BLOCKED_MESSAGE = "저장이 확인되지 않은 중복 이미지 링크를 모두 지우면 최신 편집 내용의 자동 저장을 즉시 재개합니다.";

export function beginVaultClipboardPastePendingGuard(input: {
  counts: Map<string, number>;
  entryId: string;
  hasDirtyDraft: () => boolean;
  resumeSave: () => void;
}) {
  input.counts.set(input.entryId, (input.counts.get(input.entryId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const nextCount = (input.counts.get(input.entryId) ?? 1) - 1;
    if (nextCount > 0) {
      input.counts.set(input.entryId, nextCount);
      return;
    }
    input.counts.delete(input.entryId);
    if (input.hasDirtyDraft()) queueMicrotask(input.resumeSave);
  };
}

/** Wait only for a transient subscription gate; never bypass the actual save checks. */
export async function waitForVaultClipboardSourceReadiness(input: {
  isReady: () => boolean;
  assertCurrent: () => void;
  signal: AbortSignal;
  sessionSignal: AbortSignal;
}) {
  const deadline = performance.now() + VAULT_CLIPBOARD_SOURCE_READY_TIMEOUT_MS;
  const signals = [input.signal, input.sessionSignal];
  while (true) {
    signals.forEach((signal) => signal.throwIfAborted());
    input.assertCurrent();
    if (input.isReady()) return;
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error("이미지 링크를 저장할 서버 준비 상태를 확인하지 못했습니다.");
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signals.forEach((signal) => signal.removeEventListener("abort", abort));
      };
      const abort = () => {
        cleanup();
        reject(signals.find((signal) => signal.aborted)?.reason
          ?? new DOMException("이미지 저장이 취소되었습니다.", "AbortError"));
      };
      const timer = setTimeout(() => { cleanup(); resolve(); }, Math.min(25, remaining));
      signals.forEach((signal) => signal.addEventListener("abort", abort, { once: true }));
    });
  }
}

export async function commitVaultClipboardSourceWithConfirmation(
  commit: () => Promise<void>,
  isConfirmed: () => boolean,
  hasDirtyDraft: () => boolean
) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await commit();
    if (isConfirmed()) return true;
    if (!hasDirtyDraft()) break;
  }
  return false;
}

export function rollbackVaultClipboardSource(
  body: string,
  { replacementText, source }: { replacementText: string; source: string }
) {
  if (!source) return null;
  const sourceIndex = body.indexOf(source);
  if (sourceIndex < 0) return body;
  if (body.indexOf(source, sourceIndex + source.length) >= 0) return null;
  return `${body.slice(0, sourceIndex)}${replacementText}${body.slice(sourceIndex + source.length)}`;
}

export function releaseResolvedVaultClipboardRollbacks(
  body: string,
  blocked: Map<string, () => void>
) {
  for (const [source, release] of blocked) {
    if (body.includes(source)) continue;
    blocked.delete(source);
    release();
  }
  return blocked.size === 0;
}

export function withVaultClipboardSourceReadDeadline<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  timeoutMs = VAULT_CLIPBOARD_SOURCE_READ_TIMEOUT_MS
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("Vault clipboard source read deadline must be a positive integer");
  }
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => finish(() => reject(
      signal.reason ?? new DOMException("이미지 추가가 취소되었습니다.", "AbortError")
    ));
    const timeout = globalThis.setTimeout(() => finish(() => reject(
      new Error("서버의 원본 노트 확인이 지연되어 이미지 추가를 중단했습니다. 잠시 후 다시 시도해주세요.")
    )), timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    );
  });
}

export interface PendingClipboardAssetReservation {
  folderId: string | null;
  sourceNoteId: string;
  title: string;
}

export interface VaultClipboardAssetDestination {
  folderId: string;
  folderPath: string;
  folderRevision: number;
  holderId: string;
  lockId: string;
}

export interface VaultClipboardPasteFlowInput {
  assertAssetDestinationCurrent: (destination: VaultClipboardAssetDestination) => void;
  commitSource: (
    source: string,
    destination: VaultClipboardAssetDestination
  ) => Promise<boolean>;
  confirmAssetDestination: (destination: VaultClipboardAssetDestination) => Promise<void>;
  files: readonly File[];
  getNotes: () => readonly DecryptedVaultNote[];
  integrityKey: CryptoKey;
  note: DecryptedVaultNote;
  pendingAssetTitleKeyById: Map<string, string>;
  pendingAssetTitleKeys: Map<string, PendingClipboardAssetReservation>;
  pendingClipboardAssetIds: Set<string>;
  pendingCreatedEntryIds: Set<string>;
  profile: UserProfile;
  releaseAssetDestination: (destination: VaultClipboardAssetDestination) => Promise<void>;
  resolveAssetDestination: (signal: AbortSignal) => Promise<VaultClipboardAssetDestination>;
  rollbackSource: (input: { replacementText: string; source: string }) => boolean;
  setError: (message: string | null) => void;
  setStatus: (message: string) => void;
  signal: MarkdownImagePasteContext["signal"];
  sourceFolderId: string | null;
  sourceTitle: string;
}

function clipboardAssetTitleReservationKey(folderId: string | null, title: string) {
  return JSON.stringify([
    folderId,
    title.normalize("NFC").toLocaleLowerCase("en-US")
  ]);
}

export async function pasteVaultClipboardImages({
  assertAssetDestinationCurrent,
  commitSource,
  confirmAssetDestination,
  files,
  getNotes,
  integrityKey,
  note,
  pendingAssetTitleKeyById,
  pendingAssetTitleKeys,
  pendingClipboardAssetIds,
  pendingCreatedEntryIds,
  profile,
  releaseAssetDestination,
  resolveAssetDestination,
  rollbackSource,
  setError,
  setStatus,
  signal,
  sourceFolderId,
  sourceTitle
}: VaultClipboardPasteFlowInput): Promise<MarkdownImagePasteResult | null> {
  const ownerUid = profile.uid;
  let prepared: PreparedVaultClipboardImage[] = [];
  const createdAssets: Array<{
    noteId: string;
    revision: number;
    title: string;
    titleKey: string;
    vaultPasteLockId: string;
  } | undefined> = [];
  const reservedTitleKeys = new Set<string>();
  let assetDestination: VaultClipboardAssetDestination | null = null;
  let discardOnFailure = false;
  let discardPromise: Promise<void> | null = null;
  let destinationReleasePromise: Promise<void> | null = null;
  const releaseDestination = () => {
    if (!assetDestination) return Promise.resolve();
    destinationReleasePromise ??= releaseAssetDestination(assetDestination).catch(() => {
      setError("붙여넣은 이미지 폴더의 서버 잠금을 즉시 해제하지 못했습니다. 잠금은 자동 만료되며 다른 이름이나 경로 작업은 그 전까지 차단됩니다.");
    });
    return destinationReleasePromise;
  };
  const discardCreatedAssets = () => {
    discardPromise ??= (async () => {
      const assets = createdAssets.filter((asset): asset is NonNullable<typeof asset> => Boolean(asset));
      const results = await Promise.allSettled(assets.map(async (asset) => {
        try {
          await deleteRevisionedNote({
            expectedRevision: asset.revision,
            noteId: asset.noteId,
            readerUids: [ownerUid],
            uid: ownerUid,
            vaultPasteLockId: asset.vaultPasteLockId
          });
        } finally {
          // A lost delete response is ambiguous: the server may already have
          // removed the asset. Always release local reservations so a later
          // paste can reconcile against the subscription or the server's
          // authoritative name-conflict response instead of staying blocked.
          pendingCreatedEntryIds.delete(asset.noteId);
          pendingAssetTitleKeyById.delete(asset.noteId);
          pendingAssetTitleKeys.delete(asset.titleKey);
          pendingClipboardAssetIds.delete(asset.noteId);
        }
      }));
      const failedCount = results.filter((result) => result.status === "rejected").length;
      if (failedCount > 0) {
        setError(`취소된 이미지 추가에서 ${failedCount}개 asset을 자동으로 휴지통에 옮기지 못했습니다. Vault에서 직접 확인해주세요.`);
      }
    })();
    return discardPromise;
  };
  let discardPastePromise: Promise<void> | null = null;
  const discardPaste = () => {
    discardPastePromise ??= (async () => {
      await discardCreatedAssets();
      await releaseDestination();
    })();
    return discardPastePromise;
  };
  const throwIfCancelled = (checkSignal: AbortSignal = signal) => {
    if (checkSignal.aborted) {
      throw checkSignal.reason
        ?? new DOMException("이미지 추가가 취소되었습니다.", "AbortError");
    }
  };
  const createdTitles = () => createdAssets.flatMap((asset) => asset ? [asset.title] : []);
  const assertSourceRemainsPrivate = async (checkSignal: AbortSignal = signal) => {
    throwIfCancelled(checkSignal);
    const local = getNotes().find((candidate) => candidate.id === note.id);
    if (
      !local
      || local.ownerUid !== ownerUid
      || local.type !== "personal"
      || local.isDeleted
      || local.entryKind !== "markdown"
      || local.contentFormat !== "markdown-v1"
      || (local.folderId ?? null) !== sourceFolderId
      || local.participantUids.length !== 1
      || local.participantUids[0] !== ownerUid
    ) {
      throw new Error("이미지를 추가하는 동안 노트의 소유권이나 공유 상태가 변경되어 저장을 중단했습니다.");
    }
    const serverRead = await withVaultClipboardSourceReadDeadline(
      getVisibleNotesByIdsFromServer(ownerUid, [note.id]),
      checkSignal
    );
    throwIfCancelled(checkSignal);
    const server = serverRead.notes.find((candidate) => candidate.id === note.id);
    if (
      !serverRead.resolvedNoteIds.includes(note.id)
      || !server
      || server.ownerUid !== ownerUid
      || server.type !== "personal"
      || server.isDeleted === true
      || server.entryKind !== "markdown"
      || server.contentFormat !== "markdown-v1"
      || (server.folderId ?? null) !== sourceFolderId
      || server.participantUids.length !== 1
      || server.participantUids[0] !== ownerUid
    ) {
      throw new Error("서버에서 개인 Markdown 노트 상태를 확인하지 못해 이미지 저장을 중단했습니다.");
    }
  };
  const pasteResult = (
    sourceTitles: readonly string[],
    commitNotice: () => void
  ): MarkdownImagePasteResult => {
    if (!assetDestination) {
      throw new Error("붙여넣은 이미지의 저장 경로를 확인할 수 없습니다.");
    }
    const destination = assetDestination;
    const { folderPath } = destination;
    const source = vaultClipboardImageEmbedSource(sourceTitles.map(
      (title) => `${folderPath}/${title}`
    ));
    let committed = false;
    let commitAccepted = false;
    return {
      onCommit: async () => {
        if (committed) return commitAccepted;
        committed = true;
        let persisted = false;
        try {
          throwIfCancelled();
          assertAssetDestinationCurrent(destination);
          await confirmAssetDestination(destination);
          throwIfCancelled();
          assertAssetDestinationCurrent(destination);
          persisted = await commitSource(source, destination);
        } catch {
          persisted = false;
        }
        if (!persisted) {
          // The source write may have reached the server even when its response
          // was lost. Keep the encrypted assets, but ask the editor to restore
          // the exact text selection that this embed replaced. The ordinary
          // autosave then converges either server outcome without holding a
          // folder lock across background/offline sessions.
          await releaseDestination();
          setError("이미지 링크의 서버 저장을 확인하지 못해 방금 넣은 링크를 되돌렸습니다. 암호화된 이미지는 '붙여넣은 이미지' 폴더에 보존했습니다.");
          return false;
        }
        await releaseDestination();
        commitNotice();
        commitAccepted = true;
        return true;
      },
      onDiscard: discardPaste,
      onRollback: (rollback) => rollback.source === source && rollbackSource(rollback),
      source
    };
  };

  try {
    throwIfCancelled();
    const preflightController = new AbortController();
    let firstPreflightFailure: unknown;
    let hasPreflightFailure = false;
    const failPreflight = (caught: unknown): never => {
      if (!hasPreflightFailure) {
        firstPreflightFailure = caught;
        hasPreflightFailure = true;
      }
      if (!preflightController.signal.aborted) {
        preflightController.abort(caught);
      }
      throw caught;
    };
    const abortPreflightFromCaller = () => {
      const reason = signal.reason
        ?? new DOMException("이미지 추가가 취소되었습니다.", "AbortError");
      if (!hasPreflightFailure) {
        firstPreflightFailure = reason;
        hasPreflightFailure = true;
      }
      if (!preflightController.signal.aborted) {
        preflightController.abort(reason);
      }
    };
    signal.addEventListener("abort", abortPreflightFromCaller, { once: true });
    if (signal.aborted) abortPreflightFromCaller();
    try {
      const [preparedResult] = await Promise.allSettled([
        prepareVaultClipboardImages(files, { signal: preflightController.signal })
          .catch(failPreflight),
        assertSourceRemainsPrivate(preflightController.signal)
          .catch(failPreflight)
      ]);
      if (preparedResult.status === "fulfilled") prepared = preparedResult.value;
      if (hasPreflightFailure) throw firstPreflightFailure;
    } finally {
      signal.removeEventListener("abort", abortPreflightFromCaller);
    }
    throwIfCancelled();
    assetDestination = await resolveAssetDestination(signal);
    throwIfCancelled();
    if (
      !assetDestination.folderId
      || assetDestination.folderId.length > 120
      || assetDestination.folderId.includes("/")
      || !Number.isSafeInteger(assetDestination.folderRevision)
      || assetDestination.folderRevision < 1
      || !/^vpl1_[A-Za-z0-9_-]{43}$/u.test(assetDestination.lockId)
      || !assetDestination.holderId
      || normalizeVaultPath(assetDestination.folderPath) !== assetDestination.folderPath
    ) {
      throw new Error("붙여넣은 이미지의 저장 경로가 올바르지 않습니다.");
    }
    assertAssetDestinationCurrent(assetDestination);
    const folderId = assetDestination.folderId;
    const destinationLockId = assetDestination.lockId;
    const knownConflictingTitles = new Set<string>();
    const currentAssetTitles = () => [
      ...getNotes()
        .filter((candidate) => (
          candidate.ownerUid === ownerUid
          && candidate.entryKind === "asset"
          && (candidate.folderId ?? null) === folderId
        ))
        .map((candidate) => candidate.title),
      ...[...pendingAssetTitleKeys.values()]
        .filter((reservation) => reservation.folderId === folderId)
        .map((reservation) => reservation.title),
      ...knownConflictingTitles
    ];
    const titles = reserveVaultClipboardImageTitles(
      currentAssetTitles(),
      prepared,
      sourceTitle
    );
    const reserveTitle = (title: string) => {
      const titleKey = clipboardAssetTitleReservationKey(folderId, title);
      if (pendingAssetTitleKeys.has(titleKey)) {
        throw new Error("동시에 추가한 이미지 이름을 안전하게 예약하지 못했습니다. 다시 시도해주세요.");
      }
      reservedTitleKeys.add(titleKey);
      pendingAssetTitleKeys.set(titleKey, {
        folderId,
        sourceNoteId: note.id,
        title
      });
      return titleKey;
    };
    for (const title of titles) {
      reserveTitle(title);
    }
    setError(null);
    setStatus(prepared.length > 1
      ? `${prepared.length}개 이미지를 Vault에서 암호화하는 중입니다…`
      : "이미지를 Vault에서 암호화하는 중입니다…");

    let nextImageIndex = 0;
    const failures: unknown[] = [];
    const createWorker = async () => {
      while (failures.length === 0 && !signal.aborted) {
        const index = nextImageIndex;
        nextImageIndex += 1;
        if (index >= prepared.length) return;
        const image = prepared[index];
        let title = titles[index];
        let titleKey = clipboardAssetTitleReservationKey(folderId, title);
        let conflictRetryCount = 0;
        while (failures.length === 0 && !signal.aborted) {
          try {
            throwIfCancelled();
            const result = await createEncryptedVaultAsset(profile, integrityKey, {
              bytes: image.bytes,
              folderId,
              mimeType: image.mimeType,
              title,
              vaultPasteLockId: destinationLockId
            });
            pendingCreatedEntryIds.add(result.noteId);
            pendingClipboardAssetIds.add(result.noteId);
            pendingAssetTitleKeyById.set(result.noteId, titleKey);
            createdAssets[index] = {
              noteId: result.noteId,
              revision: result.revision,
              title,
              titleKey,
              vaultPasteLockId: destinationLockId
            };
            const alreadyAcknowledged = getNotes().some((candidate) => (
              candidate.id === result.noteId
              && candidate.ownerUid === ownerUid
              && candidate.entryKind === "asset"
              && (candidate.folderId ?? null) === folderId
              && candidate.title === title
            ));
            if (alreadyAcknowledged) {
              pendingCreatedEntryIds.delete(result.noteId);
              pendingAssetTitleKeyById.delete(result.noteId);
              pendingAssetTitleKeys.delete(titleKey);
              pendingClipboardAssetIds.delete(result.noteId);
            }
            throwIfCancelled();
            break;
          } catch (caught) {
            if (
              caught instanceof VaultNameConflictError
              && conflictRetryCount < MAXIMUM_CLIPBOARD_ASSET_NAME_CONFLICT_RETRIES
              && !signal.aborted
            ) {
              conflictRetryCount += 1;
              knownConflictingTitles.add(title);
              pendingAssetTitleKeys.delete(titleKey);
              [title] = reserveVaultClipboardImageTitles(
                currentAssetTitles(),
                [image],
                sourceTitle
              );
              titles[index] = title;
              titleKey = reserveTitle(title);
              continue;
            }
            if (failures.length === 0) failures.push(caught);
            break;
          }
        }
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(MAXIMUM_CONCURRENT_CLIPBOARD_ASSET_WRITES, prepared.length) },
      createWorker
    ));
    throwIfCancelled();
    discardOnFailure = true;
    await assertSourceRemainsPrivate();
    assertAssetDestinationCurrent(assetDestination);
    discardOnFailure = false;
    if (failures.length > 0) throw failures[0];
    const titlesForSource = createdTitles();
    return pasteResult(titlesForSource, () => {
      setStatus(titlesForSource.length > 1
        ? `${titlesForSource.length}개 이미지를 asset-v1로 암호화해 붙여넣었습니다.`
        : "이미지를 asset-v1로 암호화해 붙여넣었습니다.");
    });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "이미지를 암호화해 저장하지 못했습니다.";
    if (signal.aborted || discardOnFailure) {
      await discardPaste();
      if (!signal.aborted) setError(message);
      return null;
    }
    const titlesForSource = createdTitles();
    if (titlesForSource.length) {
      return pasteResult(titlesForSource, () => {
        setError(`${message} 먼저 저장된 이미지 ${titlesForSource.length}개만 본문에 넣었습니다.`);
      });
    }
    setError(message);
    await releaseDestination();
    return null;
  } finally {
    for (const titleKey of reservedTitleKeys) {
      if (![...createdAssets].some((asset) => asset?.titleKey === titleKey)) {
        pendingAssetTitleKeys.delete(titleKey);
      }
    }
    clearPreparedVaultClipboardImages(prepared);
  }
}
