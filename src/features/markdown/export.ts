import { normalizeMarkdownLineEndings, parseWikiLinkTarget } from "./parser";

export type MarkdownExportProfile =
  | "raw"
  | "obsidian"
  | "github"
  | "notion"
  | "discord-ai";

export interface MarkdownExportOptions {
  profile: MarkdownExportProfile;
  sourcePath?: string;
  maximumChunkCharacters?: number;
  resolveWikiLinkPath?: (targetPath: string, sourcePath: string) => string | null;
}

export interface MarkdownExportResult {
  profile: MarkdownExportProfile;
  /**
   * Complete transformed Markdown. For `discord-ai`, this is an archival value,
   * not a message-size-safe clipboard payload.
   */
  content: string;
  /** @deprecated Discord/AI consumers should use `exportMarkdownForDiscordAi`. */
  chunks: string[];
  warnings: string[];
}

export interface DiscordAiMarkdownExportOptions {
  maximumMessageCharacters?: number;
  resolveWikiLinkPath?: MarkdownExportOptions["resolveWikiLinkPath"];
  sourcePath?: string;
}

export interface DiscordAiMarkdownMessage {
  readonly content: string;
  readonly index: number;
  readonly total: number;
}

interface DiscordAiMarkdownDeliveryBase {
  readonly maximumMessageCharacters: number;
  readonly messages: readonly DiscordAiMarkdownMessage[];
  readonly profile: "discord-ai";
  readonly warnings: readonly string[];
}

export type DiscordAiMarkdownDelivery =
  | (DiscordAiMarkdownDeliveryBase & {
      readonly kind: "single-message";
      readonly singleMessageContent: string;
    })
  | (DiscordAiMarkdownDeliveryBase & {
      readonly kind: "message-batch";
      readonly singleMessageContent: null;
    });

interface WikiTransformContext {
  profile: MarkdownExportProfile;
  sourcePath: string;
  resolveWikiLinkPath?: MarkdownExportOptions["resolveWikiLinkPath"];
  warnings: string[];
}

export function exportMarkdown(
  source: string,
  options: MarkdownExportOptions
): MarkdownExportResult {
  if (options.profile === "raw" || options.profile === "obsidian") {
    return {
      profile: options.profile,
      content: source,
      chunks: [source],
      warnings: []
    };
  }

  const warnings: string[] = [];
  const content = transformWikiLinksOutsideCode(source, {
    profile: options.profile,
    sourcePath: options.sourcePath ?? "Untitled.md",
    resolveWikiLinkPath: options.resolveWikiLinkPath,
    warnings
  });
  const chunks = options.profile === "discord-ai"
    ? splitMarkdownForMessages(content, options.maximumChunkCharacters ?? 1_900)
    : [content];

  return { profile: options.profile, content, chunks, warnings };
}

/**
 * Build an explicit Discord/AI message delivery contract.
 *
 * The complete transformed document is deliberately not exposed on this
 * object. A multi-message delivery has `singleMessageContent: null`, and each
 * bounded message is an object rather than a joinable string array. Consumers
 * must therefore copy or send `message.content` one message at a time instead
 * of accidentally presenting a concatenated document as one safe message.
 */
export function exportMarkdownForDiscordAi(
  source: string,
  options: DiscordAiMarkdownExportOptions = {}
): DiscordAiMarkdownDelivery {
  const maximumMessageCharacters = options.maximumMessageCharacters ?? 1_900;
  const exported = exportMarkdown(source, {
    profile: "discord-ai",
    maximumChunkCharacters: maximumMessageCharacters,
    resolveWikiLinkPath: options.resolveWikiLinkPath,
    sourcePath: options.sourcePath
  });
  const total = exported.chunks.length;
  const messages = Object.freeze(exported.chunks.map((content, offset) => Object.freeze({
    content,
    index: offset + 1,
    total
  })));
  const common = {
    maximumMessageCharacters,
    messages,
    profile: "discord-ai" as const,
    warnings: Object.freeze([...exported.warnings])
  };
  return total === 1
    ? { ...common, kind: "single-message", singleMessageContent: messages[0]?.content ?? "" }
    : { ...common, kind: "message-batch", singleMessageContent: null };
}

