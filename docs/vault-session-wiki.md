# Vault session performance and private wiki

## Scope

The `/wiki` route is an authenticated owner-only reading projection, inspired by
the navigation and reading layout of Obsidian Publish. It does not publish,
share, migrate, rewrite or mark notes as read. Existing note/folder limits and
encrypted storage remain authoritative. URLs contain an opaque note ID only.

The unlocked session is owned above the route boundary and bound to the exact
Firebase UID and private `CryptoKey`. A private in-memory LRU retains at most
5,000 entries and an estimated 32 MiB. Keys, pending promises and field results
are invalidated on lock, logout, identity changes and ACL contractions. Pending
native WebCrypto calls cannot be stopped, but their results cannot be reused or
published after that boundary. Saving captures the session epoch before any
await and checks it again before starting the revision-checked server mutation.

## Reproducible measurements

`npx vitest run src/features/vault/vaultDecryptionPerformance.test.ts --disableConsoleIntercept`
measures native RSA-OAEP 3072/AES-GCM with 120 notes and separately checks the
crypto call budget for 5,000 synthetic rows. On the development Mac, an isolated
120-note run measured approximately 116 ms for uncached decryption, 0.66 ms for
an unchanged encrypted payload with refreshed metadata, and 1.49 ms for one body
change. A concurrent full-suite run measured 166 ms, 1.15 ms and 1.92 ms. These
are crypto-stage measurements, not production network or initial-load timings.

The deterministic budget is more portable: metadata-only refresh performs zero
RSA/AES calls; changing one body performs zero RSA and one AES decrypt. The 5,000
row case eliminates 5,000 RSA unwraps and 10,000 field decrypts on an unchanged
payload refresh. Creation still waits for a confirmed server mutation and live
snapshot; no speculative plaintext is inserted into canonical note state.

The wiki keeps one search/link worker for its reading session. A single changed
note updates one index entry; unchanged projected content sends no index/query
requests. More than 200 changes use one bounded bulk replacement. Superseded
updates are serialized and their stale results are never displayed.

Embedded images use the existing raster signature validation and object-URL
cleanup. Image titles are resolved separately from the article; only referenced
visible assets have their bodies decrypted. A cold session may still need to
unwrap asset keys to resolve encrypted filenames. The Firestore subscription
already carries ciphertext bodies, so this reduces decryption, not downloaded
attachment ciphertext. SVG and other unsupported previews remain file links.

`npm run benchmark:graph-browser` checks 5,000 nodes/10,000 edges, first display,
filter latency and actual wheel/drag/keyboard interaction on Chromium/WebKit at
desktop/mobile sizes. The existing performance thresholds remain unchanged.

`npx playwright test --config=playwright.vault.config.mjs tests/e2e/wiki.vault.mjs`
checks real emulator-backed creation, encrypted save, isolated new-tab unlock,
same-tab session continuity, headings, internal links, backlinks, search,
light/dark overflow and read-only server state. Fixture-only creation timings
are reported per browser; they do not imply production latency guarantees.

## Deliberate boundaries

- No cross-tab key transfer, persistent plaintext cache or public wiki endpoint.
- No Obsidian plugin binaries or arbitrary user JavaScript execution.
- No broad claim of full Obsidian parity: retained graph settings, navigation
  and link behavior are improved within the existing QuickMemo data model.
- Local graph rendering is capped at 120 nodes; the folder/search list is paged
  at 120 rows. Full search remains worker-backed over the authorized inventory.
- Real production account data is not modified as part of automated testing.
- Source/Live Preview focus changes retain the same CodeMirror instance and
  pending image insertions. Switching documents and unmounting still cancel
  the old document's pending operations. Folder trash requires all dirty drafts,
  including shared notes, to be saved before a local trash operation. Remote
  folder deletion retains only unrelated dirty drafts and merge bases with the
  exact same account, unlocked key, and complete note authority. Revoked buffers
  and all cached decryption keys are cleared at that boundary.
- Native-editor draft writes update their authoritative ref synchronously;
  an older passive render effect cannot overwrite a newly inserted image.
  Image source commits can wait up to three seconds for transient subscription
  readiness, with scope and abort checks throughout. The actual authorization,
  revision and persisted-source confirmation gates still run before success.
