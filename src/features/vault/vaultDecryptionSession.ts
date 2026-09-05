import { decryptText, unwrapNoteKey } from "../../lib/crypto";
import type { NoteFolderSnapshot, NoteSnapshot } from "../../services/notes";
import type { EncryptedPayload, WrappedNoteKey } from "../../types";

const DEFAULT_MAX_ENTRIES = 5_000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const MAX_QUEUED_CRYPTO = 128;
const CRYPTO_CONCURRENCY = 4;

type FieldName = "title" | "body" | "name";
interface CachedField {
  payload: EncryptedPayload;
  promise: Promise<string>;
  pending: boolean;
  bytes: number;
}
interface CachedEntry {
  id: string;
  authority: string;
  wrappedKey: WrappedNoteKey;
  controller: AbortController;
  fields: Map<FieldName, CachedField>;
  key: CryptoKey | null;
  keyPromise: Promise<CryptoKey> | null;
  consumers: number;
  bytes: number;
}
interface QueuedCrypto {
  run: () => void;
  cancel: () => void;
}

function abortError() {
  return new DOMException("The decryption session is no longer active.", "AbortError");
}

function samePayload(left: EncryptedPayload, right: EncryptedPayload) {
  return left.version === right.version && left.algorithm === right.algorithm
    && left.iv === right.iv && left.cipherText === right.cipherText;
}

function validPayload(value: EncryptedPayload) {
  return value?.version === 1 && value.algorithm === "AES-GCM"
    && typeof value.cipherText === "string" && value.cipherText.length > 0
    && typeof value.iv === "string" && value.iv.length > 0;
}

function validWrappedKey(value: WrappedNoteKey | undefined): value is WrappedNoteKey {
  return value?.version === 1 && value.algorithm === "RSA-OAEP"
    && typeof value.wrappedKey === "string" && value.wrappedKey.length > 0;
}

/** ACL/storage identity is authoritative; revision-only metadata is not a crypto boundary. */
export function vaultNoteDecryptionAuthority(note: NoteSnapshot, uid: string): string | null {
  if (!note.ownerUid || !Array.isArray(note.participantUids)
    || (note.ownerUid !== uid && (note.type !== "shared" || !note.participantUids.includes(uid)))
    || !validWrappedKey(note.wrappedKeys?.[uid])) return null;
  return JSON.stringify([
    note.id, note.ownerUid, note.type, note.contentFormat ?? null, note.entryKind ?? null,
    [...note.participantUids].sort(),
    Object.entries(note.wrappedKeys).sort(([left], [right]) => left.localeCompare(right))
      .map(([keyUid, key]) => [keyUid, key?.version, key?.algorithm, key?.wrappedKey]),
    note.isDeleted === true, note.isPurged === true, note.secureShareCopyState ?? null
  ]);
}

/** Waiter cancellation never cancels a crypto result still needed by another caller. */
async function waitForConsumer<T>(promise: Promise<T>, signals: readonly (AbortSignal | undefined)[]): Promise<T> {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  for (const signal of active) signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => active.forEach((signal) => signal.removeEventListener("abort", onAbort));
    const onAbort = () => {
      cleanup();
      reject(active.find((signal) => signal.aborted)?.reason ?? abortError());
    };
    active.forEach((signal) => signal.addEventListener("abort", onAbort, { once: true }));
    promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}

/**
 * Explicit unlocked-session cache. Never persists data or shares it globally.
 * Bounds cover retained ciphertext/plaintext estimates, not caller-owned rows
 * or the bounded crypto operations currently needed to produce a result.
 */
export class VaultDecryptionSession {
  private uid: string | null;
  private privateKey: CryptoKey | null;
  private epoch = new AbortController();
  private readonly entries = new Map<string, CachedEntry>();
  private readonly queue: QueuedCrypto[] = [];
  private activeCrypto = 0;
  private estimatedBytes = 0;
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(uid: string, privateKey: CryptoKey, options: { maxEntries?: number; maxBytes?: number } = {}) {
    if (!uid || !privateKey) throw new Error("암호화 세션을 확인할 수 없습니다.");
    this.uid = uid;
    this.privateKey = privateKey;
    this.maxEntries = this.boundedLimit(options.maxEntries, DEFAULT_MAX_ENTRIES);
    this.maxBytes = this.boundedLimit(options.maxBytes, DEFAULT_MAX_BYTES);
  }

  private boundedLimit(requested: number | undefined, maximum: number) {
    return requested !== undefined && Number.isFinite(requested)
      ? Math.max(1, Math.min(maximum, Math.floor(requested))) : maximum;
  }

  matches(uid: string, privateKey: CryptoKey) {
    return this.uid === uid && this.privateKey === privateKey;
  }

  assertSession(uid: string, privateKey: CryptoKey) {
    if (!this.matches(uid, privateKey)) throw abortError();
  }

  get signal() {
    return this.epoch.signal;
  }

