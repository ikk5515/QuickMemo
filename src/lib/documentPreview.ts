import { Decompress, strFromU8, unzipSync, type UnzipFileInfo } from "fflate";
import { safeRasterDataUrl } from "./safeRasterImage";

const maxTextPreviewCharacters = 120_000;
const maxDocumentPreviewBlocks = 320;
const maxDocxPreviewMarkupCharacters = 1_600_000;
const maxZipPreviewEntries = 512;
const maxZipPreviewEntryNameLength = 240;
const maxZipPreviewCompressionRatio = 120;
const minZipPreviewRatioCheckBytes = 64_000;
const maxDocxPreviewUncompressedBytes = 12_000_000;
const maxDocxPreviewEntryBytes = 6_000_000;
const maxHwpxPreviewEntries = 80;
const maxHwpxPreviewUncompressedBytes = 4_000_000;
const maxHwpxPreviewEntryBytes = 1_500_000;
const maxXlsxPreviewEntries = 140;
const maxXlsxPreviewUncompressedBytes = 5_000_000;
const maxXlsxPreviewEntryBytes = 2_000_000;
const maxXlsxMetadataXmlCharacters = 800_000;
const maxXlsxSharedStrings = 5_000;
const maxXlsxSharedStringCharacters = 240;
const maxXlsxSharedStringsXmlCharacters = 1_500_000;
const maxXlsxStyleRecords = 1_024;
const maxXlsxWorksheetXmlCharacters = 1_500_000;
const maxHwpPreviewSectionBytes = 1_500_000;
const maxHwpPreviewTotalBytes = 4_000_000;
const hwpPreviewCompressedChunkBytes = 16_384;

const docxPreviewFrameCsp = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "script-src 'none'",
  "img-src data: blob:",
  "font-src data:",
  "style-src 'unsafe-inline'"
].join("; ");

export async function renderSafeDocxPreviewSrcDoc(bytes: Uint8Array, theme: "light" | "dark" = "light") {
  if (typeof document === "undefined") {
    return "";
  }

  try {
    if (
      !safeZipPreviewEntries(bytes, {
        maxEntries: maxZipPreviewEntries,
        maxEntryUncompressedBytes: maxDocxPreviewEntryBytes,
        maxSelectedEntries: maxZipPreviewEntries,
        maxTotalUncompressedBytes: maxDocxPreviewUncompressedBytes
      })
    ) {
      return "";
    }

    const { renderAsync } = await import("docx-preview");
    const previewDocument = document.implementation.createHTMLDocument("DOCX Preview");
    const styleContainer = previewDocument.createElement("div");
    const bodyContainer = previewDocument.createElement("div");

    previewDocument.body.append(styleContainer, bodyContainer);

    await renderAsync(bytes.slice(), bodyContainer, styleContainer, {
      breakPages: true,
      className: "qm-docx",
      experimental: false,
      ignoreFonts: true,
      ignoreHeight: false,
      ignoreLastRenderedPageBreak: false,
      ignoreWidth: false,
      inWrapper: true,
      renderAltChunks: false,
      renderChanges: false,
      renderComments: false,
      renderEndnotes: true,
      renderFooters: true,
      renderFootnotes: true,
      renderHeaders: true,
      trimXmlDeclaration: true,
      useBase64URL: true
    });

    sanitizeDocxPreviewTree(bodyContainer);

    const styleText = sanitizeDocxPreviewCss(
      Array.from(styleContainer.querySelectorAll("style"))
        .map((styleElement) => styleElement.textContent ?? "")
        .join("\n")
    );
    const bodyHtml = bodyContainer.innerHTML;

    if (!bodyHtml.trim() || bodyHtml.length > maxDocxPreviewMarkupCharacters) {
      return "";
    }

    return docxSandboxSrcDoc(styleText, bodyHtml, theme);
  } catch {
    return "";
  }
}

