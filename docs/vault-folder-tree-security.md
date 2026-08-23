# Vault folder tree security contract

## Authority and privacy boundary

Encrypted Vault folder topology is authorized by the server-only document
`vaultFolderTrees/{uid}`. The document contains only opaque folder IDs,
opaque parent IDs, effective activity, independent activity, and monotonically
increasing generations. It never contains a decrypted name, path, note body,
attachment, key, or name fingerprint.

Browser SDK reads and writes to this collection are denied. Folder structural
mutations are handled by `/api/vault-folders`, which reuses the existing
same-origin, Firebase ID-token, active-user, App Check, and service-account
Firestore REST boundary. No Cloud Function, queue, paid database, or metered AI
service is introduced.

## Invariants

- Schema version is `1` and a tree revision starts at `1`.
- A node is `{ parentId, selfActive, active, generation }` and has no extra
  fields.
- Every non-root parent exists in the same owner tree.
- Cycles and self-parenting are rejected by a complete server traversal.
- Maximum folder depth is `32`; root depth is `0`.
- `active` is always recomputed as `selfActive && parent.active`.
- The conservative capacity is 2,000 encrypted folders and 700,000 serialized
  JSON bytes, leaving space below Firestore's 1 MiB document limit.
- Existing legacy folder rows are scanned only during the initial bootstrap,
  with a bounded 5,001-row sentinel query and a projection that excludes names
  and content.

Firestore Rules perform a constant-cost lookup of the assigned encrypted
folder node. Client-supplied `vaultAncestorIds`, paths, depths, and generations
are display/export metadata only and do not grant access.

## Transaction contract

Create, legacy migration, move, rename/order update, trash, and restore begin a
Firestore read-write transaction. The transaction reads the authoritative
tree and applicable folder/name claim, validates the complete server tree, and
commits the tree, folder row, and deterministic opaque name claim in one REST
commit with document update-time or non-existence preconditions.

- Create retries after an ambiguous response succeed only when the stored
  revision-one folder has the exact encrypted name, wrapped key, color, order,
  parent, import binding, claim, and lineage after-state.
- A move validates the whole proposed tree. Moving a folder under any
  descendant or beyond depth 32 aborts without a partial write.
- Trash changes the selected node's `selfActive` and atomically recomputes all
  descendant effective states in the central document. No descendant can
  remain authorized during a partial rewrite because there is no multi-document
  descendant authorization rewrite.
- Restore requires an active parent and preserves independently tombstoned
  descendants through their own `selfActive: false` value.
- Folder document lineage for descendants may be stale after an ancestor move,
  but it is not an authorization source. Runtime visibility traverses current
  folder `parentId` values, while Rules use only the central tree.

Firestore commits are atomic. A network failure after an ambiguous commit is
fail-closed: a create can be retried against its exact after-state; revisioned
move/lifecycle operations return a conflict until the client refreshes the
authoritative folder revision. Rollback is attempted for every pre-commit
failure and never substitutes for commit atomicity.

## Operations and recovery

- `bootstrap`: create the initial central tree from authoritative stored folder
  documents when no tree exists.
- `audit`: compare the tree against a bounded authoritative folder scan without
  mutating either side.
- `create`, `migrate`, `move`, `update`, `trash`, `restore`: revision-aware
  transaction mutations.

An existing invalid or stale tree is not silently rebuilt. Mutations fail
closed with a conflict, and `audit` reports `stale`; repair then requires an
explicit reviewed migration rather than trusting browser-supplied ancestry.

## Verification evidence

- Firestore/Storage Rules emulator: deep assigned-folder writes, direct tree
  read/write denial, direct encrypted-folder create/move denial, forged
  lineage/cycle denial, and ancestor tombstone denial.
- Auth + Firestore API emulator: real HTTP handler authentication, atomic
  tree/folder/claim create, exact response-loss retry, cycle rollback, subtree
  tombstone, and restore.
- Pure server tests: depth 32, missing parents, forged effective state,
  three-node cycles, digit-leading opaque IDs, independent tombstones, and
  descendant move behavior.

Production activation still requires the normal release gates: complete
typecheck/lint/test/build, Rules and index deployment, CI on the selected master
SHA, Vercel production of the same SHA, and authenticated smoke testing. Local
contract tests alone are not production evidence.