export function splitMarkdownForMessages(source: string, maximumCharacters = 1_900) {
  if (!Number.isInteger(maximumCharacters) || maximumCharacters < 80) {
    throw new RangeError("maximumCharacters must be an integer of at least 80");
  }
  if (source.length <= maximumCharacters) {
    return [source];
  }

  const messages: string[] = [];
  let activeFence: FenceState | null = null;
  let remaining = normalizeMarkdownLineEndings(source);
  while (remaining.length) {
    // Reopened continuation fences intentionally omit a possibly long info
    // string. Keeping the language label on the first message is sufficient,
    // while a bounded three-character marker guarantees room for source text.
    const continuationMarker = activeFence ? activeFence.marker[0].repeat(3) : "";
    const prefix = activeFence ? `${continuationMarker}\n` : "";
    const suffixBudget = 4; // newline + a three-character continuation marker
    const payloadLimit = Math.max(1, maximumCharacters - prefix.length - suffixBudget);
    let boundary = markdownMessageBoundary(remaining, payloadLimit);
    let chunk = remaining.slice(0, boundary);
    let nextFence = fenceStateAfter(chunk, activeFence);
    let suffix = nextFence ? `\n${nextFence.marker[0].repeat(3)}` : "";

    // A chunk that closes its fence does not need the reserved suffix and can
    // use the full remaining budget. Conversely, unusual long fence markers
    // are reduced without ever slicing an already assembled message, because
    // slicing there would silently discard source Markdown.
    while (`${prefix}${chunk}${suffix}`.length > maximumCharacters && boundary > 1) {
      boundary = Math.max(1, boundary - (`${prefix}${chunk}${suffix}`.length - maximumCharacters));
      chunk = remaining.slice(0, boundary);
      nextFence = fenceStateAfter(chunk, activeFence);
      suffix = nextFence ? `\n${nextFence.marker[0].repeat(3)}` : "";
    }

    messages.push(`${prefix}${chunk}${suffix}`);
    remaining = remaining.slice(boundary);
    activeFence = nextFence;
  }

  return messages;
}

function markdownMessageBoundary(source: string, maximumPayload: number) {
  if (source.length <= maximumPayload) return source.length;
  const minimumPreferredBoundary = maximumPayload / 3;
  for (const separator of ["\n\n", "\n", " "]) {
    const boundary = source.lastIndexOf(separator, maximumPayload);
    if (boundary >= minimumPreferredBoundary) return boundary;
  }
  return maximumPayload;
}

function transformWikiLinksOutsideCode(source: string, context: WikiTransformContext) {
  const lines = normalizeMarkdownLineEndings(source).split("\n");
  let fence: FenceState | null = null;
  return lines.map((line) => {
    const match = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (match) {
      if (!fence) {
        fence = { marker: match[1], info: match[2] };
      } else if (match[1][0] === fence.marker[0] && match[1].length >= fence.marker.length) {
        fence = null;
      }
      return line;
    }
    return fence ? line : transformWikiLinksInInlineSource(line, context);
  }).join("\n");
}

function transformWikiLinksInInlineSource(source: string, context: WikiTransformContext) {
  let result = "";
  let index = 0;
  while (index < source.length) {
    if (source[index] === "`") {
      let markerLength = 1;
      while (source[index + markerLength] === "`") {
        markerLength += 1;
      }
      const marker = "`".repeat(markerLength);
      const closing = source.indexOf(marker, index + markerLength);
      if (closing !== -1) {
        result += source.slice(index, closing + markerLength);
        index = closing + markerLength;
        continue;
      }
    }

    const embed = source.startsWith("![[", index);
    if (embed || source.startsWith("[[", index)) {
      const contentStart = index + (embed ? 3 : 2);
      const closing = source.indexOf("]]", contentStart);
      if (closing !== -1) {
        const raw = source.slice(index, closing + 2);
        const parsed = parseWikiLinkTarget(source.slice(contentStart, closing));
        result += parsed ? exportedWikiLink(parsed, embed, context) : raw;
        index = closing + 2;
        continue;
      }
    }

    result += source[index];
    index += 1;
  }
  return result;
}