function docxSandboxSrcDoc(styleText: string, bodyHtml: string, theme: "light" | "dark") {
  const lightBaseStyle = [
    "html,body{margin:0;min-height:100%;background:#f8fafc;color:#14211f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}",
    "body{box-sizing:border-box;padding:16px;}",
    ".docx-preview-content{box-sizing:border-box;margin:0 auto;max-width:100%;overflow:auto;}",
    ".qm-docx-wrapper{box-sizing:border-box;max-width:100%;}",
    ".qm-docx{box-sizing:border-box;margin:0 auto 16px;max-width:100%;overflow:hidden;background:#fff;border:1px solid #e2e8f0;box-shadow:0 10px 24px rgb(15 23 42 / 8%);}",
    ".qm-docx *{box-sizing:border-box;}",
    ".qm-docx img{max-width:100%;height:auto;}",
    ".qm-docx table{max-width:100%;border-collapse:collapse;}",
    "a{color:#2563eb;text-decoration:underline;}",
    "@media (max-width:680px){body{padding:10px}.qm-docx{box-shadow:none}}"
  ].join("\n");
  const darkBaseStyle = [
    "html,body{margin:0;min-height:100%;background:#09090b;color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color-scheme:dark;}",
    "body{box-sizing:border-box;padding:16px;}",
    ".docx-preview-content{box-sizing:border-box;margin:0 auto;max-width:100%;overflow:auto;}",
    ".qm-docx-wrapper{box-sizing:border-box;max-width:100%;}",
    ".qm-docx{box-sizing:border-box;margin:0 auto 16px;max-width:100%;overflow:hidden;background:#18181b;border:1px solid #3a3a40;box-shadow:0 14px 34px rgb(0 0 0 / 22%);color:#f4f4f5;}",
    ".qm-docx *{box-sizing:border-box;}",
    ".qm-docx img{max-width:100%;height:auto;}",
    ".qm-docx table{max-width:100%;border-collapse:collapse;}",
    "a{color:#93c5fd;text-decoration:underline;}",
    "@media (max-width:680px){body{padding:10px}.qm-docx{box-shadow:none}}"
  ].join("\n");
  const baseStyle = theme === "dark" ? darkBaseStyle : lightBaseStyle;

  return [
    "<!doctype html>",
    `<html lang="ko" data-theme="${theme}">`,
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(docxPreviewFrameCsp)}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style>${escapeStyleText(`${baseStyle}\n${styleText}`)}</style>`,
    "</head>",
    "<body>",
    `<main class="docx-preview-content">${bodyHtml}</main>`,
    "</body>",
    "</html>"
  ].join("");
}

function sanitizeDocxPreviewTree(root: HTMLElement) {
  Array.from(root.querySelectorAll<HTMLElement>("*")).forEach((element) => {
    if (isForbiddenDocxPreviewTag(element.tagName)) {
      element.remove();
      return;
    }

    sanitizeDocxPreviewAttributes(element);
  });
}

function isForbiddenDocxPreviewTag(tagName: string) {
  return new Set([
    "BASE",
    "BUTTON",
    "EMBED",
    "FORM",
    "IFRAME",
    "INPUT",
    "LINK",
    "META",
    "OBJECT",
    "SCRIPT",
    "SELECT",
    "STYLE",
    "SVG",
    "TEXTAREA",
    "VIDEO",
    "AUDIO",
    "SOURCE"
  ]).has(tagName);
}

function sanitizeDocxPreviewAttributes(element: HTMLElement) {
  Array.from(element.attributes).forEach((attribute) => {
    const attributeName = attribute.name.toLowerCase();
    const attributeValue = attribute.value;

    if (
      attributeName.startsWith("on") ||
      attributeName === "srcdoc" ||
      attributeName === "formaction" ||
      attributeName === "action" ||
      attributeName === "poster" ||
      attributeName === "background" ||
      attributeName.includes(":")
    ) {
      element.removeAttribute(attribute.name);
      return;
    }

    if (attributeName === "href") {
      const safeHref = element.tagName === "A" ? safeDocxPreviewHref(attributeValue) : null;

      if (safeHref) {
        element.setAttribute("href", safeHref);
        element.setAttribute("target", "_blank");
        element.setAttribute("rel", "noopener noreferrer");
      } else {
        element.removeAttribute(attribute.name);
      }
      return;
    }

    if (attributeName === "src") {
      const safeSrc = element.tagName === "IMG" ? safeDocxPreviewImageSrc(attributeValue) : null;

      if (safeSrc) {
        element.setAttribute("src", safeSrc);
      } else {
        element.remove();
      }
      return;
    }

    if (attributeName === "style") {
      const safeStyle = sanitizeDocxStyleAttribute(attributeValue);

      if (safeStyle) {
        element.setAttribute("style", safeStyle);
      } else {
        element.removeAttribute(attribute.name);
      }
      return;
    }

    if (attributeName === "class") {
      const safeClassName = attributeValue
        .split(/\s+/)
        .map((className) => className.replace(/[^A-Za-z0-9_-]/g, ""))
        .filter(Boolean)
        .slice(0, 24)
        .join(" ");

      if (safeClassName) {
        element.setAttribute("class", safeClassName);
      } else {
        element.removeAttribute(attribute.name);
      }
      return;
    }

    if (!isAllowedDocxPreviewAttribute(attributeName)) {
      element.removeAttribute(attribute.name);
    } else {
      element.setAttribute(attribute.name, safeDocxPreviewAttributeText(attributeValue));
    }
  });
}

function isAllowedDocxPreviewAttribute(attributeName: string) {
  return new Set([
    "alt",
    "aria-label",
    "colspan",
    "dir",
    "height",
    "lang",
    "role",
    "rowspan",
    "title",
    "width"
  ]).has(attributeName);
}

function safeDocxPreviewHref(value: string) {
  try {
    const url = new URL(value, "https://quickmemo.invalid");

    if (url.protocol === "http:" || url.protocol === "https:") {
      return url.href;
    }
  } catch {
    return null;
  }

  return null;
}

function safeDocxPreviewImageSrc(value: string) {
  const trimmedValue = value.trim();

  return safeRasterDataUrl(trimmedValue) ? trimmedValue : null;
}

function sanitizeDocxPreviewCss(cssText: string) {
  return cssText
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/@import\b[^;]*;?/gi, "")
    .replace(/url\s*\([^)]*\)/gi, "none")
    .replace(/expression\s*\([^)]*\)/gi, "")
    .replace(/javascript\s*:/gi, "")
    .replace(/vbscript\s*:/gi, "")
    .replace(/-moz-binding\s*:[^;}]*/gi, "")
    .replace(/behavior\s*:[^;}]*/gi, "")
    .slice(0, maxDocxPreviewMarkupCharacters);
}

function sanitizeDocxStyleAttribute(styleText: string) {
  return styleText
    .split(";")
    .map((declaration) => {
      const [propertyName, ...propertyValueParts] = declaration.split(":");
      const property = propertyName?.trim().toLowerCase() ?? "";
      const value = propertyValueParts.join(":").trim();

      if (!property || !value || !/^[-a-z0-9]+$/i.test(property) || !isSafeDocxCssValue(value)) {
        return "";
      }

      return `${property}: ${value}`;
    })
    .filter(Boolean)
    .join("; ");
}

function isSafeDocxCssValue(value: string) {
  const normalizedValue = value.toLowerCase();
  return !/(?:url\s*\(|expression\s*\(|javascript\s*:|vbscript\s*:|data\s*:\s*text\/html|-moz-binding|behavior\s*:|@import)/i.test(normalizedValue);
}

function safeDocxPreviewAttributeText(value: string) {
  return Array.from(value)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127 && !`<>"'\``.includes(character);
    })
    .join("")
    .slice(0, 240);
}

function escapeStyleText(value: string) {
  return value.replace(/<\/style/gi, "<\\/style").replace(/<!--/g, "").replace(/-->/g, "");
}

interface ZipPreviewLimits {
  includeEntry?: (name: string) => boolean;
  maxEntries: number;
  maxEntryUncompressedBytes: number;
  maxSelectedEntries: number;
  maxTotalUncompressedBytes: number;
}

interface ZipPreviewState {
  entryCount: number;
  selectedCount: number;
  selectedNames: Set<string>;
  totalUncompressedBytes: number;
}

function safeZipPreviewEntries(bytes: Uint8Array, limits: ZipPreviewLimits) {
  const state: ZipPreviewState = {
    entryCount: 0,
    selectedCount: 0,
    selectedNames: new Set<string>(),
    totalUncompressedBytes: 0
  };

  try {
    const inflatedEntries = unzipSync(bytes, {
      filter: (file) => shouldInflateZipPreviewEntry(file, limits, state)
    });

    if (!state.selectedCount) {
      return null;
    }

    const entries: Record<string, Uint8Array> = {};
    let verifiedTotalBytes = 0;

    Object.entries(inflatedEntries).forEach(([name, entry]) => {
      const normalizedName = normalizeZipPreviewEntryName(name);

      if (!normalizedName || !state.selectedNames.has(normalizedName)) {
        return;
      }

      verifiedTotalBytes += entry.length;

      if (entry.length > limits.maxEntryUncompressedBytes || verifiedTotalBytes > limits.maxTotalUncompressedBytes) {
        throw new Error("ZIP preview entry exceeded safe inflated limits.");
      }

      entries[normalizedName] = entry;
    });

    return entries;
  } catch {
    return null;
  }
}