  get stats() {
    return {
      entries: this.entries.size,
      estimatedBytes: this.estimatedBytes,
      pendingCrypto: this.queue.length,
      activeCrypto: this.activeCrypto
    };
  }

  clear() {
    this.epoch.abort(abortError());
    this.epoch = new AbortController();
    for (const id of this.entries.keys()) this.remove(id);
    this.estimatedBytes = 0;
    this.queue.splice(0).forEach((item) => item.cancel());
  }

  dispose() {
    this.clear();
    this.uid = null;
    this.privateKey = null;
    this.epoch.abort(abortError());
  }

  async decryptNote(note: NoteSnapshot, signal?: AbortSignal): Promise<{ title: string; body: string }> {
    signal?.throwIfAborted();
    const entry = this.noteEntry(note);
    const values = await this.consume(entry, { title: note.encryptedTitle, body: note.encryptedBody }, signal);
    return { title: values.title!, body: values.body! };
  }

  /** Resolve encrypted filenames without touching potentially large asset bodies. */
  async decryptNoteTitle(note: NoteSnapshot, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    return (await this.consume(this.noteEntry(note), { title: note.encryptedTitle }, signal)).title!;
  }

  /** Reuses only the key belonging to this exact account, unlocked key, and note authority. */
  async getNoteKey(note: NoteSnapshot, uid: string, privateKey: CryptoKey, signal?: AbortSignal): Promise<CryptoKey> {
    signal?.throwIfAborted();
    this.assertSession(uid, privateKey);
    const entry = this.noteEntry(note);
    return this.withEntry(entry, signal, (epoch) => this.noteKey(entry, epoch));
  }

  private noteEntry(note: NoteSnapshot) {
    if (!this.uid || !this.privateKey) throw abortError();
    const authority = vaultNoteDecryptionAuthority(note, this.uid);
    if (!authority) {
      this.remove(`note:${note.id}`);
      throw new Error("노트 읽기 권한과 암호화 키를 확인할 수 없습니다.");
    }
    return this.entry(`note:${note.id}`, authority, note.wrappedKeys[this.uid]);
  }

  async decryptFolder(folder: NoteFolderSnapshot, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (!this.uid || !this.privateKey) throw abortError();
    if (folder.ownerUid !== this.uid || !folder.encryptedName || !validWrappedKey(folder.wrappedKey)) {
      this.remove(`folder:${folder.id}`);
      throw new Error("폴더 소유자와 암호화 키를 확인할 수 없습니다.");
    }
    const authority = JSON.stringify([
      folder.id, folder.ownerUid, folder.isDeleted === true,
      folder.wrappedKey.version, folder.wrappedKey.algorithm, folder.wrappedKey.wrappedKey
    ]);
    const entry = this.entry(`folder:${folder.id}`, authority, folder.wrappedKey);
    return (await this.consume(entry, { name: folder.encryptedName }, signal)).name!;
  }

  private entry(id: string, authority: string, wrappedKey: WrappedNoteKey) {
    const previous = this.entries.get(id);
    if (previous?.authority === authority) {
      this.entries.delete(id);
      this.entries.set(id, previous);
      return previous;
    }
    this.remove(id);
    const entry: CachedEntry = {
      id, authority, wrappedKey: { ...wrappedKey }, controller: new AbortController(), fields: new Map(),
      key: null, keyPromise: null, consumers: 0, bytes: 512 + 2 * (id.length + authority.length + wrappedKey.wrappedKey.length)
    };
    this.trim(this.maxEntries - 1);
    if (this.entries.size < this.maxEntries && entry.bytes <= this.maxBytes) {
      this.entries.set(id, entry);
      this.estimatedBytes += entry.bytes;
    }
    return entry;
  }

  private remove(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.estimatedBytes -= entry.bytes;
    entry.controller.abort(abortError());
    entry.fields.clear();
    entry.key = null;
    entry.keyPromise = null;
  }

  private trim(maxEntries = this.maxEntries) {
    for (const [id, entry] of this.entries) {
      if (this.entries.size <= maxEntries && this.estimatedBytes <= this.maxBytes) break;
      if (entry.consumers === 0) this.remove(id);
    }
  }

  private retireUnusedPendingWork(entry: CachedEntry, epoch: AbortSignal) {
    if (entry.consumers !== 0) return;
    const pendingFields = [...entry.fields.values()].filter((field) => field.pending);
    if (!pendingFields.length && (!entry.keyPromise || entry.key)) return;
    const key = entry.key;
    const fields = new Map([...entry.fields].filter(([, field]) => !field.pending));
    const bytes = entry.bytes - pendingFields.reduce((total, field) => total + field.bytes, 0);
    const cached = this.entries.get(entry.id) === entry;
    const retainCompleted = cached && !epoch.aborted && !entry.controller.signal.aborted
      && this.uid !== null && this.privateKey !== null;
    if (cached) {
      this.remove(entry.id);
    } else {
      entry.controller.abort(abortError());
      entry.fields.clear();
      entry.key = null;
      entry.keyPromise = null;
    }
    // Completed crypto remains reusable, but abandoned promises belong to the
    // old controller and can never reject into or mutate a new consumer's work.
    if (retainCompleted && (key || fields.size)) {
      this.entries.set(entry.id, {
        ...entry, controller: new AbortController(), fields, key, keyPromise: null, bytes
      });
      this.estimatedBytes += bytes;
    }
  }

