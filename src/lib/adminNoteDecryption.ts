import { decryptText, unwrapNoteKey } from "./crypto";
import {
  parseEditorContent,
  parseReadonlyEditorContent,
  previewTextFromHtml,
  type ReadonlyEditorContentFormat
} from "./editorContent";
import { mapWithConcurrency } from "./mapWithConcurrency";
import type { NoteSnapshot } from "../services/notes";
import type { WrappedNoteKey } from "../types";

export const adminNoteDecryptConcurrency = 4;
const adminNotePreviewMaxCharacters = 240;

export interface AdminNoteContent {
  bodyFormat: ReadonlyEditorContentFormat;
  title: string;
  bodyHtml: string;
  bodyPreview: string;
  bodySearchText: string;
  fontSize: number;
  canReadContent: boolean;
  unavailableReason: string | null;
}

export interface AdminNoteView extends NoteSnapshot, AdminNoteContent {}

export type AdminNoteDecryptor = (
  note: NoteSnapshot,
  uid: string,
  privateKey: CryptoKey
) => Promise<AdminNoteContent>;

interface AdminNoteCacheEntry {
  content: AdminNoteContent;
  encryptedBody: NoteSnapshot["encryptedBody"];
  encryptedTitle: NoteSnapshot["encryptedTitle"];
  wrappedKey: WrappedNoteKey | undefined;
}

interface AdminNoteCacheRun {
  version: number;
}

function sameEncryptedPayload(
  left: NoteSnapshot["encryptedTitle"],
  right: NoteSnapshot["encryptedTitle"]
) {
  return left.version === right.version
    && left.algorithm === right.algorithm
    && left.cipherText === right.cipherText
    && left.iv === right.iv;
}

function sameWrappedKey(left: WrappedNoteKey | undefined, right: WrappedNoteKey | undefined) {
  return left === undefined
    ? right === undefined
    : right !== undefined
      && left.version === right.version
      && left.algorithm === right.algorithm
      && left.wrappedKey === right.wrappedKey;
}

function unavailableContent(reason: string, title = "암호화된 노트"): AdminNoteContent {
  return {
    title,
    bodyFormat: "html",
    bodyHtml: "",
    bodyPreview: reason,
    bodySearchText: reason,
    fontSize: 17,
    canReadContent: false,
    unavailableReason: reason
  };
}

function adminNotePreviewText(value: string) {
  const normalizedValue = value.replace(/\s+/g, " ").trim();

  if (normalizedValue.length <= adminNotePreviewMaxCharacters) {
    return normalizedValue;
  }

  return `${normalizedValue.slice(0, adminNotePreviewMaxCharacters).trimEnd()}...`;
}

export function lockedAdminNoteView(note: NoteSnapshot, hasPrivateKey: boolean): AdminNoteView {
  const reason = hasPrivateKey
    ? "관리자가 공유 대상에 포함되지 않아 본문을 복호화할 수 없습니다."
    : "암호화 키가 잠겨 있어 본문을 표시할 수 없습니다.";
  return { ...note, ...unavailableContent(reason) };
}

export async function decryptAdminNoteContent(
  note: NoteSnapshot,
  uid: string,
  privateKey: CryptoKey
): Promise<AdminNoteContent> {
  const wrappedKey = note.wrappedKeys[uid];

  if (!wrappedKey) {
    return unavailableContent("관리자가 공유 대상에 포함되지 않아 본문을 복호화할 수 없습니다.");
  }

  try {
    const noteKey = await unwrapNoteKey(wrappedKey, privateKey);
    const [title, body] = await Promise.all([
      decryptText(note.encryptedTitle, noteKey),
      decryptText(note.encryptedBody, noteKey)
    ]);
    const parsedBody = parseEditorContent(body);
    const readonlyBody = parseReadonlyEditorContent(body);
    const previewText = previewTextFromHtml(body);
    const emptyPreviewText = /<img\b/i.test(parsedBody.html) ? "이미지가 포함된 노트" : "본문 없음";

    return {
      title,
      bodyFormat: readonlyBody.contentFormat,
      bodyHtml: readonlyBody.content,
      bodyPreview: adminNotePreviewText(previewText) || emptyPreviewText,
      bodySearchText: previewText || emptyPreviewText,
      fontSize: parsedBody.fontSize,
      canReadContent: true,
      unavailableReason: null
    };
  } catch {
    return unavailableContent(
      "키가 변경되었거나 이 계정으로 열 수 없는 노트입니다.",
      "복호화할 수 없는 노트"
    );
  }
}