function shouldInflateZipPreviewEntry(file: UnzipFileInfo, limits: ZipPreviewLimits, state: ZipPreviewState) {
  state.entryCount += 1;

  if (state.entryCount > limits.maxEntries) {
    throw new Error("ZIP preview entry count exceeded safe limits.");
  }

  const normalizedName = normalizeZipPreviewEntryName(file.name);

  if (!normalizedName) {
    throw new Error("ZIP preview entry path is unsafe.");
  }

  const isDirectory = normalizedName.endsWith("/");
  const selected = !isDirectory && (limits.includeEntry ? limits.includeEntry(normalizedName) : true);

  if (!selected) {
    return false;
  }

  if (file.compression !== 0 && file.compression !== 8) {
    throw new Error("ZIP preview entry uses an unsupported compression method.");
  }

  if (!safeZipPreviewSize(file.size) || !safeZipPreviewSize(file.originalSize)) {
    throw new Error("ZIP preview entry has invalid size metadata.");
  }

  const compressedSize = Math.max(file.size, 1);
  const compressionRatio = file.originalSize / compressedSize;
  const nextTotalBytes = state.totalUncompressedBytes + file.originalSize;

  if (
    file.originalSize > limits.maxEntryUncompressedBytes
    || nextTotalBytes > limits.maxTotalUncompressedBytes
    || (
      file.originalSize >= minZipPreviewRatioCheckBytes
      && compressionRatio > maxZipPreviewCompressionRatio
    )
  ) {
    throw new Error("ZIP preview entry exceeded safe compression limits.");
  }

  state.selectedCount += 1;

  if (state.selectedCount > limits.maxSelectedEntries) {
    throw new Error("ZIP preview selected entry count exceeded safe limits.");
  }

  state.totalUncompressedBytes = nextTotalBytes;
  state.selectedNames.add(normalizedName);
  return true;
}

function safeZipPreviewSize(value: number) {
  return Number.isSafeInteger(value) && value >= 0;
}

function normalizeZipPreviewEntryName(name: string) {
  const normalizedName = name.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();

  if (
    !normalizedName
    || normalizedName.length > maxZipPreviewEntryNameLength
    || normalizedName.startsWith("/")
    || normalizedName.includes("../")
    || normalizedName.split("/").some((part) => part === "..")
  ) {
    return "";
  }

  return normalizedName;
}

interface HwpPreviewResult {
  html: string;
  safeForRichPreview: boolean;
}

interface HwpPreviewByteBudget {
  remainingBytes: number;
}

export async function extractHwpPreviewHtml(bytes: Uint8Array): Promise<HwpPreviewResult> {
  try {
    const CFB = await import("cfb");
    const container = CFB.read(bytes, { type: "array" });
    const header = cfbEntryBytes(CFB.find(container, "FileHeader"));
    const headerInfo = hwpHeaderInfo(header);

    if (!headerInfo || headerInfo.encrypted || headerInfo.distributed) {
      return { html: "", safeForRichPreview: false };
    }

    const blocks: string[] = [];
    const budget = { remainingBytes: maxHwpPreviewTotalBytes };
    for (const { entry } of hwpSectionEntries(container)) {
      if (blocks.length >= maxDocumentPreviewBlocks) {
        break;
      }

      const sectionBytes = cfbEntryBytes(entry);
      const decodedBytes = headerInfo.compressed
        ? decompressHwpSectionBytes(sectionBytes, budget)
        : boundedHwpSectionBytes(sectionBytes, budget);

      if (!decodedBytes) {
        break;
      }

      appendHwpSectionBlocks(decodedBytes, blocks);
    }

    // HWP is rendered only as sanitized, bounded text. hwp.js parses the full
    // compound file and can expand unvalidated sections beyond this preview budget.
    return { html: documentPreviewHtml(blocks), safeForRichPreview: false };
  } catch {
    return { html: "", safeForRichPreview: false };
  }
}

export function extractHwpxPreviewHtml(bytes: Uint8Array) {
  if (typeof DOMParser === "undefined") {
    return "";
  }

  try {
    const entries = safeZipPreviewEntries(bytes, {
      includeEntry: (name) => hwpxPreviewEntryPriority(name) > 0,
      maxEntries: maxZipPreviewEntries,
      maxEntryUncompressedBytes: maxHwpxPreviewEntryBytes,
      maxSelectedEntries: maxHwpxPreviewEntries,
      maxTotalUncompressedBytes: maxHwpxPreviewUncompressedBytes
    });

    if (!entries) {
      return "";
    }

    const blocks: string[] = [];

    Object.entries(entries)
      .filter(([name]) => hwpxPreviewEntryPriority(name) > 0)
      .sort(([leftName], [rightName]) => hwpxPreviewEntryPriority(rightName) - hwpxPreviewEntryPriority(leftName))
      .slice(0, 80)
      .forEach(([, entry]) => {
        if (blocks.length >= maxDocumentPreviewBlocks) {
          return;
        }

        collectHwpxPreviewBlocks(strFromU8(entry), blocks);
      });

    return documentPreviewHtml(blocks);
  } catch {
    return "";
  }
}

export function extractXlsxPreviewHtml(bytes: Uint8Array) {
  if (typeof DOMParser === "undefined") {
    return "";
  }

  try {
    const entries = safeZipPreviewEntries(bytes, {
      includeEntry: xlsxPreviewEntryAllowed,
      maxEntries: maxZipPreviewEntries,
      maxEntryUncompressedBytes: maxXlsxPreviewEntryBytes,
      maxSelectedEntries: maxXlsxPreviewEntries,
      maxTotalUncompressedBytes: maxXlsxPreviewUncompressedBytes
    });

    if (!entries) {
      return "";
    }

    const sharedStrings = xlsxSharedStrings(entries);
    const sheets = xlsxWorkbookSheets(entries);
    const styles = xlsxStyles(entries);
    const blocks: string[] = [];

    sheets.slice(0, 5).forEach((sheet) => {
      if (blocks.length >= maxDocumentPreviewBlocks) {
        return;
      }

      const worksheet = entries[sheet.path.toLowerCase()];

      if (!worksheet) {
        return;
      }

      const table = renderXlsxWorksheet(worksheet, sharedStrings, styles);

      if (table) {
        blocks.push(`<h3>${escapeHtml(sheet.name)}</h3>`);
        blocks.push(table);
      }
    });

    return documentPreviewHtml(blocks);
  } catch {
    return "";
  }
}

function xlsxPreviewEntryAllowed(name: string) {
  return (
    name === "xl/workbook.xml"
    || name === "xl/_rels/workbook.xml.rels"
    || name === "xl/sharedstrings.xml"
    || name === "xl/styles.xml"
    || /^xl\/worksheets\/[^/]+\.xml$/i.test(name)
  );
}

function xlsxElementsByLocalName(element: Element, name: string, limit: number) {
  const result: Element[] = [];
  const children = element.getElementsByTagName("*");

  for (let index = 0; index < children.length && result.length < limit; index += 1) {
    const child = children.item(index);

    if (child?.localName.toLowerCase() === name) {
      result.push(child);
    }
  }

  return result;
}

function xlsxSharedStrings(entries: Record<string, Uint8Array>) {
  const document = xlsxXmlDocument(entries, "xl/sharedStrings.xml", maxXlsxSharedStringsXmlCharacters);

  if (!document) {
    return [];
  }

  return xlsxElementsByLocalName(document.documentElement, "si", maxXlsxSharedStrings).map((item) =>
    normalizePreviewText(
      xlsxElementsByLocalName(item, "t", 64)
        .map((textNode) => textNode.textContent ?? "")
        .join("")
        .slice(0, maxXlsxSharedStringCharacters)
    )
  );
}

