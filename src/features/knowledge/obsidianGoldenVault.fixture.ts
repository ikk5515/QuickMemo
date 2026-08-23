import type { VaultIndexEntry } from "./types";

function markdownEntry(
  id: string,
  path: string,
  content: string,
  createdAt: number
): VaultIndexEntry {
  return { id, path, kind: "markdown", content, createdAt };
}

/**
 * QuickMemo's deterministic local contract fixture for Obsidian-style
 * knowledge behavior.
 *
 * This is not output captured from, or an oracle comparison against, the
 * official Obsidian application. It intentionally combines syntax variants
 * that must collapse to one knowledge edge while remaining separate backlink
 * occurrences. Visual Canvas edges are a negative fixture: only file cards and
 * Markdown links inside text cards belong in the knowledge graph.
 */
export const LOCAL_OBSIDIAN_CONTRACT_VAULT: readonly VaultIndexEntry[] = [
  markdownEntry(
    "hub",
    "Projects/Hub.md",
    `---
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
${"`"}[[Ignored Inline]] #ignored-inline${"`"}

~~~md
[[Ignored Fenced]] #ignored-fenced
~~~

%% [[Ignored Comment]] #ignored-comment %%
`,
    10
  ),
  markdownEntry(
    "research-target",
    "Research/Target.md",
    `---
aliases: [Unique Alias, Shared Alias]
tags: [research/alpha, Mixed]
---
# Section
Block text ^block-a
[[Projects/Hub]]
[[Archive/Target]]
`,
    20
  ),
  markdownEntry(
    "archive-target",
    "Archive/Target.md",
    `---
aliases: [Shared Alias]
---
# Archived target
`,
    30
  ),
  markdownEntry(
    "incoming",
    "Inbox/Incoming.md",
    "[[Projects/Hub]] and [[Research/Target]]",
    40
  ),
  markdownEntry(
    "orphan",
    "Loose/Orphan.md",
    "# Standalone\n#project/core",
    50
  ),
  {
    id: "canvas",
    path: "Canvas/Research.canvas",
    kind: "canvas",
    createdAt: 60,
    content: JSON.stringify({
      nodes: [
        { id: "hub-card", type: "file", file: "Projects/Hub.md", x: 0, y: 0, width: 320, height: 180 },
        { id: "asset-card", type: "file", file: "Assets/diagram.png", x: 360, y: 0, width: 320, height: 180 },
        { id: "pdf-card", type: "file", file: "Assets/reference.pdf", x: 720, y: 0, width: 320, height: 180 },
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
    })
  },
  {
    id: "asset",
    path: "Assets/diagram.png",
    kind: "asset",
    createdAt: 70
  },
  {
    id: "asset-pdf",
    path: "Assets/reference.pdf",
    kind: "asset",
    createdAt: 80
  },
  ...Array.from({ length: 6 }, (_, position): VaultIndexEntry => ({
    id: `depth-${position}`,
    path: `Depth/${position}.md`,
    kind: "markdown",
    content: position < 5 ? `[[Depth/${position + 1}]]` : "",
    createdAt: 90 + position
  }))
] as const;

export const LOCAL_OBSIDIAN_CONTRACT_IDS = {
  entries: [
    "entry:archive-target",
    "entry:canvas",
    "entry:depth-0",
    "entry:depth-1",
    "entry:depth-2",
    "entry:depth-3",
    "entry:depth-4",
    "entry:depth-5",
    "entry:hub",
    "entry:incoming",
    "entry:orphan",
    "entry:research-target"
  ],
  unresolved: [
    "unresolved:ignored comment",
    "unresolved:missing canvas",
    "unresolved:missing note",
    "unresolved:shared alias",
    "unresolved:unique alias"
  ]
} as const;

/**
 * Reviewable topology totals for the fixture above. Tests also derive and
 * assert every value so edits cannot silently change the contract.
 */
export const LOCAL_OBSIDIAN_CONTRACT_COUNTS = {
  vaultEntries: 14,
  markdownEntries: 11,
  canvasEntries: 1,
  assetEntries: 2,
  linkOccurrences: {
    total: 28,
    resolved: 23,
    ambiguous: 0,
    unresolved: 5,
    hub: 13,
    canvas: 6
  },
  tags: {
    nodes: 6,
    edges: 7
  },
  defaultGlobal: {
    nodes: 17,
    edges: 20,
    representedLinkOccurrences: 24
  },
  withAttachments: {
    nodes: 19,
    edges: 24,
    representedLinkOccurrences: 28
  }
} as const;
