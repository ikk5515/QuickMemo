# Web Obsidian Vault implementation status

This document is the release contract for the encrypted Vault work. It prevents
the feature flag, marketing copy, or deployment status from being mistaken for
complete Obsidian Core parity.

## Production gate

- `VITE_OBSIDIAN_VAULT_ENABLED` must be absent or exactly `false` in Vercel
  Production until every acceptance item below is backed by reproducible
  evidence.
- The GitHub `production` Environment must attest the exact combined SHA-256 of
  the current `firestore.rules` and `firestore.indexes.json`, and separately
  attest that the billing-unlinked `quickmemo-a95ba` project was observed on
  Spark for that same digest. Missing, stale, malformed, or cross-project
  attestations fail closed before Vercel is called. These are external release
  assertions, not substitutes for Rules emulator tests or a live read-only plan
  check.
- `VAULT_RELEASE_STATE` must be exactly `enabled` or `disabled`, and the Vercel
  Production `VITE_OBSIDIAN_VAULT_ENABLED` value must match. Both states use the
  same protected workflow so an enabled release can be followed by a standard
  flag-off emergency deployment without weakening the SHA, Spark, Hobby, or
  exact-master gates.
- With the flag off and no server-confirmed `vaultIntegrity/{uid}` cutover
  marker, the legacy `/app` experience remains the production default. Before
  mounting that writable editor, the client performs a read-only marker check;
  an offline cache miss is not treated as proof that the marker is absent.
- With the flag on, or once the account has a Vault integrity marker,
  `/app/legacy` mounts a separate read-only reader. It does not mount legacy
  autosave, create, rename, move, folder, pin/read-state, share, attachment,
  restore, trash, purge, bulk, keyboard-save, or context-menu mutation paths.
  Users can safely read/search, export the original HTML as inert text,
  download authorized attachments without changing them, copy a bounded
  Markdown conversion preview, and—only while Vault is enabled—open the
  preserved source in Vault to explicitly create a Markdown copy.
- A Vault integrity marker is a server-enforced cutover boundary. Turning the
  environment flag off does not make the claim-less legacy editor writable
  again; a marker read failure also fails closed. Deploy Rules that permit the
  owner-only marker `get` before deploying this client gate.
- A hidden code deployment is not a Vault launch and must not be reported as
  feature completion.

## Implemented foundation

- Per-entry AES-GCM content encryption, RSA-OAEP wrapped keys, revision-aware
  writes, encrypted history envelopes, encrypted folder names, and a bounded
  File Recovery pane that restores a selected history snapshot as a new
  revision without persisting plaintext previews.
- Folder topology authority is the server-only `vaultFolderTrees/{uid}` opaque
  map. Direct browser reads/topology writes are denied; same-origin
  `/api/vault-folders` transactions validate ID-token/App Check/active owner,
  complete-tree revision/generation, deterministic name claim, cycle, depth 32,
  and effective ancestor activity for create/migrate/move/update/trash/restore/
  audit/bootstrap. It introduces no Cloud Function or paid queue/database.
- Encrypted folder subtree trash/recovery uses one revision-aware root
  tombstone instead of rewriting descendants. The root name HMAC claim is
  released/reacquired in the same transaction, active subscriptions omit every
  descendant and contained entry, and restore requires a server-confirmed
  complete-tree preflight plus a post-write active-path subscription check.
- Source Markdown storage and editing, a single-surface CodeMirror 6 inline Live
  Preview, sanitized read view, Obsidian-style wikilinks, heading/block targets,
  embeds, tags, YAML properties, search AST, backlinks, outgoing links, and a
  worker-backed knowledge index. Live Preview keeps the selected line as raw
  editable source, removes replacement widgets during IME composition, and
  decorates headings, emphasis, strong text, inline code, Wiki/standard links,
  tags, task checkboxes, blockquotes, and callout markers without changing the
  canonical Markdown. Complete inactive block ranges for tables, fenced
  Mermaid/Dataview/code, display math, multi-line callouts, images, and embeds
  render through the same sanitized `MarkdownRenderer`; moving the selection
  into a block reveals its original Markdown again. Resolved internal links in
  Live Preview and reading view share delayed pointer/keyboard Page Preview,
  while external, unresolved, inaccessible, or invalid kind/format targets fail
  closed. Backlinks also
  finds title/alias plaintext mentions in Markdown and can turn a still-current
  occurrence into a path-qualified Wikilink without replacing newer draft
  edits. Frontmatter, fenced/inline code, existing links, external URL tokens,
  the target file itself, and non-Markdown sources are excluded.