function xlsxWorkbookSheets(entries: Record<string, Uint8Array>) {
  const workbook = xlsxXmlDocument(entries, "xl/workbook.xml");

  if (!workbook) {
    return [];
  }

  const relationships = xlsxWorkbookRelationships(entries);

  return xlsxElementsByLocalName(workbook.documentElement, "sheet", 20)
    .map((sheet, index) => {
      const relationshipId =
        sheet.getAttribute("r:id") ?? sheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") ?? "";
      const fallbackPath = `xl/worksheets/sheet${index + 1}.xml`;

      return {
        name: normalizePreviewText(sheet.getAttribute("name") ?? `Sheet ${index + 1}`) || `Sheet ${index + 1}`,
        path: relationships.get(relationshipId) ?? fallbackPath
      };
    });
}

function xlsxWorkbookRelationships(entries: Record<string, Uint8Array>) {
  const relationships = new Map<string, string>();
  const document = xlsxXmlDocument(entries, "xl/_rels/workbook.xml.rels");

  if (!document) {
    return relationships;
  }

  xlsxElementsByLocalName(document.documentElement, "Relationship", 200).forEach((relationship) => {
    const id = relationship.getAttribute("Id");
    const target = relationship.getAttribute("Target");
    const normalizedTarget = normalizeXlsxTargetPath(target);

    if (id && normalizedTarget) {
      relationships.set(id, normalizedTarget);
    }
  });

  return relationships;
}

function normalizeXlsxTargetPath(target: string | null) {
  if (!target || target.includes("..")) {
    return "";
  }

  const trimmedTarget = target.replace(/^\/+/, "").toLowerCase();
  return trimmedTarget.startsWith("xl/") ? trimmedTarget : `xl/${trimmedTarget}`;
}

function xlsxXmlDocument(entries: Record<string, Uint8Array>, path: string, maxCharacters = maxXlsxMetadataXmlCharacters) {
  const entry = entries[path.toLowerCase()];

  if (!entry) {
    return null;
  }

  const markup = xlsxEntryText(entry, maxCharacters);

  if (!markup) {
    return null;
  }

  const document = new DOMParser().parseFromString(markup, "application/xml");
  return document.querySelector("parsererror") ? null : document;
}

function xlsxEntryText(entry: Uint8Array, maxCharacters: number) {
  if (entry.length > maxCharacters) {
    return "";
  }

  const markup = strFromU8(entry);
  return markup.length <= maxCharacters ? markup : "";
}

interface XlsxFontStyle {
  bold: boolean;
  color: string | null;
  italic: boolean;
  strike: boolean;
  underline: boolean;
}

interface XlsxCellFormat {
  fillId: number;
  fontId: number;
  horizontal: string | null;
  numFmtId: number;
  vertical: string | null;
  wrapText: boolean;
}

interface XlsxStyles {
  cellFormats: XlsxCellFormat[];
  fills: Array<string | null>;
  fonts: XlsxFontStyle[];
  numberFormats: Map<number, string>;
}

const builtinXlsxNumberFormats = new Map<number, string>([
  [9, "0%"],
  [10, "0.00%"],
  [11, "0.00E+00"],
  [12, "# ?/?"],
  [13, "# ??/??"],
  [14, "m/d/yy"],
  [15, "d-mmm-yy"],
  [16, "d-mmm"],
  [17, "mmm-yy"],
  [18, "h:mm AM/PM"],
  [19, "h:mm:ss AM/PM"],
  [20, "h:mm"],
  [21, "h:mm:ss"],
  [22, "m/d/yy h:mm"],
  [37, "#,##0 ;(#,##0)"],
  [38, "#,##0 ;[Red](#,##0)"],
  [39, "#,##0.00;(#,##0.00)"],
  [40, "#,##0.00;[Red](#,##0.00)"],
  [45, "mm:ss"],
  [46, "[h]:mm:ss"],
  [47, "mmss.0"],
  [49, "@"]
]);
const xlsxExcelMaxColumns = 16_384;
const xlsxExcelMaxRows = 1_048_576;
const xlsxPreviewMaxColumns = 50;
const xlsxPreviewMaxMergeRanges = 200;
const xlsxPreviewMaxRows = 100;

function renderXlsxWorksheet(bytes: Uint8Array, sharedStrings: string[], styles: XlsxStyles) {
  const markup = xlsxEntryText(bytes, maxXlsxWorksheetXmlCharacters);

  if (!markup) {
    return "";
  }

  const document = new DOMParser().parseFromString(markup, "application/xml");

  if (document.querySelector("parsererror")) {
    return "";
  }

  const rows = xlsxElementsByLocalName(document.documentElement, "row", xlsxPreviewMaxRows * 4)
    .filter((row) => row.getAttribute("hidden") !== "1")
    .slice(0, xlsxPreviewMaxRows);
  const visibleRowNumbers = xlsxVisibleRowNumbers(rows);
  const mergeInfo = xlsxMergeInfo(document, {
    maxColumnIndex: xlsxPreviewMaxColumns - 1,
    visibleRowNumbers
  });
  const maxColumnIndex = Math.min(Math.max(xlsxMaxColumnIndex(rows, mergeInfo), 0), xlsxPreviewMaxColumns - 1);
  const columnWidths = xlsxColumnWidths(document, maxColumnIndex + 1);
  const colGroup = [
    '<col style="width:44px">',
    ...Array.from({ length: maxColumnIndex + 1 }, (_, index) => `<col style="width:${columnWidths[index] ?? 92}px">`)
  ].join("");
  const headerHtml = Array.from({ length: maxColumnIndex + 1 }, (_, index) => `<th scope="col">${xlsxColumnName(index)}</th>`).join("");
  const rowHtml = rows
    .map((row, index) => renderXlsxRow(row, sharedStrings, styles, mergeInfo, maxColumnIndex, index + 1))
    .filter(Boolean)
    .slice(0, xlsxPreviewMaxRows)
    .join("");

  return rowHtml ? `<table class="xlsx-preview-table"><colgroup>${colGroup}</colgroup><thead><tr><th scope="col"></th>${headerHtml}</tr></thead><tbody>${rowHtml}</tbody></table>` : "";
}

