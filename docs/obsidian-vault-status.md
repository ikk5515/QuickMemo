# Web Obsidian Vault implementation status

This document is the release contract for the encrypted Vault work. It prevents
the feature flag, marketing copy, or deployment status from being mistaken for
complete Obsidian Core parity.

## Production gate

- `VITE_OBSIDIAN_VAULT_ENABLED` must be absent or exactly `false` in Vercel
  Production until every acceptance item below is backed by reproducible
  evidence.
- The legacy `/app` experience remains the production default. `/app/legacy`
  accepts historical or explicit `legacy-html-v1` documents only and cannot
  write Markdown, Canvas, Base, or asset entries.
- A hidden code deployment is not a Vault launch and must not be reported as
  feature completion.

## Implemented foundation

- Per-entry AES-GCM content encryption, RSA-OAEP wrapped keys, revision-aware
  writes, encrypted history envelopes, and encrypted folder names.
- Source Markdown storage and editing, sanitized read view, Obsidian-style
  wikilinks, heading/block targets, embeds, tags, YAML properties, search AST,
  backlinks, outgoing links, and a worker-backed knowledge index.
- Global and Local Graph data contracts, query/group/display/force controls,
  zoom, pan, hover, click, context menu, temporary drag fixation, keyboard
  fallback, encrypted viewport settings, and large-graph label LOD.
- JSON Canvas text/file/web cards, groups and edges with safe inert external web
  cards. File assets use the encrypted `asset-v1` envelope and signature-gated
  PNG/JPEG/WebP/PDF previews.
- Obsidian ZIP import/export for supported `.md`, `.canvas`, `.base`, and bounded
  assets. Import validates every persistence payload and the complete proposed
  folder tree before writing; root depth is `0` and ancestor depth above `64`
  is rejected. GitHub/Notion/Discord-AI Markdown copy profiles are included.
- Basic editable top-level Properties, Outline, Templates, Unique Note, and
  Slash Commands.
- Responsive drawers and touch targets down to 320 px, reduced-motion behavior,
  and a synchronized accessible graph-node list.

## Partial or intentionally bounded

- Markdown live preview is not yet proven interaction-equivalent to Obsidian;
  the current modes are source, split preview, and read view.
- Folder/file operations do not yet provide the complete multi-select,
  split-group, pinned-tab, new-window, trash/recovery, and resumable bulk
  rename/move experience.
- Unlinked mentions and automatic link conversion are incomplete. Large
  rename/move rewriting is not yet a resumable atomic job.
- Canvas does not yet match every card type, selection, alignment, snap,
  duplication, resize, PDF interaction, and keyboard behavior.
- Properties supports safe top-level scalar/list YAML, not every nested or
  typed property editor.
- Bases is a bounded property table/card/list foundation, not complete Core
  parity.
- Encrypted Firestore assets are limited to 350 KiB raw bytes. Executable,
  mismatched, SVG, HTML, and unknown formats are download-only.
- ZIP import is sequential, not an atomic Firestore transaction. After a
  mid-import failure, QuickMemo attempts a revision-aware compensating
  soft-delete of only the newly created entries. The encrypted note documents,
  deletion history, and quota usage remain; new empty folders can remain; a
  create that committed but lost its response may not have a known ID to clean
  up automatically.
- Graph force values follow the public control contract but have not been
  calibrated against Obsidian's private engine frame by frame. Exact final
  coordinates are not a compatibility requirement.

## Not implemented as Obsidian parity

- General bookmarks, named workspaces, complete tab/split/pin/window semantics,
  File Recovery UI, note split/merge, and the remaining Core command set.
- Community Plugin binary/API compatibility, Obsidian Sync, Obsidian Publish,
  a local filesystem watcher, and unlimited offline editing.
- Permanent graph node pinning, which is not part of the targeted Core behavior.

## Security and zero-cost boundaries

- Plaintext indexes and decrypted keys remain in memory only and are destroyed
  on lock/logout. Vault names, content, search queries, graph settings, and
  workspace state must not be written to browser storage in plaintext.
- CSP, sanitizer, `http`/`https` allowlists, public-share authorization, and
  Firestore owner/participant checks are release blockers and cannot be relaxed
  to make a test pass.
- The deployment must stay on GitHub-hosted standard runners, Firebase Spark
  without a billing account, and Vercel Hobby. Cloud Functions, Firebase
  Storage, paid Marketplace integrations, and paid runtime SDKs are forbidden.
- Free-tier quota checks fail closed. Exceeding an included quota must stop the
  operation; it must never create an overage charge or silently switch provider.

## Required evidence before enabling the flag

1. All security guards, lint, typecheck, unit, Rules, integration, performance,
   responsive browser E2E, default/flagged builds, and dependency audit pass.
2. Golden-vault results are compared with the pinned official Obsidian version,
   including ambiguous duplicate-name and Canvas-link behavior. Project-local
   fixtures alone are not an official oracle.
3. The 5,000-node/10,000-edge graph meets the stated display, filter, and frame
   targets on representative desktop and mobile hardware.
4. Folder integrity is client-preflighted against the complete decrypted tree
   with a maximum ancestor depth of `64` (root depth `0`). Same-parent name
   uniqueness and this depth bound still need an enforceable migration/server
   transaction contract; current client audit plus Rules self/2-node checks
   must not be described as complete server enforcement.
5. GitHub CI succeeds for the exact master SHA; the matching Vercel Production
   deployment is READY; public and authenticated decrypt/edit/Graph/Canvas
   smoke checks are recorded separately.
