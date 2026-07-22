import {
  collection,
  doc,
  getDoc,
  limit as queryLimit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  where
} from "firebase/firestore";
import { db } from "../lib/firebase";
import { generateNoteKey, unwrapNoteKey, wrapNoteKey } from "../lib/crypto";
import {
  decryptLibraryItemContent,
  encryptLibraryItemContent,
  libraryAttachmentFingerprint,
  libraryUrlFingerprint,
  nextLibraryId,
  normalizeLibraryItemContent
} from "../lib/libraryContent";
import type {
  EncryptedPayload,
  LibraryCaptureSource,
  LibraryItemContent,
  LibraryItemDocument,
  LibraryItemKind,
  LibraryItemStatus,
  LibraryVaultDocument,
  WrappedNoteKey
} from "../types";

export interface LibraryItemSnapshot extends LibraryItemDocument {
  id: string;
}

export interface DecryptedLibraryItem extends LibraryItemSnapshot {
  content: LibraryItemContent;
  itemKey: CryptoKey;
}

export interface CreateLibraryItemInput {
  uid: string;
  publicKeyJwk: JsonWebKey;
  privateKey: CryptoKey;
  kind: LibraryItemKind;
  content: LibraryItemContent;
  status?: LibraryItemStatus;
  captureSource?: LibraryCaptureSource;
  isFavorite?: boolean;
  sourceNoteId?: string | null;
  sourceAttachmentId?: string | null;
}

export interface UpdateLibraryItemInput {
  content?: LibraryItemContent;
  status?: LibraryItemStatus;
  isFavorite?: boolean;
}

export interface LibraryDecryptResult {
  items: DecryptedLibraryItem[];
  failedItemIds: string[];
}

export class LibraryItemRevisionConflictError extends Error {
  readonly code = "library-item/revision-conflict";

  constructor() {
    super("자료가 다른 곳에서 변경되었습니다. 최신 내용을 확인한 뒤 다시 시도해주세요.");
    this.name = "LibraryItemRevisionConflictError";
  }
}

export class DuplicateLibraryItemError extends Error {
  readonly code = "library-item/duplicate";
  readonly itemId: string;

  constructor(itemId: string) {
    super("이미 자료실에 저장된 자료입니다.");
    this.name = "DuplicateLibraryItemError";
    this.itemId = itemId;
  }
}

const validStatuses = new Set<LibraryItemStatus>(["inbox", "reading", "archived"]);
const vaultKeyCache = new WeakMap<CryptoKey, Map<string, CryptoKey>>();
const libraryDecryptConcurrency = 4;
export const libraryInitialSubscriptionLimit = 120;
export const librarySubscriptionStep = 120;
export const libraryMaximumSubscriptionLimit = 1_200;

function libraryVaultRef(uid: string) {
  return doc(db, "libraryVaults", uid);
}

function libraryItemRef(itemId: string) {
  return doc(db, "libraryItems", itemId);
}

function normalizeSourceId(value: string | null | undefined) {
  const normalized = value?.trim() ?? "";

  if (!normalized) {
    return null;
  }

  if (!/^[A-Za-z0-9_-]{1,180}$/u.test(normalized)) {
    throw new Error("원본 자료 식별자를 확인할 수 없습니다.");
  }

  return normalized;
}

function validateCreateInput(input: CreateLibraryItemInput, content: LibraryItemContent) {
  if (!input.uid || !input.publicKeyJwk || !input.privateKey) {
    throw new Error("자료실 암호화 세션을 확인할 수 없습니다.");
  }

  if (input.kind === "link" && !content.url) {
    throw new Error("http 또는 https 링크를 입력해주세요.");
  }

  if (input.kind === "attachment") {
    if (!normalizeSourceId(input.sourceNoteId) || !normalizeSourceId(input.sourceAttachmentId)) {
      throw new Error("원본 노트 첨부파일을 확인할 수 없습니다.");
    }
    if (input.captureSource !== "attachment-ocr") {
      throw new Error("첨부파일 자료의 생성 경로를 확인할 수 없습니다.");
    }
  }

  if (input.captureSource === "attachment-ocr" && input.kind !== "attachment") {
    throw new Error("첨부파일 OCR 자료의 종류를 확인할 수 없습니다.");
  }
}

function isPermissionDenied(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }

  const code = (error as { code?: unknown }).code;
  return code === "permission-denied" || code === "firestore/permission-denied";
}