function renderXlsxRow(
  row: Element,
  sharedStrings: string[],
  styles: XlsxStyles,
  mergeInfo: XlsxMergeInfo,
  maxColumnIndex: number,
  fallbackRowNumber: number
) {
  const cells = Array.from(row.children).filter((child) => child.localName.toLowerCase() === "c");
  const cellsByIndex = new Map<number, { html: string; styleAttribute: string }>();
  const rowNumber = safeXlsxRowNumber(row.getAttribute("r"), fallbackRowNumber);
  const rowStyle = xlsxRowStyleAttribute(row);
  let rowMaxColumnIndex = -1;
  let fallbackIndex = 0;

  cells.slice(0, xlsxPreviewMaxColumns).forEach((cell) => {
    const refIndex = xlsxCellColumnIndex(cell.getAttribute("r"));
    const columnIndex = refIndex ?? fallbackIndex;
    fallbackIndex = columnIndex + 1;

    if (columnIndex < 0 || columnIndex >= xlsxPreviewMaxColumns) {
      return;
    }

    const value = xlsxCellText(cell, sharedStrings, styles);
    cellsByIndex.set(columnIndex, {
      html: value ? escapeHtml(value) : "&nbsp;",
      styleAttribute: xlsxCellStyleAttribute(cell, styles)
    });
    rowMaxColumnIndex = Math.max(rowMaxColumnIndex, columnIndex);
  });

  if (rowMaxColumnIndex < 0 && !Array.from(mergeInfo.starts.keys()).some((key) => key.startsWith(`${rowNumber}:`))) {
    return "";
  }

  const cellHtml = Array.from({ length: maxColumnIndex + 1 }, (_, index) => {
    const key = xlsxCellKey(rowNumber, index);

    if (mergeInfo.skips.has(key)) {
      return "";
    }

    const mergeRange = mergeInfo.starts.get(key);
    const spanAttributes = xlsxMergeSpanAttributes(mergeRange);
    const cell = cellsByIndex.get(index);
    return `<td${spanAttributes}${cell?.styleAttribute ?? ""}>${cell?.html ?? "&nbsp;"}</td>`;
  }).join("");

  return `<tr${rowStyle}><th scope="row">${rowNumber}</th>${cellHtml}</tr>`;
}

interface XlsxMergeRange {
  startColumn: number;
  startRow: number;
  endColumn: number;
  endRow: number;
}

interface XlsxMergeInfo {
  skips: Set<string>;
  starts: Map<string, XlsxMergeRange>;
}

interface XlsxMergePreviewBounds {
  maxColumnIndex: number;
  visibleRowNumbers: Set<number>;
}

function xlsxStyles(entries: Record<string, Uint8Array>): XlsxStyles {
  const document = xlsxXmlDocument(entries, "xl/styles.xml");

  if (!document) {
    return {
      cellFormats: [],
      fills: [],
      fonts: [],
      numberFormats: new Map(builtinXlsxNumberFormats)
    };
  }

  const numberFormats = new Map(builtinXlsxNumberFormats);
  xlsxElementsByLocalName(document.documentElement, "numFmt", maxXlsxStyleRecords).forEach((numFmt) => {
    const id = Number(numFmt.getAttribute("numFmtId"));
    const formatCode = numFmt.getAttribute("formatCode");

    if (Number.isInteger(id) && formatCode) {
      numberFormats.set(id, formatCode);
    }
  });

  const fontsElement = xlsxElementsByLocalName(document.documentElement, "fonts", 1)[0] ?? null;
  const fillsElement = xlsxElementsByLocalName(document.documentElement, "fills", 1)[0] ?? null;
  const cellXfsElement = xlsxElementsByLocalName(document.documentElement, "cellXfs", 1)[0] ?? null;
  const fonts = directChildrenByLocalName(fontsElement, "font").slice(0, maxXlsxStyleRecords).map(xlsxFontStyle);
  const fills = directChildrenByLocalName(fillsElement, "fill").slice(0, maxXlsxStyleRecords).map(xlsxFillColor);
  const cellFormats = directChildrenByLocalName(cellXfsElement, "xf").slice(0, maxXlsxStyleRecords).map((format) => {
    const alignment = directChildrenByLocalName(format, "alignment")[0] ?? null;

    return {
      fillId: safeXlsxStyleIndex(format.getAttribute("fillId")),
      fontId: safeXlsxStyleIndex(format.getAttribute("fontId")),
      horizontal: safeXlsxAlignment(alignment?.getAttribute("horizontal") ?? null),
      numFmtId: safeXlsxStyleIndex(format.getAttribute("numFmtId")),
      vertical: safeXlsxVerticalAlignment(alignment?.getAttribute("vertical") ?? null),
      wrapText: alignment?.getAttribute("wrapText") === "1" || alignment?.getAttribute("wrapText") === "true"
    };
  });

  return { cellFormats, fills, fonts, numberFormats };
}

function xlsxFontStyle(font: Element): XlsxFontStyle {
  return {
    bold: Boolean(directChildrenByLocalName(font, "b").length),
    color: xlsxColorValue(directChildrenByLocalName(font, "color")[0] ?? null),
    italic: Boolean(directChildrenByLocalName(font, "i").length),
    strike: Boolean(directChildrenByLocalName(font, "strike").length),
    underline: Boolean(directChildrenByLocalName(font, "u").length)
  };
}

function xlsxFillColor(fill: Element) {
  const patternFill = directChildrenByLocalName(fill, "patternFill")[0] ?? null;
  const patternType = patternFill?.getAttribute("patternType") ?? "";

  if (!patternFill || patternType === "none") {
    return null;
  }

  return xlsxColorValue(directChildrenByLocalName(patternFill, "fgColor")[0] ?? directChildrenByLocalName(patternFill, "bgColor")[0] ?? null);
}

function xlsxColorValue(color: Element | null) {
  const rgb = color?.getAttribute("rgb");

  if (!rgb) {
    return null;
  }

  const normalized = `#${rgb.slice(-6)}`.toLowerCase();
  return /^#[0-9a-f]{6}$/.test(normalized) ? normalized : null;
}

function safeXlsxStyleIndex(value: string | null) {
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 && index <= 4096 ? index : 0;
}

function safeXlsxAlignment(value: string | null) {
  const normalized = String(value ?? "").toLowerCase();
  return ["left", "center", "right"].includes(normalized) ? normalized : null;
}

function safeXlsxVerticalAlignment(value: string | null) {
  const normalized = String(value ?? "").toLowerCase();
  return ["top", "middle", "bottom"].includes(normalized) ? normalized : null;
}

function xlsxCellStyleAttribute(cell: Element, styles: XlsxStyles) {
  const format = styles.cellFormats[safeXlsxStyleIndex(cell.getAttribute("s"))];

  if (!format) {
    return "";
  }

  const font = styles.fonts[format.fontId];
  const fill = styles.fills[format.fillId];
  const declarations: string[] = [];

  if (fill) {
    declarations.push(`background-color:${fill}`);
  }

  if (font?.color) {
    declarations.push(`color:${font.color}`);
  }

  if (font?.bold) {
    declarations.push("font-weight:800");
  }

  if (font?.italic) {
    declarations.push("font-style:italic");
  }

  if (font?.underline && font.strike) {
    declarations.push("text-decoration:underline line-through");
  } else if (font?.underline) {
    declarations.push("text-decoration:underline");
  } else if (font?.strike) {
    declarations.push("text-decoration:line-through");
  }

  if (format.horizontal) {
    declarations.push(`text-align:${format.horizontal}`);
  }

  if (format.vertical) {
    declarations.push(`vertical-align:${format.vertical}`);
  }

  if (format.wrapText) {
    declarations.push("white-space:pre-wrap");
  }

  return declarations.length ? ` style="${declarations.join(";")}"` : "";
}

