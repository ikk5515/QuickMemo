# Official Obsidian 1.13.7 golden protocol

This gate deliberately fails closed. QuickMemo's local knowledge fixtures are
useful regression contracts, but they are not observations from the official
Obsidian application and cannot authorize a parity claim.

## Verified oracle run on 2026-08-22

The oracle was captured from the official 1.13.7 macOS release in an isolated
temporary home, user-data directory, and the materialized 14-file fixture. It
did not open a personal Vault. The application passed `codesign --deep
--strict` and macOS Gatekeeper reported a notarized Developer ID build with
bundle identifier `md.obsidian` and version `1.13.7`.

Reviewed provenance:

- DMG SHA-256:
  `05daa54f5e1a4458f75da29f8faaa17e8e37ae16998432537f674c626db99bce`
- compressed 1.13.7 ASAR SHA-256:
  `69253e39aa0b980e3cf96e9e8a8a4bed6b6481ef7021cd762f67872662d8d25a`
- decompressed/runtime ASAR SHA-256:
  `a52a7daf1e2460bae03de80f2816604bd16a56cd374fbe5ce8d1a9ef5604059d`
- fixture SHA-256:
  `9831628d77f08f72c1a70dfce8cf8e97695947850c41f981b21540bd435fd6ea`

The initial comparison correctly failed on comment metadata, duplicate-name
selection, alias targets, Canvas tags, and Local Graph self-links. After those
semantic differences were corrected, the provenance verifier and exact
comparison passed with `accepted: true`. The observed contract contains 28
outgoing occurrences and six actual tags; default Global Graph is 17 nodes/20
edges, attachments-on is 19/24, tags-on is 23/27, and Local Graph depth two is
10/10.

The reviewed capture JSON is retained as a regression fixture, while the four
hashed UI screenshots remain release evidence outside the source tree. A local
fixture comparison alone still cannot re-authorize the gate: a future version
change must repeat the signed-app capture and full provenance verification.

## Prepare the exact clean fixture

Use an empty output directory outside the repository:

```bash
node scripts/prepare-obsidian-official-oracle.mjs \
  --output /absolute/empty/path/quickmemo-obsidian-1.13.7-oracle
```

The command writes 11 Markdown notes, one JSON Canvas document, two inert
attachments, and a SHA-256 manifest. It refuses a non-empty directory and broad
project/system roots. Open only this clean vault in the official application;
do not reuse a personal vault or Community Plugins.

## Capture requirements

The operator must use the official signed macOS app, confirm the displayed
version is exactly `1.13.7`, and retain the downloaded
`obsidian-1.13.7.asar`. With default Graph controls, capture and transcribe:

1. Global Graph with defaults, attachments enabled, and tags enabled.
2. Local Graph for `Projects/Hub.md` at depth 2, incoming/outgoing on and
   neighbor links off.
3. Outgoing Links and Backlinks for duplicate file names, duplicate aliases,
   heading/block links, embeds, relative Markdown links, and unresolved links.
4. Tags view, including nested/case-folded tags and ignored code/comment tags.
5. `Canvas/Research.canvas`, its file/text-card relationships, and proof that a
   purely visual Canvas edge is or is not a knowledge edge in that version.

The capture JSON contract is:

```json
{
  "schemaVersion": 1,
  "captureKind": "obsidian-official-interactive-v1",
  "app": {
    "asarSha256": "<sha256 of obsidian-1.13.7.asar>",
    "bundleIdentifier": "md.obsidian",
    "bundleVersion": "<Info.plist CFBundleVersion>",
    "displayedVersion": "1.13.7",
    "shellVersion": "<Info.plist CFBundleShortVersionString>",
    "signatureVerified": true
  },
  "fixture": { "fileCount": 14, "sha256": "<fixture manifest sha256>" },
  "evidence": [
    { "kind": "global-graph", "path": "graph.png", "sha256": "<sha256>" },
    { "kind": "backlinks", "path": "backlinks.png", "sha256": "<sha256>" },
    { "kind": "tags", "path": "tags.png", "sha256": "<sha256>" },
    { "kind": "canvas", "path": "canvas.png", "sha256": "<sha256>" }
  ],
  "oracle": {
    "graph": {
      "defaultGlobal": { "nodes": [], "edges": [] },
      "withAttachments": { "nodes": [], "edges": [] },
      "withTags": { "nodes": [], "edges": [] },
      "localHubDepthTwo": { "nodes": [], "edges": [] }
    },
    "outgoing": [],
    "tags": []
  }
}
```

The arrays must contain observed values; copying QuickMemo's expected values is
not an official capture. Keep the capture and screenshots outside the repository
until reviewed, because they are evidence rather than application source.

Canonical encoding is deliberately path-based so it does not depend on either
application's private node identifiers:

- file/attachment nodes use their complete vault-relative path; tag nodes use
  `#` plus the normalized tag; unresolved nodes use `?` plus the displayed
  normalized target;
- graph edges are `{ "kind", "occurrenceCount", "source", "target" }`;
- every outgoing occurrence records `sourcePath`, exact `raw` Markdown,
  `status`, `targetPath` or `null`, sorted `candidatePaths`, `fragment` or
  `null`, `embedded`, and `unresolvedKey`;
- every tag records `key`, first-seen `displayName`, sorted `entryPaths`, and
  sorted virtual `parentKeys`;
- arrays are sorted lexicographically by their complete JSON representation,
  except graph node strings and tag keys, which use direct lexical ordering.

If an official view does not expose a required fact, leave the gate open and
add independent screenshot/interaction evidence; do not infer the value from
QuickMemo's result.

## Fail-closed verification

```bash
node scripts/verify-obsidian-official-oracle.mjs \
  --app /Applications/Obsidian.app \
  --capture /absolute/path/obsidian-1.13.7-capture.json
```

The verifier rejects a missing app/capture, a non-official bundle identifier,
failed macOS code-signature verification, absent exact-version ASAR, mismatched
ASAR or fixture hashes, missing screenshot hashes, malformed data, and any
QuickMemo/oracle result mismatch. Only an accepted run can close the official
golden-vault release gate.