async function getOrCreateLibraryVaultKey(
  uid: string,
  publicKeyJwk: JsonWebKey,
  privateKey: CryptoKey
) {
  const cached = vaultKeyCache.get(privateKey)?.get(uid);

  if (cached) {
    return cached;
  }

  const candidateKey = await generateNoteKey();
  const candidateWrappedKey = await wrapNoteKey(candidateKey, publicKeyJwk);
  const selected = await runTransaction(db, async (transaction) => {
    const reference = libraryVaultRef(uid);
    const snapshot = await transaction.get(reference);

    if (snapshot.exists()) {
      const value = snapshot.data() as Partial<LibraryVaultDocument>;

      if (value.ownerUid !== uid || !value.wrappedKey) {
        throw new Error("자료실 암호화 키 문서를 확인할 수 없습니다.");
      }

      return { created: false, wrappedKey: value.wrappedKey };
    }

    transaction.set(reference, {
      ownerUid: uid,
      wrappedKey: candidateWrappedKey,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    return { created: true, wrappedKey: candidateWrappedKey };
  });

  const vaultKey = selected.created ? candidateKey : await unwrapNoteKey(selected.wrappedKey, privateKey);
  const keyCache = vaultKeyCache.get(privateKey) ?? new Map<string, CryptoKey>();

  keyCache.set(uid, vaultKey);
  vaultKeyCache.set(privateKey, keyCache);
  return vaultKey;
}

export function subscribeLibraryItems(
  uid: string,
  callback: (items: LibraryItemSnapshot[]) => void,
  onError?: (error: Error) => void,
  maximumItems = libraryInitialSubscriptionLimit
) {
  const boundedMaximum = Math.min(
    libraryMaximumSubscriptionLimit,
    Math.max(1, Math.floor(maximumItems))
  );
  const itemsQuery = query(
    collection(db, "libraryItems"),
    where("ownerUid", "==", uid),
    orderBy("updatedAt", "desc"),
    queryLimit(boundedMaximum)
  );

  return onSnapshot(
    itemsQuery,
    (snapshot) => callback(snapshot.docs.map((item) => ({ id: item.id, ...(item.data() as LibraryItemDocument) }))),
    (error) => onError?.(error)
  );
}

export async function decryptLibraryItem(
  item: LibraryItemSnapshot,
  uid: string,
  privateKey: CryptoKey
): Promise<DecryptedLibraryItem> {
  if (item.ownerUid !== uid) {
    throw new Error("자료 소유자를 확인할 수 없습니다.");
  }

  const wrappedKey = item.wrappedKeys?.[uid];

  if (!wrappedKey || Object.keys(item.wrappedKeys).some((keyUid) => keyUid !== uid)) {
    throw new Error("자료 암호화 키를 확인할 수 없습니다.");
  }

  const itemKey = await unwrapNoteKey(wrappedKey, privateKey);
  const content = await decryptLibraryItemContent(item.encryptedContent, itemKey);

  return { ...item, content, itemKey };
}

export async function decryptLibraryItems(
  items: LibraryItemSnapshot[],
  uid: string,
  privateKey: CryptoKey
): Promise<LibraryDecryptResult> {
  const decryptedByIndex = new Map<number, DecryptedLibraryItem>();
  const failedItemIds: string[] = [];
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;

      try {
        decryptedByIndex.set(index, await decryptLibraryItem(items[index], uid, privateKey));
      } catch {
        failedItemIds.push(items[index].id);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(libraryDecryptConcurrency, items.length) }, () => worker()));
  const decrypted = Array.from(decryptedByIndex.entries())
    .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
    .map(([, item]) => item);

  return { items: decrypted, failedItemIds };
}

export async function createLibraryItem(input: CreateLibraryItemInput) {
  const content = normalizeLibraryItemContent(input.content);
  validateCreateInput(input, content);
  const sourceNoteId = normalizeSourceId(input.sourceNoteId);
  const sourceAttachmentId = normalizeSourceId(input.sourceAttachmentId);

  const [vaultKey, itemKey] = await Promise.all([
    getOrCreateLibraryVaultKey(input.uid, input.publicKeyJwk, input.privateKey),
    generateNoteKey()
  ]);
  const [urlFingerprint, attachmentFingerprint, wrappedKey, encryptedContent] = await Promise.all([
    content.url ? libraryUrlFingerprint(content.url, vaultKey) : Promise.resolve(null),
    input.kind === "attachment" && sourceNoteId && sourceAttachmentId
      ? libraryAttachmentFingerprint(sourceNoteId, sourceAttachmentId, vaultKey)
      : Promise.resolve(null),
    wrapNoteKey(itemKey, input.publicKeyJwk),
    encryptLibraryItemContent(content, itemKey)
  ]);
  const itemId = input.kind === "link" && urlFingerprint
    ? `link-${urlFingerprint}`
    : input.kind === "attachment" && attachmentFingerprint
      ? `attachment-${attachmentFingerprint}`
      : nextLibraryId();
  const reference = libraryItemRef(itemId);
  const generationId = nextLibraryId();
  const lastMutationId = nextLibraryId();
  const status = validStatuses.has(input.status as LibraryItemStatus) ? (input.status as LibraryItemStatus) : "inbox";

  try {
    await setDoc(reference, {
      ownerUid: input.uid,
      generationId,
      kind: input.kind,
      status,
      captureSource: input.captureSource ?? "manual",
      isFavorite: input.isFavorite ?? false,
      encryptedContent,
      wrappedKeys: { [input.uid]: wrappedKey },
      urlFingerprint,
      sourceNoteId,
      sourceAttachmentId,
      revision: 1,
      lastMutationId,
      reviewCount: 0,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      lastOpenedAt: null,
      lastReviewedAt: null
    });
  } catch (writeError) {
    if (!isPermissionDenied(writeError)) {
      throw writeError;
    }

    try {
      const existing = await getDoc(reference);

      if (existing.exists()) {
        const value = existing.data() as Partial<LibraryItemDocument>;

        if (value.ownerUid === input.uid) {
          throw new DuplicateLibraryItemError(existing.id);
        }
      }
    } catch (lookupError) {
      if (lookupError instanceof DuplicateLibraryItemError) {
        throw lookupError;
      }
    }

    throw writeError;
  }

  return { content, id: itemId, itemKey, lastMutationId, revision: 1 };
}