- Global and Local Graph data contracts, query/group/display/force controls,
  zoom, pan, hover, click, context menu, temporary drag fixation, keyboard
  fallback, encrypted viewport settings, and large-graph label LOD.
- JSON Canvas text/file/web cards, groups and directed/labelled edges with safe
  inert external web cards. An unmodified primary click opens a file card;
  modifier clicks remain selection gestures. Multi-selection, node resize,
  duplication with internal edges, six-way alignment, equal horizontal/vertical
  gaps, optional grid snap, front/back z-order, and accessible toolbar commands
  are implemented. Geometry-derived groups move and duplicate fully contained
  cards without adding a proprietary parent field to JSON Canvas. Node/edge/
  background context menus, touch long-press, `Shift+F10`, select-all, Escape,
  keyboard nudge, `Shift+1` whole-canvas fit, and `Shift+2` selection fit provide
  non-pointer fallbacks. Trackpad/wheel panning, middle-button or Space-drag
  panning, and bounded modifier-wheel zoom use React Flow's viewport instead of
  persisting private coordinates. A blank-canvas double click creates a text
  card; text cards render sanitized Markdown until an explicit double click
  enters their source editor. Edge double click edits its label, and the edge
  menu can navigate to either endpoint or choose the four JSON Canvas arrow
  combinations. Markdown file cards render a
  bounded inert preview through the same sanitized renderer as reading view.
  File assets and group background images use the encrypted `asset-v1` envelope
  and signature-gated PNG/JPEG/WebP/PDF previews; group backgrounds support
  cover, contain/ratio, and repeat. PDF cards expose bounded page and transient
  zoom controls while keeping their browser preview sandboxed. Operating-system
  file drops are limited to 16 files and the existing 350 KB inline-asset
  ceiling, and are handed to the Vault's encrypted asset creation path before a
  card is written. The Canvas component never persists raw dropped bytes.
- Obsidian ZIP import/export for supported `.md`, `.canvas`, `.base`, and bounded
  assets. Import validates every persistence payload and the complete proposed
  folder tree before writing. The server-authoritative central tree supports
  depth `0...32`; missing parents, cycles, tombstoned ancestors, and deeper
  imports fail closed and are not silently flattened. Interrupted imports are
  listed in a dedicated keyboard-accessible recovery panel. It separates a
  server recheck from an explicit revision-aware rollback, never deletes a
  committed job, and preserves later edits when rollback conflicts. GitHub/
  Notion/Discord-AI Markdown copy profiles are included.
- Editable safe top-level Properties, Outline, Bases, Templates, Unique Note,
  and Slash Commands. Properties provides text, list, number, checkbox, date,
  datetime, and tag controls while rejecting nested/ambiguous YAML. Bases
  supports table/card/list views, filtering, sorting, grouping, summaries,
  safe bounded formulas and typed values described in
  `docs/obsidian-bases-compatibility.md`; supported property edits write through
  to source Markdown frontmatter and resolved internal values open the target
  entry. It does not execute JavaScript or plugin-defined functions/views.
- The command `현재 검색 결과 인덱스 만들기` materializes the current filtered
  result set as a new encrypted `markdown-v1` note. It writes real relative
  Markdown internal links, so normal parsing adds them to Graph, Backlinks, and
  Outgoing Links. Output is deduplicated and path-sorted, limited to 500 links,
  and includes a visible callout and status count when further results are
  omitted. It is deliberately named an index rather than a curated MOC: a real
  MOC still requires the user to choose its purpose, reading order, and core
  links in their own language.
- Obsidian-style ribbon and settings panes, plus compact Calendar/Matrix-only
  schedule navigation. Legacy Todo and Recurring Work data paths remain intact
  for preservation, but their routes and primary schedule controls are no
  longer exposed.
- General entry/search/Global Graph bookmarks, real close-protecting pinned
  tabs, and up to 32 named workspace snapshots are stored only inside the
  encrypted revision-aware workspace envelope. Snapshot restore filters tabs,
  Local Graph roots, and Daily Note targets against the currently decrypted
  ACL scope; inaccessible entry bookmark labels and paths are not rendered.
  UTF-8 per-snapshot, aggregate, and whole-workspace budgets fail closed before
  Firestore encryption/base64 expansion can approach the document limit.
