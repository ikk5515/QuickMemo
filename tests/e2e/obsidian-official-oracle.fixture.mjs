/* global Buffer */

import { createHash } from "node:crypto";

const markdownFiles = {
  "Projects/Hub.md": `---
aliases: [Hub Alias]
tags: [project/core, SharedCase]
status: active
---
# Local Heading
[[Research/Target#Section|target heading]]
![[Research/Target#^block-a]]
[[Research/Target]]
[[Target]]
[[Shared Alias]]
[[Unique Alias]]
[[#Local Heading]]
[[Missing Note]]
[[Research/Target]]
![[Assets/diagram.png]]
![[Assets/reference.pdf#page=1]]
[relative](../Research/Target.md#Section)
[external](https://example.com/Research/Target)
Plain Research/Target mention.

#inline/tag #PROJECT/CORE
\`[[Ignored Inline]] #ignored-inline\`

~~~md
[[Ignored Fenced]] #ignored-fenced
~~~

%% [[Ignored Comment]] #ignored-comment %%
`,
  "Research/Target.md": `---
aliases: [Unique Alias, Shared Alias]
tags: [research/alpha, Mixed]
---
# Section
Block text ^block-a
[[Projects/Hub]]
[[Archive/Target]]
`,
  "Archive/Target.md": `---
aliases: [Shared Alias]
---
# Archived target
`,
  "Inbox/Incoming.md": "[[Projects/Hub]] and [[Research/Target]]",
  "Loose/Orphan.md": "# Standalone\n#project/core",
  ...Object.fromEntries(Array.from({ length: 6 }, (_, index) => [
    `Depth/${index}.md`,
    index < 5 ? `[[Depth/${index + 1}]]` : ""
  ]))
};

const canvasFile = JSON.stringify({
  nodes: [
    {
      id: "hub-card",
      type: "file",
      file: "Projects/Hub.md",
      x: 0,
      y: 0,
      width: 320,
      height: 180
    },
    {
      id: "asset-card",
      type: "file",
      file: "Assets/diagram.png",
      x: 360,
      y: 0,
      width: 320,
      height: 180
    },
    {
      id: "pdf-card",
      type: "file",
      file: "Assets/reference.pdf",
      x: 720,
      y: 0,
      width: 320,
      height: 180
    },
    {
      id: "text-card",
      type: "text",
      text: "[[../Research/Target]] [[#Canvas Heading]] [[Missing Canvas]] #canvas/nested",
      x: 0,
      y: 220,
      width: 320,
      height: 180
    }
  ],
  edges: [
    {
      id: "visual-only-edge",
      fromNode: "hub-card",
      toNode: "asset-card",
      fromSide: "right",
      toSide: "left"
    }
  ]
}, null, 2);

// Small, valid inert fixtures. Their bytes are deterministic and contain no
// user data. Obsidian needs real attachment files for its attachment toggles.
const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);
const onePagePdf = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
    + "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
    + "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 72 72]>>endobj\n"
    + "xref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n"
    + "0000000058 00000 n \n0000000115 00000 n \n"
    + "trailer<</Size 4/Root 1 0 R>>\nstartxref\n178\n%%EOF\n",
  "utf8"
);

export const OBSIDIAN_1_13_7_ORACLE_FILES = Object.freeze({
  ...Object.fromEntries(Object.entries(markdownFiles).map(([path, content]) => [
    path,
    Buffer.from(content, "utf8")
  ])),
  "Canvas/Research.canvas": Buffer.from(canvasFile, "utf8"),
  "Assets/diagram.png": onePixelPng,
  "Assets/reference.pdf": onePagePdf
});

export function createObsidianOracleFixtureManifest() {
  const files = Object.entries(OBSIDIAN_1_13_7_ORACLE_FILES)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, bytes]) => ({
      path,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex")
    }));
  const aggregate = files
    .map(({ path, bytes, sha256 }) => `${path}\0${bytes}\0${sha256}\n`)
    .join("");

  return {
    schemaVersion: 1,
    targetObsidianVersion: "1.13.7",
    fileCount: files.length,
    files,
    sha256: createHash("sha256").update(aggregate, "utf8").digest("hex")
  };
}

export function createObsidianOracleIndexEntries() {
  return Object.entries(OBSIDIAN_1_13_7_ORACLE_FILES)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, bytes], index) => ({
      id: `oracle-${index}`,
      path,
      kind: path.endsWith(".md")
        ? "markdown"
        : path.endsWith(".canvas")
          ? "canvas"
          : "asset",
      content: path.endsWith(".md") || path.endsWith(".canvas")
        ? bytes.toString("utf8")
        : undefined,
      createdAt: index + 1
    }));
}
