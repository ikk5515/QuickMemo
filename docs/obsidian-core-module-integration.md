# QuickMemo Core module integration contract

This document covers the six previously missing Core workflows implemented in
`src/features/vault/core`. They are local browser modules. They do not add an
external API, paid service, plaintext persistence, Firebase collection, or
Community Plugin binary compatibility.

## Shared security boundary

- Components receive plaintext only after the existing Vault unlock and ACL
  boundary. They never write to `localStorage` or `sessionStorage`.
- Persistence is dependency-injected. Callers must continue to use
  `createEncryptedVaultAsset`, `createEncryptedVaultEntry`,
  `saveEncryptedVaultEntry`, and revision-aware trash operations.
- Load components lazily from their direct files. Do not import the whole
  public barrel into the initial Vault bundle.
- Lock or logout must unmount the components. Audio tracks are stopped and
  captured byte buffers are overwritten after the storage callback resolves.

## Audio recorder

`VaultAudioRecorder` feature-detects HTTPS, `getUserMedia`, and
`MediaRecorder`. It never uploads audio itself. Its callback is intentionally
the only plaintext exit:

```tsx
<VaultAudioRecorder
  onCapture={({ bytes, mimeType, suggestedName }) =>
    createEncryptedVaultAsset(profile, vaultIntegrityKey, {
      bytes,
      folderId: activeFolderId,
      mimeType,
      title: suggestedName
    })}
/>
```

The asset-v1 envelope's existing 350KB limit is enforced during recording and
again by Vault persistence. No microphone stream or audio bytes are retained
by this module after the callback. The callback must return the complete
encryption/persistence Promise; the recorder overwrites its byte buffer after
that Promise settles.

## Footnotes view

`VaultFootnotesView` uses the same Markdown AST as reading view. It lists
referenced definition and inline footnotes, reference counts, bounded previews,
and source definition lines. Bind `onNavigate` to the CodeMirror line navigation
command. Fenced code and YAML lookalikes are not treated as definitions.

## Format converter

`planLegacyVaultFormatConversion` wraps the existing sanitized legacy
HTML-to-Markdown converter. The returned plan contains only a new Markdown-copy
draft. There is deliberately no overwrite or delete callback. Before creating
the copy, re-read the source and call
`assertFormatConversionSourceUnchanged(plan, latest)`; a changed revision must
restart preview. Lossy conversions require explicit acknowledgement in
`VaultFormatConverter`.

## Note composer

`VaultNoteComposer` and the pure planner/executor implement extraction and
merge without a destructive multi-document assumption:

1. Dirty drafts are flushed through `flushDirtyDraft`.
2. `readEntry` must return the latest decrypted snapshot and revision.
3. Split creates the new note first, then optionally replaces the original
   selection with a wikilink. If step two fails, the created note is retained
   and reported.
4. Merge saves the target first. The source is moved to trash only after a
   second unchanged-revision check. If that check or trash fails, the merged
   target and original are both retained.

Merge keeps the target's YAML Properties authoritative. Source Properties are
preserved under an inert `원본 Properties` YAML code block so they are not
silently discarded or activated over the target.

Every adapter mutation receives `expectedRevision`, `expectedBody`, and an
operation ID. The adapter must enforce the revision in the existing Firestore
transaction and resolve ambiguous network responses by operation ID; treating
these fields as advisory would break the contract. Composer snapshots must be
`markdown-v1`; Canvas, Base, assets, and legacy HTML are rejected.

## Slides

`VaultSlides` splits Markdown on top-level `---`, excluding YAML frontmatter and
fenced code. Each slide is rendered with `MarkdownRenderer`, so raw HTML is not
injected. It supports buttons, arrows, Page Up/Down, Space, Home/End, Escape, a
mobile fixed presentation mode, a 200-slide limit, and reduced motion.

## Web viewer

`VaultWebViewer` accepts only credential-free public HTTP(S) URLs, blocks common
loopback/private/link-local targets, waits for explicit user confirmation, uses
`referrerPolicy="no-referrer"`, and renders in `sandbox=""`. The separate
external-open link uses `target="_blank" rel="noopener noreferrer"`.

The current production CSP does not permit arbitrary remote frames, by design.
Do not replace it with an unrestricted `frame-src https:` rule merely to make
every site render. A production integration must either retain the safe
external-tab fallback or add a reviewed, finite origin allowlist. Many sites
also deny framing with their own CSP/X-Frame-Options; that is an expected web
platform limitation, not a reason to proxy pages or weaken sandboxing.

## Acceptance coverage

The module tests cover feature detection, byte limits and cleanup, footnote
indexing, immutable conversion plans, dirty/revision conflicts, safe partial
split/merge failures, fenced slide boundaries, keyboard navigation, URL
validation, capability-free iframe attributes, 44px touch controls, narrow
layout, and reduced motion.

All six workflows are lazy-wired in `VaultPage.tsx` and opened from Vault Core
commands/panels. The host adapters enforce the following integration boundary:

- recording goes through `createEncryptedVaultAsset` and never persists a raw
  browser recording;
- footnote navigation moves the active CodeMirror selection to the source line;
- conversion creates a new Markdown copy after re-reading the unchanged legacy
  source;
- split/merge flushes dirty drafts and uses revision-aware encrypted
  create/save/trash operations while retaining both documents on partial
  failure;
- Slides renders the current decrypted Markdown without creating another
  canonical document;
- Web Viewer retains the reviewed host allowlist, empty sandbox, and safe
  external-tab fallback rather than weakening CSP.

This wiring and its unit/component tests are implementation evidence, not a
production-release claim. The final release still requires a clean aggregate
guard/lint/type/unit/Rules/API/build/audit run, browser acceptance, exact-SHA CI,
matching Firebase/Vercel stages, and separate public/authenticated smoke
evidence. No deployment is implied by this document.