- Encrypted built-in Daily/weekly/monthly Notes Calendar, a bounded safe
  Dataview query subset (`LIST`, `TABLE`, `TASK`, `CALENDAR`, `GROUP BY`,
  bounded filters/sorts/limits), non-scriptable template path/prompt/selection
  tokens, QuickMemo-native Markdown Drawing with inert SVG export, and
  Markdown-backed Kanban with original note links, nested checklists, explicit
  compatibility inspection/import, and source export. Their exact supported
  syntax and loss-prevention behavior are documented in
  `docs/obsidian-built-in-tools.md`.
- Audio Recorder, Footnotes View, Format Converter, Note Composer, Slides, and
  safe Web Viewer are lazy-wired Vault Core workflows. They reuse the existing
  encrypted asset/entry adapters and do not imply arbitrary remote iframe,
  destructive conversion, or unbounded media support.
- Revision conflicts can open a bounded three-way Markdown resolver. It
  automatically combines non-overlapping edits and requires an explicit local,
  remote, both-preserved, or manual choice for every overlapping range. It
  re-reads the remote revision and revalidates the still-dirty local/base scope
  before saving; title/folder conflicts fail closed, and neither side is
  overwritten merely by opening or cancelling the dialog.
- A reviewed Library item can be promoted to an encrypted deterministic
  Markdown copy under server-authoritative `00_Inbox`, preserving the Library
  source. URL, capture time, summary/body/OCR/highlights, and valid tags are
  normalized into inert Markdown; response-loss retries verify the same
  encrypted target instead of creating duplicate notes. Success exposes an
  explicit Vault-open action and failure remains retryable.
- Responsive drawers and touch targets down to 320 px, reduced-motion behavior,
  a synchronized accessible graph-node list, and explicit save/offline/failure/
  revision-conflict states. A conflict preserves the local draft and offers the
  bounded three-way merge above, copy-to-new-note, or remote reload.

## Partial or intentionally bounded

- The Vault workspace Markdown modes are now `소스`, inline `라이브 프리뷰`,
  and sanitized `읽기`.
  The Live Preview foundation is genuine CodeMirror decoration/widget behavior,
  not a side-by-side renderer. Inactive complete tables, fenced blocks, display
  math, multi-line callouts, images, and embeds now use sanitized block widgets,
  and both Live Preview and reading links use the same ACL-scoped Page Preview.
  It remains a bounded compatibility layer: deeply nested mixed constructs,
  browser/IME-specific selection geometry, every Obsidian modifier gesture,
  and pixel-identical cursor/widget transitions have not been proven
  interaction-equivalent.
- Folder/file operations do not yet provide the complete multi-select,
  multi-window geometry, hard-purge, and every bulk
  rename/move interaction. Folder trash/recovery is deliberately a bounded
  owner-only subtree operation, not a general maintenance job API.
- A bounded recursive pane tree is implemented: up to eight tab groups and five
  layout levels can be split left/right or top/bottom. Every split has pointer
  and keyboard resizing, and closing the final unpinned tab collapses its empty
  pane. `Cmd/Ctrl+Alt` splits the active pane into a new group; group-local active,
  close, and pin state plus recursive ratios are encrypted and restored. At
  760 px and below, only the selected group is mounted and an accessible selector
  switches groups. Only the focused group mounts a heavy Graph/Canvas/Base view;
  inactive Markdown groups keep conflict-protected editable drafts.
- Named workspace snapshots restore the bounded recursive layout, group-local
  active/pin state, side panels, graph settings/viewports, Calendar, and
  bookmarks. The existing modifier-based new-window open behavior is preserved,
  but multi-window geometry and cross-window pane synchronization are not stored
  or presented as Core parity.
- Unlinked title/alias occurrences and revision-safe one-click Wikilink
  conversion are implemented for the bounded Markdown scope described above.
  Duplicate filename/alias resolution, Canvas-file relations, tags, Local
  Graph, and the pinned reference fixture were calibrated against a signed and
  notarized official Obsidian 1.13.7 oracle; the provenance verifier and exact
  comparison pass. That result covers the captured semantic fixture, not every
  undocumented interaction or future Obsidian release. Large rename/move
  rewriting is stored as an encrypted,
  revision-aware cursor job and resumes after reload; each source update is
  conflict-checked and completion is not reported before the cursor reaches the
  end. The path mutation plus every incoming-source rewrite is nevertheless not
  one globally atomic Firestore transaction, so conflicting sources can block
  the job for explicit recovery. The workspace now exposes the blocked durable
  job with an error-specific, non-destructive recovery notice. It saves every
  dirty draft first and resumes only after the latest server path and revision
  preconditions still match; corrupt jobs do not expose a misleading retry or
  skip action.
