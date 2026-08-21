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
  content: string;
  chunks: string[];
  warnings: string[];
}

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

export function splitMarkdownForMessages(source: string, maximumCharacters = 1_900) {
  if (!Number.isInteger(maximumCharacters) || maximumCharacters < 80) {
    throw new RangeError("maximumCharacters must be an integer of at least 80");
  }
  if (source.length <= maximumCharacters) {
    return [source];
  }

  const payloadLimit = Math.max(1, maximumCharacters - 48);
  const rawChunks: string[] = [];
  let remaining = normalizeMarkdownLineEndings(source);
  while (remaining.length > payloadLimit) {
    let boundary = remaining.lastIndexOf("\n\n", payloadLimit);
    let separatorLength = 2;
    if (boundary < payloadLimit / 3) {
      boundary = remaining.lastIndexOf("\n", payloadLimit);
      separatorLength = 1;
    }
    if (boundary < payloadLimit / 3) {
      boundary = remaining.lastIndexOf(" ", payloadLimit);
      separatorLength = 1;
    }
    if (boundary <= 0) {
      boundary = payloadLimit;
      separatorLength = 0;
    }
    rawChunks.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary + separatorLength);
  }
  rawChunks.push(remaining);

  let activeFence: FenceState | null = null;
  return rawChunks.map((chunk) => {
    const prefix = activeFence ? `${activeFence.marker}${activeFence.info}\n` : "";
    activeFence = fenceStateAfter(chunk, activeFence);
    const suffix = activeFence ? `\n${activeFence.marker}` : "";
    const repaired = `${prefix}${chunk}${suffix}`;
    return repaired.length <= maximumCharacters
      ? repaired
      : repaired.slice(0, maximumCharacters);
  });
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
