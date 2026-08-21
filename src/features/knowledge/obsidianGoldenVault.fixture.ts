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
 * A deterministic compatibility vault for the public Obsidian graph contract.
 *
 * The fixture intentionally combines syntax variants that must collapse to one
 * knowledge edge while remaining separate backlink occurrences. Visual Canvas
 * edges are present as a negative fixture: only file cards and Markdown links
 * inside text cards belong in the knowledge graph.
 */
export const OBSIDIAN_GOLDEN_VAULT: readonly VaultIndexEntry[] = [
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
[relative](../Research/Target.md#Section)

#inline/tag #PROJECT/CORE
${"`"}[[Ignored Inline]] #ignored-inline${"`"}

~~~md
[[Ignored Fenced]] #ignored-fenced
~~~
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
  }
] as const;

export const OBSIDIAN_GOLDEN_IDS = {
  entries: [
    "entry:archive-target",
    "entry:canvas",
    "entry:hub",
    "entry:incoming",
    "entry:orphan",
    "entry:research-target"
  ],
  unresolved: [
    "unresolved:missing canvas",
    "unresolved:missing note",
    "unresolved:shared alias",
    "unresolved:target"
  ]
} as const;
