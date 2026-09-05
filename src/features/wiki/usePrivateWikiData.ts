import { useEffect, useState } from "react";
import {
  subscribeNoteFolders,
  subscribeVisibleNotes,
  type NoteFolderSnapshot,
  type NoteSnapshot
} from "../../services/notes";
import { visibleVaultNotesForFolders } from "../vault/folderTrash";
import {
  decryptVaultFolders,
  decryptVaultNotes,
  resolvedVaultEntryKind,
  type DecryptedVaultFolder,
  type DecryptedVaultNote
} from "../vault/vaultData";
import { useVaultDecryptionSession } from "../../context/VaultDecryptionContext";

interface WikiData {
  notes: DecryptedVaultNote[];
  assetSnapshots: NoteSnapshot[];
  folders: DecryptedVaultFolder[];
  ready: boolean;
  error: string | null;
}

const EMPTY: WikiData = { notes: [], assetSnapshots: [], folders: [], ready: false, error: null };

/** Owner-only read projection. No repair, migration, creation, or access expansion. */
export function usePrivateWikiData(uid: string, privateKey: CryptoKey) {
  const session = useVaultDecryptionSession();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<WikiData & { session: typeof session; uid: string; key: CryptoKey }>(
    () => ({ ...EMPTY, session: null, uid, key: privateKey })
  );

  useEffect(() => {
    if (!session) return;
    let closed = false;
    let failed = false;
    let notes: NoteSnapshot[] | null = null;
    let folders: NoteFolderSnapshot[] | null = null;
    let controller: AbortController | null = null;
    let displayedAuthority = new Set<string>();
    let displayedAssets: NoteSnapshot[] = [];
    let displayedFolderSource: NoteFolderSnapshot[] | null = null;
    let displayedFolders: DecryptedVaultFolder[] = [];
    const scope = { session, uid, key: privateKey };
    const commit = (next: WikiData) => {
      if (!closed) setState({ ...next, ...scope });
    };
    commit(EMPTY);

    function fail() {
      if (closed || failed) return;
      failed = true;
      controller?.abort();
      notes = null;
      folders = null;
      displayedAssets = [];
      displayedFolderSource = null;
      displayedFolders = [];
      session?.clear();
      commit({ ...EMPTY, error: "위키를 불러오지 못했습니다. 권한과 연결을 확인한 뒤 다시 시도해주세요." });
    }

    function decrypt() {
      if (closed || failed || !notes || !folders) return;
      controller?.abort();
      const current = new AbortController();
      controller = current;
      const folderSource = folders;
      const ownedFolders = folders.filter((folder) => folder.ownerUid === uid && !folder.isDeleted);
      const visibleOwnedNotes = visibleVaultNotesForFolders(notes, ownedFolders).filter((note) => (
        note.ownerUid === uid && note.isDeleted !== true && note.isPurged !== true && Boolean(note.wrappedKeys?.[uid])
      ));
      const nextAssets = visibleOwnedNotes.filter((note) => resolvedVaultEntryKind(note) === "asset");
      // The subscription already reuses unchanged snapshot objects. Preserve
      // the asset list identity when only a Markdown document changes.
      const assetSnapshots = nextAssets.length === displayedAssets.length
        && nextAssets.every((asset, index) => asset === displayedAssets[index]) ? displayedAssets : nextAssets;
      const ownedNotes = visibleOwnedNotes.filter((note) => {
        const kind = resolvedVaultEntryKind(note);
        // Binary assets and archived formats are not part of the reader. Avoid
        // unwrapping/decrypting their potentially large bodies just to discard them.
        return kind === "markdown" || kind === "legacy-html";
      });
      // Ordinary ciphertext/revision updates keep the reader mounted (query and
      // scroll survive). Any shrinking or replaced authority hides everything
      // before asynchronous decryption can continue, including hidden folders.
      const nextAuthority = new Set([
        ...[...ownedNotes, ...assetSnapshots].map((note) => JSON.stringify([
          "note", note.id, note.ownerUid, note.type, note.entryKind, note.contentFormat,
          [...(note.participantUids ?? [])].sort(), note.wrappedKeys[uid]
        ])),
        ...ownedFolders.map((folder) => JSON.stringify(["folder", folder.id, folder.ownerUid, folder.wrappedKey]))
      ]);
      if ([...displayedAuthority].some((identity) => !nextAuthority.has(identity))) {
        displayedAuthority = new Set();
        displayedAssets = [];
        displayedFolderSource = null;
        displayedFolders = [];
        session?.clear();
        commit(EMPTY);
      }
      void Promise.all([
        decryptVaultNotes(ownedNotes, uid, privateKey, { session: session!, signal: current.signal }),
        displayedFolderSource === folderSource ? Promise.resolve(displayedFolders)
          : decryptVaultFolders(ownedFolders, uid, privateKey, { session: session!, signal: current.signal })
      ]).then(([nextNotes, nextFolders]) => {
        if (closed || failed || current.signal.aborted) return;
        displayedAuthority = nextAuthority;
        displayedAssets = assetSnapshots;
        displayedFolderSource = folderSource;
        displayedFolders = nextFolders;
        commit({
          notes: nextNotes.filter((note) => note.entryKind === "markdown" || note.entryKind === "legacy-html"),
          assetSnapshots,
          folders: nextFolders,
          ready: true,
          error: null
        });
      }).catch(() => {
        if (!current.signal.aborted) fail();
      });
    }

    const stopNotes = subscribeVisibleNotes(uid, [uid], (next) => {
      if (closed || failed || notes === next) return;
      notes = next;
      decrypt();
    }, fail, undefined, { repairLegacyDeletionMetadata: false });
    const stopFolders = subscribeNoteFolders(uid, (next) => {
      if (closed || failed || folders === next) return;
      folders = next;
      decrypt();
    }, fail, undefined, { prepareVaultFolderTree: false });
    return () => {
      closed = true;
      controller?.abort();
      notes = null;
      folders = null;
      stopNotes();
      stopFolders();
    };
  }, [attempt, privateKey, session, uid]);

  const current = state.session === session && session && state.uid === uid && state.key === privateKey
    ? state : EMPTY;
  return { ...current, retry: () => setAttempt((value) => value + 1) };
}
