import { sanitizeEditorHtml } from "../../lib/editorContent";
import { buildInternalLinkResolutionIndex, type InternalLinkResolutionIndex } from "../knowledge/path";
import type { VaultIndexEntry } from "../knowledge/types";
import { canonicalSafeExternalHttpUrl } from "../markdown/parser";
import { vaultEntryPath } from "../vault/vaultData";
import { rewritePublicationMarkdownLinks, type PublicationMarkdownLink } from "./publicationMarkdown";
import { resolvePublicWikiLink } from "./publicWikiLinkResolution";
import { wikiFolderPaths, type WikiReadableFolder, type WikiReadableNote } from "./wikiModel";

const emptyMetadata = new Map<string, { aliases: string[] }>();
const externalScheme = /^[a-z][a-z\d+.-]*:/iu;
interface CachedBody { source: string; format: string; path: string; body: string }

/** Per-reader cache: every visible string is prepared against the current public catalog. */
export class WikiPublicProjection {
  private signature = "";
  private catalog: readonly VaultIndexEntry[] = [];
  private resolutionIndex: InternalLinkResolutionIndex = buildInternalLinkResolutionIndex([], emptyMetadata);
  private bodies = new Map<string, CachedBody>();

  clear() { this.signature = ""; this.catalog = []; this.resolutionIndex = buildInternalLinkResolutionIndex([], emptyMetadata); this.bodies.clear(); }

  project(notes: readonly WikiReadableNote[], folders: readonly WikiReadableFolder[], suppliedCatalog?: readonly VaultIndexEntry[]): WikiReadableNote[] {
    const paths = wikiFolderPaths(folders);
    const projected = notes.map((note) => ({ id: note.id, path: vaultEntryPath(note, paths), kind: note.entryKind }));
    const catalog = suppliedCatalog ?? projected;
    const signature = JSON.stringify(catalog.map((entry) => [entry.id, entry.path, entry.kind]));
    if (signature !== this.signature) {
      this.clear(); this.signature = signature;
      this.catalog = catalog.map(({ id, path, kind }) => ({ id, path, kind }));
      this.resolutionIndex = buildInternalLinkResolutionIndex(this.catalog, emptyMetadata);
    }
    const visible = new Set(notes.map((note) => note.id));
    for (const id of this.bodies.keys()) if (!visible.has(id)) this.bodies.delete(id);
    const sourceById = new Map(projected.map((entry) => [entry.id, entry]));
    const catalogIds = new Set(this.catalog.map((entry) => entry.id));
    return notes.map((note) => {
      const source = sourceById.get(note.id)!;
      const previous = this.bodies.get(note.id);
      if (previous?.source === note.body && previous.format === note.contentFormat && previous.path === source.path) return { ...note, body: previous.body };
      let body = "공개 범위를 확인하지 못해 내용을 표시할 수 없습니다.";
      if (catalogIds.has(note.id)) {
        const rewrite = (link: PublicationMarkdownLink) => {
          const redact = () => link.embed ? "[비공개 첨부]" : "[비공개 링크]";
          if (externalScheme.test(link.target) || link.target.startsWith("//")) return canonicalSafeExternalHttpUrl(link.target) ? link.raw : redact();
          const path = link.target.split("#")[0];
          if (!path && link.target.startsWith("#")) return link.raw;
          const resolved = resolvePublicWikiLink({ sourceEntryId: note.id, sourcePath: source.path,
            syntax: path.startsWith("/") ? "wikilink" : link.syntax, target: path, raw: link.raw,
            embedded: link.embed, line: 0, column: 0, context: ""
          }, this.catalog, this.resolutionIndex);
          return resolved.status === "resolved" && resolved.candidateEntryIds.length === 1 ? link.raw : redact();
        };
        try {
          if (note.contentFormat === "legacy-html-v1") {
            const template = document.createElement("template");
            // The inert template retains relative targets long enough to redact
            // their labels. Sanitize before any resulting HTML is rendered.
            template.innerHTML = note.body;
            for (const link of template.content.querySelectorAll("a")) {
              if (!canonicalSafeExternalHttpUrl(link.getAttribute("href") ?? "")) link.replaceWith(document.createTextNode("[비공개 링크]"));
            }
            const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
            let textNode: Node | null;
            while ((textNode = walker.nextNode())) {
              if (!textNode.parentElement?.closest("pre, code")) textNode.textContent = rewritePublicationMarkdownLinks(textNode.textContent ?? "", rewrite);
            }
            body = sanitizeEditorHtml(template.innerHTML);
          } else body = rewritePublicationMarkdownLinks(note.body, rewrite);
        } catch { /* A bounded-parser failure must never fall back to unredacted source. */ }
      }
      this.bodies.set(note.id, { source: note.body, format: note.contentFormat, path: source.path, body });
      return { ...note, body };
    });
  }
}