- Canvas selection, resize, duplication, alignment, equal-gap distribution,
  snap, z-order, single-click file opening, sanitized inert Markdown file-card
  and text-card previews, explicit text-card source editing, bounded PDF
  page/zoom controls, encrypted external file drop,
  repeated group backgrounds, geometry-derived group drag/duplication, and
  accessible context menus are implemented. Nested and overlapping membership
  is deterministic without proprietary JSON: the smallest enclosing group owns
  a card and equal-area ties go to the topmost group, while selecting an outer
  group recursively includes its owned nested groups. Remaining parity work is
  Obsidian's fully interactive Markdown embed behavior, exact PDF page-count and
  crop interaction, operating-system folder/directory drop and assets above the
  encrypted inline limit, and official 1.13.7 calibration of group boundary
  ties, modifier gestures, edge routing, long-press, and screen-reader
  announcements. Browser-native PDF fragment support also differs by browser.
- Properties supports the documented safe top-level typed controls, not every
  nested YAML shape or plugin-defined property editor.
- Bases implements the bounded Core surface documented separately, including
  typed values/formulas/summaries and table/card/list editing. Locale/timezone
  details, arbitrary regular expressions, plugin functions/view types, exact
  Moment semantics, and complete HTML/image/icon rendering remain intentionally
  partial. It is distinct from Dataview's declarative report renderer.
- The built-in Calendar, Dataview, Templates, Drawing, and Kanban tools adapt
  their main workflows but do not implement the corresponding Community Plugin
  APIs, JavaScript runtimes, file formats, or every advanced control.
- QuickMemo Drawing supports bounded single-element hit selection, drag, corner
  resize, keyboard deletion/movement, two-pointer zoom/pan, and an inert
  standalone SVG export. It does not provide Excalidraw file compatibility,
  multi-selection, rotation, handwriting recognition, or image embedding.
- Dataview has bounded input, output, syntax, and per-document block counts.
  Base materialization stays synchronous for at most 250 scoped entries and
  moves larger inputs to a dedicated module Worker. A generation/token guard
  prevents a completed calculation from an older ACL/input scope from painting.
  Representative-device Base latency and memory evidence remain release gates.
- Base/Dataview `file.links` metadata projections are deliberately deduplicated
  and bounded to 256 targets per file and 4,096 per response (1,024 characters
  per target). Canonical Markdown, Graph, Backlinks, and Outgoing Links retain
  their separate index semantics; an over-limit table projection is incomplete
  by design and is another reason the production flag remains off.
- Encrypted Firestore assets are limited to 350 KiB raw bytes. Executable,
  mismatched, SVG, HTML, and unknown formats are download-only.
- ZIP import is a durable multi-transaction job, not one atomic Firestore
  transaction. Before staging entries it stores an encrypted, chunked manifest
  with fixed opaque target IDs (up to 10,000 targets, 100 per chunk). Response
  loss is idempotently reconciled, interrupted staging is discovered after
  unlock, and rollback uses server-only owner snapshots plus revision-aware
  entry tombstones and root-folder subtree trash. Imported targets remain
  mutation-locked until commit or the exact rollback transition, while a
  committed job does not keep user content locked if terminal cleanup is
  interrupted. A conflicting target revision moves the job to an explicit
  blocked recovery state instead of deleting newer work. The operation is still
  compensating rollback: encrypted tombstones/history and quota usage remain,
  and a globally atomic 10,000-document Firestore commit is not claimed. Startup
  lists recoverable jobs without silently rolling them back; the recovery panel
  rechecks server state and exposes only safe explicit actions. Some low-level
  failure diagnoses are intentionally summarized instead of displaying job IDs,
  ciphertext, or backend exception details.
- Graph force values follow the public control contract but have not been
  calibrated against Obsidian's private engine frame by frame. Exact final
  coordinates are not a compatibility requirement.
- Firestore synchronization is not a backup. File Recovery and ZIP export are
  separate safeguards, and neither establishes unlimited offline editing.

## Not implemented as Obsidian parity

- Unbounded split/window-layout semantics and persisted multi-window geometry.
  The encrypted bounded layout supports eight panes at five levels with split
  resizing and tab protection; those explicit safety limits do not imply
  unlimited desktop-window parity.
