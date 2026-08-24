import type { UserProfile } from "../../types";
import {
  deleteRevisionedNote,
  getVisibleNotesByIdsFromServer
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
import { createEncryptedVaultAsset } from "./vaultPersistence";

const MAXIMUM_CONCURRENT_CLIPBOARD_ASSET_WRITES = 3;

export interface PendingClipboardAssetReservation {
  folderId: string | null;
  sourceNoteId: string;
  title: string;
}

export interface VaultClipboardPasteFlowInput {
  files: readonly File[];
  getNotes: () => readonly DecryptedVaultNote[];
  integrityKey: CryptoKey;
  note: DecryptedVaultNote;
  pendingAssetTitleKeyById: Map<string, string>;
  pendingAssetTitleKeys: Map<string, PendingClipboardAssetReservation>;
  pendingCreatedEntryIds: Set<string>;
  profile: UserProfile;
  setError: (message: string | null) => void;
  setStatus: (message: string) => void;
  signal: MarkdownImagePasteContext["signal"];
  sourceFolderId: string | null;
}

function clipboardAssetTitleReservationKey(folderId: string | null, title: string) {
  return JSON.stringify([
    folderId,
    title.normalize("NFC").toLocaleLowerCase("en-US")
  ]);
}

export async function pasteVaultClipboardImages({
  files,
  getNotes,
  integrityKey,
  note,
  pendingAssetTitleKeyById,
  pendingAssetTitleKeys,
  pendingCreatedEntryIds,
  profile,
  setError,
  setStatus,
  signal,
  sourceFolderId
}: VaultClipboardPasteFlowInput): Promise<MarkdownImagePasteResult | null> {
  const ownerUid = profile.uid;
  let prepared: PreparedVaultClipboardImage[] = [];
  const createdAssets: Array<{
    noteId: string;
    revision: number;
    title: string;
    titleKey: string;
  } | undefined> = [];
  const reservedTitleKeys = new Set<string>();
  let discardOnFailure = false;
  let discardPromise: Promise<void> | null = null;
  const discardCreatedAssets = () => {
    discardPromise ??= (async () => {
      const assets = createdAssets.filter((asset): asset is NonNullable<typeof asset> => Boolean(asset));
      const results = await Promise.allSettled(assets.map(async (asset) => {
        await deleteRevisionedNote({
          expectedRevision: asset.revision,
          noteId: asset.noteId,
          readerUids: [ownerUid],
          uid: ownerUid
        });
        pendingCreatedEntryIds.delete(asset.noteId);
        pendingAssetTitleKeyById.delete(asset.noteId);
        pendingAssetTitleKeys.delete(asset.titleKey);
      }));
      const failedCount = results.filter((result) => result.status === "rejected").length;
      if (failedCount > 0) {
        setError(`취소된 이미지 붙여넣기에서 ${failedCount}개 asset을 자동으로 휴지통에 옮기지 못했습니다. Vault에서 직접 확인해주세요.`);
      }
    })();
    return discardPromise;
  };
  const throwIfCancelled = () => {
    if (signal.aborted) {
      throw new DOMException("이미지 붙여넣기가 취소되었습니다.", "AbortError");
    }
  };
  const createdTitles = () => createdAssets.flatMap((asset) => asset ? [asset.title] : []);
  const assertSourceRemainsPrivate = async () => {
    throwIfCancelled();
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
      throw new Error("붙여넣는 동안 노트의 소유권이나 공유 상태가 변경되어 이미지 저장을 중단했습니다.");
    }
    const serverRead = await getVisibleNotesByIdsFromServer(ownerUid, [note.id]);
    throwIfCancelled();
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
  ): MarkdownImagePasteResult => ({
    onCommit: commitNotice,
    onDiscard: discardCreatedAssets,
    source: vaultClipboardImageEmbedSource(sourceTitles)
  });

  try {
    throwIfCancelled();
    const [preparedResult, sourceCheckResult] = await Promise.allSettled([
      prepareVaultClipboardImages(files),
      assertSourceRemainsPrivate()
    ]);
    if (preparedResult.status === "fulfilled") prepared = preparedResult.value;
    if (sourceCheckResult.status === "rejected") throw sourceCheckResult.reason;
    if (preparedResult.status === "rejected") throw preparedResult.reason;
    throwIfCancelled();
    const folderId = sourceFolderId;
    const titles = reserveVaultClipboardImageTitles(
      [
        ...getNotes()
          .filter((candidate) => (
            candidate.ownerUid === ownerUid
            && candidate.entryKind === "asset"
            && (candidate.folderId ?? null) === folderId
          ))
          .map((candidate) => candidate.title),
        ...[...pendingAssetTitleKeys.values()]
          .filter((reservation) => reservation.folderId === folderId)
          .map((reservation) => reservation.title)
      ],
      prepared
    );
    for (const title of titles) {
      const titleKey = clipboardAssetTitleReservationKey(folderId, title);
      if (pendingAssetTitleKeys.has(titleKey)) {
        throw new Error("동시에 붙여넣은 이미지 이름을 안전하게 예약하지 못했습니다. 다시 시도해주세요.");
      }
      reservedTitleKeys.add(titleKey);
      pendingAssetTitleKeys.set(titleKey, {
        folderId,
        sourceNoteId: note.id,
        title
      });
    }
    setError(null);
    setStatus(prepared.length > 1
      ? `${prepared.length}개 이미지를 Vault에서 암호화하는 중입니다…`
      : "붙여넣은 이미지를 Vault에서 암호화하는 중입니다…");

    let nextImageIndex = 0;
    const failures: unknown[] = [];
    const createWorker = async () => {
      while (failures.length === 0 && !signal.aborted) {
        const index = nextImageIndex;
        nextImageIndex += 1;
        if (index >= prepared.length) return;
        const image = prepared[index];
        const title = titles[index];
        const titleKey = clipboardAssetTitleReservationKey(folderId, title);
        try {
          throwIfCancelled();
          const result = await createEncryptedVaultAsset(profile, integrityKey, {
            bytes: image.bytes,
            folderId,
            mimeType: image.mimeType,
            title
          });
          pendingCreatedEntryIds.add(result.noteId);
          pendingAssetTitleKeyById.set(result.noteId, titleKey);
          createdAssets[index] = {
            noteId: result.noteId,
            revision: result.revision,
            title,
            titleKey
          };
          throwIfCancelled();
        } catch (caught) {
          if (failures.length === 0) failures.push(caught);
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
    discardOnFailure = false;
    if (failures.length > 0) throw failures[0];
    const titlesForSource = createdTitles();
    return pasteResult(titlesForSource, () => {
      setStatus(titlesForSource.length > 1
        ? `${titlesForSource.length}개 이미지를 asset-v1로 암호화해 붙여넣었습니다.`
        : "이미지를 asset-v1로 암호화해 붙여넣었습니다.");
    });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "붙여넣은 이미지를 암호화해 저장하지 못했습니다.";
    if (signal.aborted || discardOnFailure) {
      await discardCreatedAssets();
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