function exportedWikiLink(
  parsed: NonNullable<ReturnType<typeof parseWikiLinkTarget>>,
  embed: boolean,
  context: WikiTransformContext
) {
  if (context.profile === "discord-ai") {
    return parsed.display;
  }

  const destination = exportedDestination(parsed.path, parsed.subpath, context);
  const label = escapeMarkdownLinkLabel(parsed.display);
  const image = embed && isLikelyImagePath(parsed.path);
  return `${image ? "!" : ""}[${label}](${destination})`;
}

function exportedDestination(
  targetPath: string,
  subpath: string | null,
  context: WikiTransformContext
) {
  let relative = "";
  if (targetPath) {
    const resolvedPath = context.resolveWikiLinkPath?.(targetPath, context.sourcePath)
      ?? defaultResolvedWikiPath(targetPath, context.sourcePath);
    const extensionPath = /\.[a-z\d]{1,8}$/i.test(resolvedPath)
      ? resolvedPath
      : `${resolvedPath}.md`;
    relative = relativeVaultPath(context.sourcePath, extensionPath);
  }

  let fragment = "";
  if (subpath?.startsWith("#^")) {
    context.warnings.push(`블록 참조 ${subpath}는 ${context.profile}에서 지원되지 않아 파일 링크로 변환했습니다.`);
  } else if (subpath) {
    fragment = `#${githubHeadingSlug(subpath.slice(1))}`;
  }

  const encodedPath = relative
    ? relative.split("/").map((segment) => encodeURIComponent(segment)).join("/")
    : "";
  return encodedPath || fragment ? `${encodedPath}${fragment}` : "#";
}

function defaultResolvedWikiPath(targetPath: string, sourcePath: string) {
  if (targetPath.startsWith("/") || targetPath.includes("/")) {
    return targetPath;
  }
  const directory = sourcePath.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
  return directory ? `${directory}/${targetPath}` : targetPath;
}

function relativeVaultPath(sourcePath: string, targetPath: string) {
  const source = normalizeVaultSegments(sourcePath);
  source.pop();
  const target = targetPath.startsWith("/")
    ? normalizeVaultSegments(targetPath)
    : normalizeVaultSegments(targetPath);
  let shared = 0;
  while (shared < source.length && shared < target.length && source[shared] === target[shared]) {
    shared += 1;
  }
  const upward = Array.from({ length: source.length - shared }, () => "..");
  const result = [...upward, ...target.slice(shared)].join("/");
  return result || target.at(-1) || "";
}

function normalizeVaultSegments(path: string) {
  const segments: string[] = [];
  for (const segment of path.replace(/\\/g, "/").split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments;
}

function githubHeadingSlug(value: string) {
  return value
    .normalize("NFC")
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, "")
    .replace(/\s+/g, "-");
}

function escapeMarkdownLinkLabel(value: string) {
  return value.replace(/([\\\]])/g, "\\$1");
}

function isLikelyImagePath(path: string) {
  return /\.(?:avif|gif|jpe?g|png|svg|webp)$/i.test(path);
}

interface FenceState {
  marker: string;
  info: string;
}

function fenceStateAfter(source: string, initial: FenceState | null) {
  let active = initial;
  for (const line of source.split("\n")) {
    const match = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (!match) {
      continue;
    }
    if (!active) {
      active = { marker: match[1], info: match[2] };
    } else if (match[1][0] === active.marker[0] && match[1].length >= active.marker.length) {
      active = null;
    }
  }
  return active;
}