- Community Plugin binary/API compatibility, Obsidian Sync, Obsidian Publish,
  a local filesystem watcher, and unlimited offline editing.
- Permanent graph node pinning, which is not part of the targeted Core behavior.
- Excalidraw `.excalidraw`/`.excalidraw.md` format or plugin compatibility.
  QuickMemo Drawing uses its own validated `drawing-v1` Markdown payload.

## Core 1.13.7 coverage audit

The official Core-plugin list is a compatibility checklist, not a claim that a
similarly named QuickMemo panel is equivalent. The signed 1.13.7 golden fixture
closes the captured link/tag/Graph/Canvas-file semantic comparison only. The
remaining labels below describe implemented workflow surface and known bounds,
not pixel-level interaction or private-engine equivalence.

| Audit result | Core items |
| --- | --- |
| Basic contract implemented, exact UX not proven | Random note, Word count |
| Implemented with documented safety/scale/UX bounds | Audio recorder, Backlinks, Bases, Bookmarks, Canvas, Command palette, Daily notes, File explorer, File recovery, Footnotes view, Format converter, Graph view, Note composer, Outgoing links, Outline, Page preview, Properties view, Quick switcher, Search, Slash commands, Slides, Tags view, Templates, Unique note creator, Web viewer, Workspaces |
| Intentionally non-equivalent replacement/exclusion | Sync (Firestore E2EE replacement), Publish (encrypted sharing replacement) |

The dedicated Footnotes view, immutable-preview Format Converter, bounded safe
Web Viewer, and the other Core modules are wired; their safety limits still
matter. Community Calendar, Dataview, Templater, Excalidraw, and Kanban remain
documented as safe built-in workflows or replacements rather than Community
Plugin API/binary/file-format compatibility.

## Security and zero-cost boundaries

- Plaintext indexes and decrypted keys remain in memory only and are destroyed
  on lock/logout. Vault names, content, search queries, graph settings, and
  workspace state must not be written to browser storage in plaintext.
- User-authored Matrix labels are AES-GCM encrypted with an RSA-OAEP-wrapped
  data key. Browser preference caches retain only non-sensitive navigation/theme
  values and scrub legacy plaintext labels. Existing plaintext Firestore labels
  require an online unlocked migration and must be migrated under the new Rules
  contract before the client update is released.
- CSP, sanitizer, `http`/`https` allowlists, public-share authorization, and
  Firestore owner/participant checks are release blockers and cannot be relaxed
  to make a test pass.
- The deployment must stay on GitHub-hosted standard runners, Firebase Spark
  without a billing account, and Vercel Hobby. Cloud Functions, Firebase
  Storage, paid Marketplace integrations, and paid runtime SDKs are forbidden.
- The application has no paid-provider fallback. On Spark/Hobby, provider quota
  exhaustion stops the affected operation instead of upgrading a plan. The
  actual Firebase billing link and production environment remain external
  release checks; application code cannot prove those account settings.
- Paid AI/embedding APIs and remote semantic-search providers are not bundled.
  Semantic search is off/not provided by default and similarity never creates a
  Graph or Backlinks edge.

## Current evidence snapshot (2026-08-23)

- The signed/notarized official Obsidian 1.13.7 oracle capture and exact
  comparison are accepted. The observed reference is recorded in
  `docs/obsidian-official-golden-protocol.md` and must be recaptured for a
  different version.
- The secure-share performance fixture passed (`2/2`). A separate real-Canvas
  5,000-node/10,000-edge browser harness passed Chromium and WebKit at desktop
  1280 px and mobile 390 px viewports (`4/4`). Including actual Web Worker
  Markdown indexing and snapshot generation, the latest guarded run that also
  suppresses labels/arrows during animated keyboard navigation measured
  `785.3–893 ms` end to end (`91.3–113 ms` for the initial Worker build),
  `55.17–73.87 fps` average interaction, and `24–29 ms` p95 frame intervals on
  this machine.
  The same real Worker harness now also runs eight filter/group queries over
  all 5,000 notes and enforces the planned `250 ms` p95 ceiling; the first
  guarded run measured `17.9–31 ms` p95 across the four browser/viewports.
  A second headful native-window run repeated the same workload five times in
  the installed Google Chrome 151 binary and five times in the pinned
  Playwright WebKit 26.5 binary. Chrome passed `5/5` with `577.7–640.4 ms`
  end-to-end display, `17.4–17.9 ms` filter/group p95, and `58.08–59.11 fps`;
  WebKit passed `5/5` with `679–963 ms`, `27–30 ms`, and `53.81–55.50 fps`.
  The raw repeated values and OS-sized viewport evidence are retained in
  `docs/evidence/graph-native-2026-08-22.json`. This still does not close the
  representative-device gate: Playwright WebKit is not Safari, Safari 26.6.2
  had `Allow Remote Automation` disabled, and no physical phone/tablet was
  connected. The verifier did not change that Safari security setting.