async function commitLibraryItemMutation(
  itemId: string,
  uid: string,
  expectedRevision: number,
  expectedLastMutationId: string,
  expectedGenerationId: string,
  buildUpdate: (current: LibraryItemDocument) => Record<string, unknown>
) {
  const reference = libraryItemRef(itemId);
  const lastMutationId = nextLibraryId();

  return runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(reference);

    if (!snapshot.exists()) {
      throw new LibraryItemRevisionConflictError();
    }

    const current = snapshot.data() as LibraryItemDocument;

    if (!libraryMutationPreconditionMatches(
      current,
      uid,
      expectedRevision,
      expectedLastMutationId,
      expectedGenerationId
    )) {
      throw new LibraryItemRevisionConflictError();
    }

    const revision = current.revision + 1;
    transaction.update(reference, {
      ...buildUpdate(current),
      lastMutationId,
      revision,
      updatedAt: serverTimestamp()
    });

    return { lastMutationId, revision };
  });
}

export async function updateLibraryItem(
  item: Pick<
    DecryptedLibraryItem,
    "generationId" | "id" | "itemKey" | "lastMutationId" | "ownerUid" | "revision"
  >,
  uid: string,
  input: UpdateLibraryItemInput
) {
  if (item.ownerUid !== uid) {
    throw new Error("자료 소유자를 확인할 수 없습니다.");
  }

  const encryptedContent = input.content
    ? await encryptLibraryItemContent(normalizeLibraryItemContent(input.content), item.itemKey)
    : null;

  return commitLibraryItemMutation(
    item.id,
    uid,
    item.revision,
    item.lastMutationId,
    item.generationId,
    () => ({
      ...(encryptedContent ? { encryptedContent } : {}),
      ...(input.status && validStatuses.has(input.status) ? { status: input.status } : {}),
      ...(typeof input.isFavorite === "boolean" ? { isFavorite: input.isFavorite } : {})
    })
  );
}

export function touchLibraryItemOpened(
  itemId: string,
  uid: string,
  expectedRevision: number,
  expectedLastMutationId: string,
  expectedGenerationId: string
) {
  return commitLibraryItemMutation(itemId, uid, expectedRevision, expectedLastMutationId, expectedGenerationId, () => ({
    lastOpenedAt: serverTimestamp()
  }));
}

export function markLibraryItemReviewed(
  itemId: string,
  uid: string,
  expectedRevision: number,
  expectedLastMutationId: string,
  expectedGenerationId: string
) {
  return commitLibraryItemMutation(itemId, uid, expectedRevision, expectedLastMutationId, expectedGenerationId, (current) => ({
    lastReviewedAt: serverTimestamp(),
    reviewCount: current.reviewCount + 1,
    status: current.status === "inbox" ? "reading" : current.status
  }));
}

export async function deleteLibraryItem(
  itemId: string,
  uid: string,
  expectedRevision: number,
  expectedLastMutationId: string,
  expectedGenerationId: string
) {
  const reference = libraryItemRef(itemId);

  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(reference);

    if (!snapshot.exists()) {
      return;
    }

    const current = snapshot.data() as LibraryItemDocument;

    if (!libraryMutationPreconditionMatches(
      current,
      uid,
      expectedRevision,
      expectedLastMutationId,
      expectedGenerationId
    )) {
      throw new LibraryItemRevisionConflictError();
    }

    transaction.delete(reference);
  });
}

export function libraryMutationPreconditionMatches(
  current: Pick<LibraryItemDocument, "generationId" | "lastMutationId" | "ownerUid" | "revision">,
  uid: string,
  expectedRevision: number,
  expectedLastMutationId: string,
  expectedGenerationId: string
) {
  return current.ownerUid === uid
    && current.revision === expectedRevision
    && current.lastMutationId === expectedLastMutationId
    && current.generationId === expectedGenerationId;
}

export function encryptedLibraryContentForTest(content: LibraryItemContent, key: CryptoKey): Promise<EncryptedPayload> {
  return encryptLibraryItemContent(content, key);
}

export type LibraryWrappedKeyForTest = WrappedNoteKey;