  private adjustBytes(entry: CachedEntry, difference: number) {
    entry.bytes += difference;
    if (this.entries.get(entry.id) === entry) this.estimatedBytes += difference;
  }

  private assertCurrent(entry: CachedEntry, epoch: AbortSignal) {
    epoch.throwIfAborted();
    entry.controller.signal.throwIfAborted();
    if (!this.privateKey || entry.consumers === 0) throw abortError();
  }

  private schedule<T>(entry: CachedEntry, epoch: AbortSignal, work: () => Promise<T>): Promise<T> {
    this.assertCurrent(entry, epoch);
    if (this.queue.length >= MAX_QUEUED_CRYPTO) return Promise.reject(new Error("암호화 작업이 너무 많습니다. 다시 시도해주세요."));
    return new Promise<T>((resolve, reject) => {
      const job: QueuedCrypto = {
        cancel: () => reject(abortError()),
        run: () => {
          this.activeCrypto += 1;
          void Promise.resolve().then(() => {
            this.assertCurrent(entry, epoch);
            return work();
          }).then((value) => {
            this.assertCurrent(entry, epoch);
            resolve(value);
          }, reject).catch(reject).finally(() => {
            this.activeCrypto -= 1;
            this.drain();
          });
        }
      };
      this.queue.push(job);
      this.drain();
    });
  }

  private drain() {
    while (this.activeCrypto < CRYPTO_CONCURRENCY && this.queue.length) this.queue.shift()!.run();
  }

  private noteKey(entry: CachedEntry, epoch: AbortSignal) {
    if (entry.key) return Promise.resolve(entry.key);
    if (entry.keyPromise) return entry.keyPromise;
    entry.keyPromise = this.schedule(entry, epoch, () => unwrapNoteKey(entry.wrappedKey, this.privateKey!))
      .then((key) => { this.assertCurrent(entry, epoch); entry.key = key; return key; })
      .catch((error) => { entry.keyPromise = null; throw error; });
    return entry.keyPromise;
  }

  private field(entry: CachedEntry, name: FieldName, payload: EncryptedPayload, epoch: AbortSignal) {
    if (!validPayload(payload)) return Promise.reject(new Error("지원하지 않는 암호화 형식입니다."));
    const previous = entry.fields.get(name);
    if (previous && samePayload(previous.payload, payload)) return previous.promise;
    if (previous) this.adjustBytes(entry, -previous.bytes);
    const field: CachedField = {
      payload: { ...payload }, bytes: 2 * (payload.cipherText.length + payload.iv.length),
      promise: Promise.resolve(""), pending: true
    };
    entry.fields.set(name, field);
    this.adjustBytes(entry, field.bytes);
    field.promise = this.noteKey(entry, epoch)
      .then((key) => this.schedule(entry, epoch, () => decryptText(field.payload, key)))
      .then((plaintext) => {
        this.assertCurrent(entry, epoch);
        field.pending = false;
        if (entry.fields.get(name) === field) {
          field.bytes += plaintext.length * 2;
          this.adjustBytes(entry, plaintext.length * 2);
        }
        return plaintext;
      }).catch((error) => {
        if (entry.fields.get(name) === field) {
          entry.fields.delete(name);
          this.adjustBytes(entry, -field.bytes);
        }
        throw error;
      });
    return field.promise;
  }

  private async withEntry<T>(entry: CachedEntry, signal: AbortSignal | undefined, work: (epoch: AbortSignal) => Promise<T>) {
    const epoch = this.epoch.signal;
    entry.consumers += 1;
    try {
      this.assertCurrent(entry, epoch);
      const value = await waitForConsumer(work(epoch), [signal, epoch, entry.controller.signal]);
      this.assertCurrent(entry, epoch);
      signal?.throwIfAborted();
      return value;
    } finally {
      entry.consumers -= 1;
      this.retireUnusedPendingWork(entry, epoch);
      this.trim();
    }
  }

  private consume(entry: CachedEntry, fields: Partial<Record<FieldName, EncryptedPayload>>, signal?: AbortSignal) {
    return this.withEntry(entry, signal, async (epoch) => {
      const names = Object.keys(fields) as FieldName[];
      const values = await Promise.all(names.map((name) => this.field(entry, name, fields[name]!, epoch)));
      return Object.fromEntries(names.map((name, index) => [name, values[index]])) as Partial<Record<FieldName, string>>;
    });
  }
}