function xlsxRowStyleAttribute(row: Element) {
  const height = Number(row.getAttribute("ht"));

  if (!Number.isFinite(height) || height <= 0) {
    return "";
  }

  const pxHeight = Math.min(180, Math.max(20, Math.round(height * 1.34)));
  return ` style="height:${pxHeight}px"`;
}

function xlsxVisibleRowNumbers(rows: Element[]) {
  return new Set(rows.map((row, index) => safeXlsxRowNumber(row.getAttribute("r"), index + 1)));
}

function xlsxMergeInfo(document: Document, bounds: XlsxMergePreviewBounds): XlsxMergeInfo {
  const starts = new Map<string, XlsxMergeRange>();
  const skips = new Set<string>();
  const visibleRows = Array.from(bounds.visibleRowNumbers).sort((left, right) => left - right);

  if (!visibleRows.length || bounds.maxColumnIndex < 0) {
    return { skips, starts };
  }

  xlsxElementsByLocalName(document.documentElement, "mergeCell", xlsxPreviewMaxMergeRanges).forEach((mergeCell) => {
    const range = xlsxCellRange(mergeCell.getAttribute("ref"));

    if (!range) {
      return;
    }

    const clampedStartColumn = Math.max(0, range.startColumn);
    const clampedEndColumn = Math.min(bounds.maxColumnIndex, range.endColumn);

    if (clampedStartColumn > clampedEndColumn) {
      return;
    }

    const visibleRowsInRange = visibleRows.filter((row) => row >= range.startRow && row <= range.endRow);

    if (!visibleRowsInRange.length) {
      return;
    }

    const startRowVisible = bounds.visibleRowNumbers.has(range.startRow);
    const startColumnVisible = range.startColumn >= 0 && range.startColumn <= bounds.maxColumnIndex;

    if (startRowVisible && startColumnVisible) {
      starts.set(xlsxCellKey(range.startRow, range.startColumn), {
        startColumn: range.startColumn,
        startRow: range.startRow,
        endColumn: clampedEndColumn,
        endRow: visibleRowsInRange.at(-1) ?? range.startRow
      });
    }

    visibleRowsInRange.forEach((row) => {
      for (let column = clampedStartColumn; column <= clampedEndColumn; column += 1) {
        if (row !== range.startRow || column !== range.startColumn) {
          skips.add(xlsxCellKey(row, column));
        }
      }
    });
  });

  return { skips, starts };
}

function xlsxMaxColumnIndex(rows: Element[], mergeInfo: XlsxMergeInfo) {
  const cellMaxColumn = rows.reduce((maxColumn, row) => {
    const rowCells = Array.from(row.children)
      .filter((child) => child.localName.toLowerCase() === "c")
      .slice(0, xlsxPreviewMaxColumns);
    const rowMaxColumn = rowCells.reduce((currentMax, cell, fallbackIndex) => {
      const columnIndex = xlsxCellColumnIndex(cell.getAttribute("r")) ?? fallbackIndex;
      return Math.max(currentMax, columnIndex);
    }, -1);

    return Math.max(maxColumn, rowMaxColumn);
  }, -1);
  const mergeMaxColumn = Array.from(mergeInfo.starts.values()).reduce((maxColumn, range) => Math.max(maxColumn, range.endColumn), -1);

  return Math.max(cellMaxColumn, mergeMaxColumn, 0);
}

function xlsxColumnWidths(document: Document, columnCount: number) {
  const widths: Array<number | undefined> = Array.from({ length: columnCount });

  xlsxElementsByLocalName(document.documentElement, "col", xlsxPreviewMaxColumns).forEach((column) => {
    const min = Math.max(1, Number(column.getAttribute("min")) || 1);
    const max = Math.min(columnCount, Number(column.getAttribute("max")) || min);
    const width = clampXlsxColumnWidth(Number(column.getAttribute("width")));

    if (!width) {
      return;
    }

    for (let index = min - 1; index < max; index += 1) {
      widths[index] = width;
    }
  });

  return widths;
}

function clampXlsxColumnWidth(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.min(220, Math.max(56, Math.round(value * 7 + 12)));
}

function xlsxMergeSpanAttributes(range: XlsxMergeRange | undefined) {
  if (!range) {
    return "";
  }

  const colSpan = Math.min(xlsxPreviewMaxColumns, Math.max(1, range.endColumn - range.startColumn + 1));
  const rowSpan = Math.min(xlsxPreviewMaxRows, Math.max(1, range.endRow - range.startRow + 1));
  const attributes: string[] = [];

  if (colSpan > 1) {
    attributes.push(` colspan="${colSpan}"`);
  }

  if (rowSpan > 1) {
    attributes.push(` rowspan="${rowSpan}"`);
  }

  return attributes.join("");
}

function xlsxCellRange(reference: string | null): XlsxMergeRange | null {
  const [startReference, endReference = startReference] = String(reference ?? "").split(":");
  const start = xlsxCellReference(startReference);
  const end = xlsxCellReference(endReference);

  if (!start || !end) {
    return null;
  }

  return {
    startColumn: Math.min(start.column, end.column),
    startRow: Math.min(start.row, end.row),
    endColumn: Math.max(start.column, end.column),
    endRow: Math.max(start.row, end.row)
  };
}

function xlsxCellReference(reference: string) {
  const match = reference.match(/^([A-Z]+)(\d+)$/i);

  if (!match || match[1].length > 3) {
    return null;
  }
  const column = xlsxColumnIndexFromLetters(match[1]);
  const row = Number(match[2]);

  if (
    !Number.isInteger(row) ||
    row < 1 ||
    row > xlsxExcelMaxRows ||
    column < 0 ||
    column >= xlsxExcelMaxColumns
  ) {
    return null;
  }

  return {
    column,
    row
  };
}

function safeXlsxRowNumber(value: string | null, fallback: number) {
  const rowNumber = Number(value);
  return Number.isInteger(rowNumber) && rowNumber > 0 ? rowNumber : fallback;
}

function xlsxCellKey(row: number, column: number) {
  return `${row}:${column}`;
}

function xlsxCellColumnIndex(reference: string | null) {
  const columnLetters = reference?.match(/^[A-Z]+/i)?.[0];

  if (!columnLetters || columnLetters.length > 3) {
    return null;
  }

  return xlsxColumnIndexFromLetters(columnLetters);
}

function xlsxColumnIndexFromLetters(columnLetters: string) {
  return Array.from(columnLetters.toUpperCase()).reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

function xlsxColumnName(index: number) {
  let value = index + 1;
  let name = "";

  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }

  return name;
}