export class AdminNoteDecryptionCache {
  private readonly entries = new Map<string, AdminNoteCacheEntry>();
  private privateKey: CryptoKey | null = null;
  private runVersion = 0;
  private uid: string | null = null;

  beginRun(uid: string, privateKey: CryptoKey): AdminNoteCacheRun {
    if (this.uid !== uid || this.privateKey !== privateKey) {
      this.entries.clear();
      this.uid = uid;
      this.privateKey = privateKey;
    }

    this.runVersion += 1;
    return { version: this.runVersion };
  }

  clear() {
    this.entries.clear();
    this.privateKey = null;
    this.uid = null;
    this.runVersion += 1;
  }

  get(run: AdminNoteCacheRun, note: NoteSnapshot, uid: string) {
    if (!this.isActive(run)) {
      return undefined;
    }

    const entry = this.entries.get(note.id);
    if (
      !entry
      || !sameEncryptedPayload(entry.encryptedTitle, note.encryptedTitle)
      || !sameEncryptedPayload(entry.encryptedBody, note.encryptedBody)
      || !sameWrappedKey(entry.wrappedKey, note.wrappedKeys[uid])
    ) {
      return undefined;
    }

    return entry.content;
  }

  prune(run: AdminNoteCacheRun, noteIds: ReadonlySet<string>) {
    if (!this.isActive(run)) {
      return;
    }

    for (const noteId of this.entries.keys()) {
      if (!noteIds.has(noteId)) {
        this.entries.delete(noteId);
      }
    }
  }

  set(
    run: AdminNoteCacheRun,
    note: NoteSnapshot,
    uid: string,
    content: AdminNoteContent
  ) {
    if (!this.isActive(run)) {
      return;
    }

    this.entries.set(note.id, {
      content,
      encryptedBody: note.encryptedBody,
      encryptedTitle: note.encryptedTitle,
      wrappedKey: note.wrappedKeys[uid]
    });
  }

  private isActive(run: AdminNoteCacheRun) {
    return run.version === this.runVersion;
  }
}

export async function resolveAdminNoteViews({
  cache,
  concurrency = adminNoteDecryptConcurrency,
  decryptor = decryptAdminNoteContent,
  notes,
  onPending,
  privateKey,
  uid
}: {
  cache: AdminNoteDecryptionCache;
  concurrency?: number;
  decryptor?: AdminNoteDecryptor;
  notes: readonly NoteSnapshot[];
  onPending?: (views: AdminNoteView[]) => void;
  privateKey: CryptoKey;
  uid: string;
}) {
  const run = cache.beginRun(uid, privateKey);
  cache.prune(run, new Set(notes.map((note) => note.id)));
  const contents = new Array<AdminNoteContent | undefined>(notes.length);
  const missing: Array<{ index: number; note: NoteSnapshot }> = [];

  notes.forEach((note, index) => {
    const cached = cache.get(run, note, uid);
    if (cached) {
      contents[index] = cached;
    } else {
      missing.push({ index, note });
    }
  });

  onPending?.(notes.map((note, index) => {
    const content = contents[index];
    return content
      ? { ...note, ...content }
      : { ...note, ...unavailableContent("노트 본문을 안전하게 확인하는 중입니다.") };
  }));

  await mapWithConcurrency(missing, concurrency, async ({ index, note }) => {
    const content = await decryptor(note, uid, privateKey);
    contents[index] = content;
    cache.set(run, note, uid, content);
    return undefined;
  });

  return notes.map((note, index) => {
    const content = contents[index];
    return content ? { ...note, ...content } : lockedAdminNoteView(note, true);
  });
}