- The final post-integration local gate completed on 2026-08-23. Lint,
  typecheck, all three security guards, both default and Vault-enabled builds,
  dependency audit, and bundle-budget verification passed. Vitest reported
  2,413 passing tests with seven intentional skips; Rules reported 78/78, the
  authenticated API emulator 56/56, cleanup handling 52/52, and secure-share
  performance 2/2. The standard browser matrix passed 108/108, while the Vault
  matrix passed every executed acceptance case (31/31) with 26 project-scoped
  skips. Chromium and WebKit covered desktop, 1024/768 px tablet, and 390/320 px
  mobile layouts. These are local final-source results; the exact pushed commit
  still has to pass GitHub CI before release.
- The final idle-machine 5,000-node/10,000-edge browser run passed 4/4. Chromium
  desktop/mobile measured 93.56/102.69 fps with 9.3/9.0 ms frame p95; WebKit
  desktop/mobile measured 58.59/58.19 fps with 23/27 ms p95. Filter/group p95
  was 16.9-28 ms. A first Chromium-desktop run made concurrently with a
  CPU-saturating Vitest job failed its frame-p95 budget; that result was retained
  rather than hidden, and the same code was rerun only after the competing job
  ended. These engine/viewports do not replace a physical iPhone/iPad smoke.
- The final Vault-enabled build kept `VaultPage` at 364.32 kB raw / 110.73 kB
  gzip and the lazy CodeMirror chunk at 607.03/207.16 kB. The default build kept
  them at 402.44/121.16 kB and 607.03/207.17 kB respectively; both remain within
  the enforced 400/120 KiB and 640/225 KiB raw/gzip budgets. The default Vault
  route is close to its guard and must not grow without further splitting.
- GitHub CI, Firebase Rules/index deployment, matching Vercel Production, public
  smoke, and authenticated decrypt/edit/search/Graph/Canvas/recovery smoke are
  separate release stages. None is claimed by this document before its own
  evidence is recorded.
- The durable release-attestation verifier is implemented, but this snapshot
  does not claim that its remote GitHub Environment variables have been set or
  that the current Firestore digest has been deployed. Recording those external
  values is part of the later production stage, not implementation evidence.

## Required evidence before enabling the flag

1. All security guards, lint, typecheck, unit, Rules, integration, performance,
   responsive browser E2E, default/flagged builds, and dependency audit pass.
2. The accepted signed-app golden-vault result remains reproducible with the
   pinned official Obsidian version and fail-closed procedure in
   `docs/obsidian-official-golden-protocol.md`. A version/fixture change reopens
   this gate; project-local fixtures alone are not an official oracle.
3. The 5,000-node/10,000-edge graph meets the stated display, filter, and frame
   targets on representative desktop and mobile hardware.
4. Folder authority v3 is enforced through the server-only
   `vaultFolderTrees/{uid}` map. Vercel transactions validate the complete tree,
   generation, revision, claim, cycle, depth-32, and lifecycle invariants;
   Rules use one central membership lookup and do not trust client lineage.
   Direct SDK topology writes and writes below a tombstoned ancestor are
   emulator regressions. Root/child/subtree moves are supported when the full
   proposed tree remains valid; descendant authorization changes atomically in
   the same central document.
5. GitHub CI succeeds for the exact master SHA; the matching Vercel Production
   deployment is READY; public and authenticated decrypt/edit/Graph/Canvas
   smoke checks are recorded separately.
6. The exact current Firestore Rules/Indexes digest is deployed to
   `quickmemo-a95ba`, required indexes are Ready, Spark with no billing link is
   rechecked, and both digest-bound GitHub Environment attestations are set.
   `VAULT_RELEASE_STATE=enabled` and the Vercel Production Vault flag are changed
   only after items 1–5 are satisfied. `disabled` remains the fail-closed
   emergency deployment state.