function xlsxCellText(cell: Element, sharedStrings: string[], styles: XlsxStyles) {
  const type = cell.getAttribute("t");
  const rawValue = descendantsByLocalName(cell, "v")[0]?.textContent ?? "";

  if (type === "s") {
    return normalizePreviewText(sharedStrings[Number(rawValue)] ?? "");
  }

  if (type === "inlineStr") {
    return normalizePreviewText(descendantsByLocalName(cell, "t").map((textNode) => textNode.textContent ?? "").join(""));
  }

  if (type === "b") {
    return rawValue === "1" ? "TRUE" : rawValue === "0" ? "FALSE" : normalizePreviewText(rawValue);
  }

  if (type === "e") {
    return normalizePreviewText(rawValue || "ERROR");
  }

  if (type === "str") {
    return normalizePreviewText(rawValue || descendantsByLocalName(cell, "f")[0]?.textContent || "");
  }

  return formatXlsxCellValue(rawValue, styles.cellFormats[safeXlsxStyleIndex(cell.getAttribute("s"))], styles);
}

function formatXlsxCellValue(rawValue: string, format: XlsxCellFormat | undefined, styles: XlsxStyles) {
  const normalizedValue = normalizePreviewText(rawValue);
  const numericValue = Number(rawValue);

  if (!normalizedValue || !Number.isFinite(numericValue) || !format) {
    return normalizedValue;
  }

  const formatCode = styles.numberFormats.get(format.numFmtId) ?? "";

  if (xlsxFormatLooksLikeDate(formatCode)) {
    return formatXlsxDate(numericValue, formatCode);
  }

  if (formatCode.includes("%")) {
    const digits = xlsxDecimalPlaces(formatCode);
    return `${(numericValue * 100).toLocaleString("ko-KR", {
      maximumFractionDigits: digits,
      minimumFractionDigits: digits
    })}%`;
  }

  if (/[#,]##0|#,##0/.test(formatCode)) {
    const digits = xlsxDecimalPlaces(formatCode);
    return numericValue.toLocaleString("ko-KR", {
      maximumFractionDigits: digits,
      minimumFractionDigits: digits
    });
  }

  if (formatCode.includes(".00")) {
    return numericValue.toLocaleString("ko-KR", {
      maximumFractionDigits: 2,
      minimumFractionDigits: 2
    });
  }

  return normalizedValue;
}

function xlsxFormatLooksLikeDate(formatCode: string) {
  const stripped = formatCode
    .replace(/\[[^\]]+]/g, "")
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "")
    .toLowerCase();

  return /(^|[^a-z])[ymdhHs]+([^a-z]|$)/.test(stripped) && !stripped.includes("%");
}

function xlsxDecimalPlaces(formatCode: string) {
  const decimalMatch = formatCode.match(/\.([0#]+)/);
  return decimalMatch ? Math.min(decimalMatch[1].length, 4) : 0;
}

function formatXlsxDate(serialValue: number, formatCode: string) {
  const wholeDays = Math.floor(serialValue);
  const milliseconds = Math.round((serialValue - wholeDays) * 86_400_000);
  const date = new Date(Date.UTC(1899, 11, 30 + wholeDays) + milliseconds);

  if (Number.isNaN(date.getTime())) {
    return String(serialValue);
  }

  const hasTime = /[hs]/i.test(formatCode);
  const hasDate = /[ymd]/i.test(formatCode);
  const datePart = hasDate ? date.toISOString().slice(0, 10) : "";
  const timePart = hasTime ? date.toISOString().slice(11, 16) : "";

  return [datePart, timePart].filter(Boolean).join(" ") || datePart || timePart;
}

function cfbEntryBytes(entry: { content?: unknown } | null) {
  const content = entry?.content;

  if (content instanceof Uint8Array) {
    return content;
  }

  if (Array.isArray(content)) {
    return new Uint8Array(content);
  }

  return new Uint8Array();
}

function hwpHeaderInfo(header: Uint8Array) {
  if (header.length < 40) {
    return null;
  }

  const signature = new TextDecoder("ascii").decode(header.slice(0, 32)).replaceAll("\0", "").trim();

  if (!signature.includes("HWP Document File")) {
    return null;
  }

  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const flags = view.getUint32(36, true);

  return {
    compressed: (flags & 0x01) !== 0,
    encrypted: (flags & 0x02) !== 0,
    distributed: (flags & 0x04) !== 0
  };
}

function hwpSectionEntries(container: { FileIndex: Array<{ content?: unknown }>; FullPaths: string[] }) {
  return container.FullPaths.map((path, index) => ({ entry: container.FileIndex[index], path }))
    .map((item) => ({ ...item, sectionIndex: Number(item.path.match(/\/BodyText\/Section(\d+)$/i)?.[1] ?? Number.NaN) }))
    .filter((item) => Number.isInteger(item.sectionIndex))
    .sort((left, right) => left.sectionIndex - right.sectionIndex);
}

function boundedHwpSectionBytes(bytes: Uint8Array, budget: HwpPreviewByteBudget) {
  const sectionLimit = Math.min(maxHwpPreviewSectionBytes, budget.remainingBytes);

  if (sectionLimit <= 0 || bytes.length > sectionLimit) {
    return null;
  }

  budget.remainingBytes -= bytes.length;
  return bytes;
}

function decompressHwpSectionBytes(bytes: Uint8Array, budget: HwpPreviewByteBudget) {
  try {
    const sectionLimit = Math.min(maxHwpPreviewSectionBytes, budget.remainingBytes);

    if (sectionLimit <= 0) {
      return null;
    }

    const chunks: Uint8Array[] = [];
    let decodedLength = 0;
    const stream = new Decompress((chunk) => {
      decodedLength += chunk.length;

      if (decodedLength > sectionLimit) {
        throw new Error("HWP preview decompressed size limit exceeded");
      }

      chunks.push(chunk.slice());
    });

    for (let offset = 0; offset < bytes.length; offset += hwpPreviewCompressedChunkBytes) {
      const nextOffset = Math.min(bytes.length, offset + hwpPreviewCompressedChunkBytes);
      stream.push(bytes.subarray(offset, nextOffset), nextOffset >= bytes.length);
    }

    budget.remainingBytes -= decodedLength;
    return concatPreviewBytes(chunks, decodedLength);
  } catch {
    return null;
  }
}

function concatPreviewBytes(chunks: Uint8Array[], totalLength: number) {
  const output = new Uint8Array(totalLength);
  let offset = 0;

  chunks.forEach((chunk) => {
    output.set(chunk, offset);
    offset += chunk.length;
  });

  return output;
}

function appendHwpSectionBlocks(bytes: Uint8Array, blocks: string[]) {
  if (!bytes.length) {
    return;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;

  while (offset + 4 <= bytes.length && blocks.length < maxDocumentPreviewBlocks) {
    const header = view.getUint32(offset, true);
    offset += 4;

    const tagId = header & 0x3ff;
    let size = (header >>> 20) & 0xfff;

    if (size === 0xfff) {
      if (offset + 4 > bytes.length) {
        break;
      }

      size = view.getUint32(offset, true);
      offset += 4;
    }

    if (size < 0 || offset + size > bytes.length) {
      break;
    }

    if (tagId === 67) {
      appendTextPreviewBlocks(decodeHwpParagraphText(bytes.subarray(offset, offset + size)), blocks);
    }

    offset += size;
  }
}

function decodeHwpParagraphText(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let text = "";

  for (let offset = 0; offset + 1 < bytes.length; offset += 2) {
    const code = view.getUint16(offset, true);

    if (code === 9) {
      text += " ";
      continue;
    }

    if (code === 10 || code === 13) {
      text += "\n";
      continue;
    }

    if (code < 32) {
      offset += 16;
      continue;
    }

    if (code >= 0xd800 && code <= 0xdbff && offset + 3 < bytes.length) {
      const low = view.getUint16(offset + 2, true);

      if (low >= 0xdc00 && low <= 0xdfff) {
        text += String.fromCodePoint(0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00));
        offset += 2;
        continue;
      }
    }

    if (isPreviewCharacter(code)) {
      text += String.fromCharCode(code);
    }
  }

  return normalizePreviewText(text);
}

function isPreviewCharacter(code: number) {
  return code >= 32 && code !== 0xfffc && code !== 0xfffd && code !== 0xffff;
}

function hwpxPreviewEntryPriority(name: string) {
  const normalizedName = name.toLowerCase();

  if (!normalizedName.endsWith(".xml")) {
    return 0;
  }

  if (/^contents\/section\d+\.xml$/i.test(normalizedName)) {
    return 40;
  }

  if (normalizedName.includes("section") || normalizedName.includes("content")) {
    return 20;
  }

  return normalizedName.startsWith("contents/") ? 8 : 0;
}

function collectHwpxPreviewBlocks(markup: string, blocks: string[]) {
  const document = new DOMParser().parseFromString(markup, "application/xml");

  if (document.querySelector("parsererror")) {
    return;
  }

  collectHwpxElementBlocks(document.documentElement, blocks);
}

function collectHwpxElementBlocks(element: Element, blocks: string[]) {
  if (blocks.length >= maxDocumentPreviewBlocks) {
    return;
  }

  const name = element.localName.toLowerCase();

  if (name === "tbl") {
    const table = renderHwpxTable(element);

    if (table) {
      blocks.push(table);
    }

    return;
  }

  if (name === "p") {
    const tables = descendantsByLocalName(element, "tbl").filter((table) => nearestAncestorByLocalName(table, "p") === element);

    if (tables.length) {
      tables.forEach((table) => {
        if (blocks.length >= maxDocumentPreviewBlocks) {
          return;
        }

        const tableHtml = renderHwpxTable(table);

        if (tableHtml) {
          blocks.push(tableHtml);
        }
      });
      return;
    }

    const text = normalizePreviewText(element.textContent ?? "");

    if (text) {
      blocks.push(`<p>${escapeHtml(text)}</p>`);
    }

    return;
  }

  Array.from(element.children).forEach((child) => collectHwpxElementBlocks(child, blocks));
}

function renderHwpxTable(table: Element) {
  const rows = descendantsByLocalName(table, "tr").filter((row) => nearestAncestorByLocalName(row, "tbl") === table);
  const rowHtml = rows
    .slice(0, 80)
    .map((row) => {
      const cells = descendantsByLocalName(row, "tc").filter((cell) => nearestAncestorByLocalName(cell, "tr") === row);
      const cellHtml = cells
        .slice(0, 20)
        .map((cell) => `<td${hwpxCellSpanAttributes(cell)}>${hwpxCellHtml(cell) || "&nbsp;"}</td>`)
        .join("");

      return cellHtml ? `<tr>${cellHtml}</tr>` : "";
    })
    .filter(Boolean)
    .join("");

  return rowHtml ? `<table>${rowHtml}</table>` : "";
}

function descendantsByLocalName(element: Element, name: string) {
  return Array.from(element.getElementsByTagName("*")).filter((child) => child.localName.toLowerCase() === name);
}

function directChildrenByLocalName(element: Element | null, name: string) {
  if (!element) {
    return [];
  }

  return Array.from(element.children).filter((child) => child.localName.toLowerCase() === name);
}

function nearestAncestorByLocalName(element: Element, name: string) {
  let parent = element.parentElement;

  while (parent) {
    if (parent.localName.toLowerCase() === name) {
      return parent;
    }

    parent = parent.parentElement;
  }

  return null;
}

function hwpxCellSpanAttributes(cell: Element) {
  const cellProperties = descendantsByLocalName(cell, "tcPr").find((candidate) => nearestAncestorByLocalName(candidate, "tc") === cell);
  const colSpan = safePreviewSpan(
    cell.getAttribute("colSpan") ?? cell.getAttribute("colspan") ?? cellProperties?.getAttribute("colSpan") ?? cellProperties?.getAttribute("colspan") ?? null
  );
  const rowSpan = safePreviewSpan(
    cell.getAttribute("rowSpan") ?? cell.getAttribute("rowspan") ?? cellProperties?.getAttribute("rowSpan") ?? cellProperties?.getAttribute("rowspan") ?? null
  );
  const attributes: string[] = [];

  if (colSpan > 1) {
    attributes.push(` colspan="${colSpan}"`);
  }

  if (rowSpan > 1) {
    attributes.push(` rowspan="${rowSpan}"`);
  }

  return attributes.join("");
}

function safePreviewSpan(value: string | null) {
  const span = Number(value);

  return Number.isInteger(span) && span >= 1 && span <= 12 ? span : 1;
}

function hwpxCellHtml(cell: Element) {
  const paragraphs = descendantsByLocalName(cell, "p")
    .map((paragraph) => normalizePreviewText(paragraph.textContent ?? ""))
    .filter(Boolean);

  if (paragraphs.length) {
    return paragraphs.slice(0, 12).map(escapeHtml).join("<br>");
  }

  return escapeHtml(normalizePreviewText(cell.textContent ?? ""));
}

function appendTextPreviewBlocks(text: string, blocks: string[]) {
  text
    .split(/\n+/)
    .map((line) => normalizePreviewText(line))
    .filter(Boolean)
    .forEach((line) => {
      if (blocks.length < maxDocumentPreviewBlocks) {
        blocks.push(`<p>${escapeHtml(line)}</p>`);
      }
    });
}

function documentPreviewHtml(blocks: string[]) {
  const visibleBlocks = blocks.filter(Boolean).slice(0, maxDocumentPreviewBlocks);

  if (!visibleBlocks.length) {
    return "";
  }

  const truncated = blocks.length > visibleBlocks.length ? '<p class="document-preview-muted">일부 내용은 미리보기 길이 제한으로 생략되었습니다.</p>' : "";
  return `<div>${visibleBlocks.join("")}${truncated}</div>`;
}

function normalizePreviewText(value: string) {
  return value
    .replaceAll("\0", "")
    .replace(/[^\S\r\n]+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxTextPreviewCharacters);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "\"":
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return character;
    }
  });
}
