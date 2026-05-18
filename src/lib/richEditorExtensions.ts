import { Extension, Mark, mergeAttributes } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { Table } from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import TextAlign from "@tiptap/extension-text-align";
import Underline from "@tiptap/extension-underline";
import StarterKit from "@tiptap/starter-kit";

export const editorCellColors = ["#fff7ed", "#fef3c7", "#dcfce7", "#dbeafe", "#fce7f3", "#f1f5f9"] as const;
export const editorImageWidths = [25, 50, 75, 100] as const;
export const editorImagePixelWidthBounds = { min: 120, max: 1200, step: 10 } as const;
export const editorTablePixelWidths = [480, 720, 960, 1200] as const;
export const editorTablePixelWidthBounds = { min: 280, max: 1800, step: 10 } as const;
export const editorTablePixelHeightBounds = { min: 96, max: 2000, step: 8 } as const;
export const editorTableRowPixelHeightBounds = { min: 28, max: 900, step: 4 } as const;
export const editorTableColumnPixelWidthBounds = { min: 48, max: 900, step: 4 } as const;
export const editorTextSizeBounds = { min: 10, max: 72, step: 1 } as const;
export const editorTextSizes = [10, 12, 14, 16, 17, 18, 20, 22, 24, 28, 32, 36, 44, 52, 64, 72] as const;
export const editorTextColors = ["#14211f", "#64748b", "#dc2626", "#b9822f", "#15803d", "#2563eb", "#7c3aed"] as const;
export const editorLineHeightBounds = { min: 1, max: 3, step: 0.05 } as const;
export const editorLineHeights = [1, 1.15, 1.2, 1.35, 1.5, 1.7, 2, 2.5, 3] as const;

const editorCellColorSet = new Set<string>(editorCellColors);
const editorImageWidthSet = new Set<number>(editorImageWidths);
const safeHexColorPattern = /^#[0-9a-f]{6}$/;
const safeBlockIdPattern = /^[A-Za-z0-9_-]{12,64}$/;
const safeUidListPattern = /^[A-Za-z0-9_,:.-]{1,600}$/;
const safeUidPattern = /^[A-Za-z0-9_:.-]{1,128}$/;
const attributionLabelMaxLength = 160;

function normalizedEditorColor(value: unknown) {
  const rawValue = String(value ?? "").trim().toLowerCase();

  if (editorCellColorSet.has(rawValue) || safeHexColorPattern.test(rawValue)) {
    return rawValue;
  }

  return null;
}

function normalizedImageWidth(value: unknown) {
  const width = Number(String(value ?? "").replace("%", "").trim());

  return editorImageWidthSet.has(width) ? width : null;
}

function normalizedImagePixelWidth(value: unknown) {
  const width = Number(String(value ?? "").replace("px", "").trim());

  return Number.isInteger(width) && width >= editorImagePixelWidthBounds.min && width <= editorImagePixelWidthBounds.max ? width : null;
}

function normalizedTableWidth(value: unknown) {
  const width = Number(String(value ?? "").replace("%", "").trim());

  return Number.isInteger(width) && width >= 30 && width <= 100 ? width : null;
}

function normalizedTablePixelWidth(value: unknown) {
  const width = Number(String(value ?? "").replace("px", "").trim());

  return Number.isInteger(width) && width >= editorTablePixelWidthBounds.min && width <= editorTablePixelWidthBounds.max ? width : null;
}

function normalizedTablePixelHeight(value: unknown) {
  const height = Number(String(value ?? "").replace("px", "").trim());

  return Number.isInteger(height) && height >= editorTablePixelHeightBounds.min && height <= editorTablePixelHeightBounds.max ? height : null;
}

function normalizedTableRowPixelHeight(value: unknown) {
  const height = Number(String(value ?? "").replace("px", "").trim());

  return Number.isInteger(height) && height >= editorTableRowPixelHeightBounds.min && height <= editorTableRowPixelHeightBounds.max
    ? height
    : null;
}

function normalizedTableColumnPixelWidth(value: unknown) {
  const width = Number(String(value ?? "").replace("px", "").trim());

  return Number.isInteger(width) && width >= editorTableColumnPixelWidthBounds.min && width <= editorTableColumnPixelWidthBounds.max
    ? width
    : null;
}

function normalizedTextSize(value: unknown) {
  const size = Number(String(value ?? "").replace("px", "").trim());

  return Number.isInteger(size) && size >= editorTextSizeBounds.min && size <= editorTextSizeBounds.max ? size : null;
}

function normalizedLineHeight(value: unknown) {
  const lineHeight = Math.round(Number(String(value ?? "").trim()) * 100) / 100;

  return Number.isFinite(lineHeight) && lineHeight >= editorLineHeightBounds.min && lineHeight <= editorLineHeightBounds.max ? lineHeight : null;
}

function normalizedUidList(value: unknown) {
  const rawValue = String(value ?? "").trim();

  return safeUidListPattern.test(rawValue) ? rawValue : null;
}

function normalizedUid(value: unknown) {
  const rawValue = String(value ?? "").trim();

  return safeUidPattern.test(rawValue) ? rawValue : null;
}

function normalizedBlockId(value: unknown) {
  const rawValue = String(value ?? "").trim();

  return safeBlockIdPattern.test(rawValue) ? rawValue : null;
}

function normalizedAttributionLabel(value: unknown) {
  const rawValue = String(value ?? "").replace(/\s+/g, " ").trim();

  if (!rawValue || rawValue.length > attributionLabelMaxLength || hasUnsafeAttributionLabelCharacter(rawValue)) {
    return null;
  }

  return rawValue;
}

function hasUnsafeAttributionLabelCharacter(value: string) {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127 || `<>"'\``.includes(character);
  });
}

const TextSize = Mark.create({
  name: "textSize",

  addAttributes() {
    return {
      size: {
        default: null,
        parseHTML: (element: HTMLElement) => normalizedTextSize(element.getAttribute("data-qm-font-size") || element.style.fontSize),
        renderHTML: (attributes: { size?: number | string | null }) => {
          const size = normalizedTextSize(attributes.size);
          return size ? { "data-qm-font-size": String(size), style: `font-size: ${size}px` } : {};
        }
      }
    };
  },

  parseHTML() {
    return [
      {
        tag: "span[data-qm-font-size]"
      },
      {
        style: "font-size"
      }
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", HTMLAttributes, 0];
  }
});

const TextColor = Mark.create({
  name: "textColor",

  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (element: HTMLElement) => normalizedEditorColor(element.getAttribute("data-qm-text-color") || element.style.color),
        renderHTML: (attributes: { color?: string | null }) => {
          const color = normalizedEditorColor(attributes.color);
          return color ? { "data-qm-text-color": color, style: `color: ${color}` } : {};
        }
      }
    };
  },

  parseHTML() {
    return [
      {
        tag: "span[data-qm-text-color]"
      },
      {
        style: "color"
      }
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", HTMLAttributes, 0];
  }
});

const LineHeight = Mark.create({
  name: "lineHeight",

  addAttributes() {
    return {
      lineHeight: {
        default: null,
        parseHTML: (element: HTMLElement) => normalizedLineHeight(element.getAttribute("data-qm-line-height") || element.style.lineHeight),
        renderHTML: (attributes: { lineHeight?: number | string | null }) => {
          const lineHeight = normalizedLineHeight(attributes.lineHeight);
          return lineHeight ? { "data-qm-line-height": String(lineHeight), style: `line-height: ${lineHeight}` } : {};
        }
      }
    };
  },

  parseHTML() {
    return [
      {
        tag: "span[data-qm-line-height]"
      },
      {
        style: "line-height"
      }
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", HTMLAttributes, 0];
  }
});

const BlockLineHeight = Extension.create({
  name: "blockLineHeight",

  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading", "listItem", "tableCell", "tableHeader"],
        attributes: {
          qmLineHeight: {
            default: null,
            parseHTML: (element: HTMLElement) => normalizedLineHeight(element.getAttribute("data-qm-line-height") || element.style.lineHeight),
            renderHTML: (attributes: { qmLineHeight?: number | string | null }) => {
              const lineHeight = normalizedLineHeight(attributes.qmLineHeight);
              return lineHeight ? { "data-qm-line-height": String(lineHeight), style: `line-height: ${lineHeight}` } : {};
            }
          }
        }
      }
    ];
  }
});

const BlockAttribution = Extension.create({
  name: "blockAttribution",

  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading", "listItem", "tableCell", "tableHeader"],
        attributes: {
          qmBlockId: {
            default: null,
            parseHTML: (element: HTMLElement) => normalizedBlockId(element.getAttribute("data-qm-block-id")),
            renderHTML: (attributes: { qmBlockId?: string | null }) => {
              const value = normalizedBlockId(attributes.qmBlockId);
              return value ? { "data-qm-block-id": value } : {};
            }
          },
          qmAuthorUids: {
            default: null,
            parseHTML: (element: HTMLElement) => normalizedUidList(element.getAttribute("data-qm-author-uids")),
            renderHTML: (attributes: { qmAuthorUids?: string | null }) => {
              const value = normalizedUidList(attributes.qmAuthorUids);
              return value ? { "data-qm-author-uids": value } : {};
            }
          },
          qmEditorUids: {
            default: null,
            parseHTML: (element: HTMLElement) => normalizedUidList(element.getAttribute("data-qm-editor-uids")),
            renderHTML: (attributes: { qmEditorUids?: string | null }) => {
              const value = normalizedUidList(attributes.qmEditorUids);
              return value ? { "data-qm-editor-uids": value } : {};
            }
          },
          qmLastEditorUid: {
            default: null,
            parseHTML: (element: HTMLElement) => normalizedUid(element.getAttribute("data-qm-last-editor-uid")),
            renderHTML: (attributes: { qmLastEditorUid?: string | null }) => {
              const value = normalizedUid(attributes.qmLastEditorUid);
              return value ? { "data-qm-last-editor-uid": value } : {};
            }
          },
          qmAttributionLabel: {
            default: null,
            parseHTML: (element: HTMLElement) => normalizedAttributionLabel(element.getAttribute("data-qm-attribution-label")),
            renderHTML: (attributes: { qmAttributionLabel?: string | null }) => {
              const value = normalizedAttributionLabel(attributes.qmAttributionLabel);
              return value ? { "data-qm-attribution-label": value } : {};
            }
          }
        }
      }
    ];
  }
});

const ResizableTable = Table.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      qmWidth: {
        default: null,
        parseHTML: (element: HTMLElement) => normalizedTableWidth(element.getAttribute("data-qm-table-width") || element.style.width),
        renderHTML: (attributes: { qmWidth?: number | string | null; qmWidthPx?: number | string | null }) => {
          if (normalizedTablePixelWidth(attributes.qmWidthPx)) {
            return {};
          }

          const width = normalizedTableWidth(attributes.qmWidth);
          return width ? { "data-qm-table-width": String(width), style: `width: ${width}%; max-width: 100%` } : {};
        }
      },
      qmWidthPx: {
        default: null,
        parseHTML: (element: HTMLElement) => normalizedTablePixelWidth(element.getAttribute("data-qm-table-width-px") || element.style.width),
        renderHTML: (attributes: { qmWidthPx?: number | string | null }) => {
          const width = normalizedTablePixelWidth(attributes.qmWidthPx);
          return width ? { "data-qm-table-width-px": String(width), style: `width: ${width}px` } : {};
        }
      },
      qmHeightPx: {
        default: null,
        parseHTML: (element: HTMLElement) => normalizedTablePixelHeight(element.getAttribute("data-qm-table-height-px") || element.style.height),
        renderHTML: (attributes: { qmHeightPx?: number | string | null }) => {
          const height = normalizedTablePixelHeight(attributes.qmHeightPx);
          return height ? { "data-qm-table-height-px": String(height), style: `height: ${height}px` } : {};
        }
      }
    };
  }
});

const ResizableTableRow = TableRow.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      qmHeightPx: {
        default: null,
        parseHTML: (element: HTMLElement) => normalizedTableRowPixelHeight(element.getAttribute("data-qm-row-height-px") || element.style.height),
        renderHTML: (attributes: { qmHeightPx?: number | string | null }) => {
          const height = normalizedTableRowPixelHeight(attributes.qmHeightPx);
          return height ? { "data-qm-row-height-px": String(height), style: `height: ${height}px` } : {};
        }
      }
    };
  }
});

const ColoredTableCell = TableCell.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      qmWidthPx: {
        default: null,
        parseHTML: (element: HTMLElement) => normalizedTableColumnPixelWidth(element.getAttribute("data-qm-cell-width-px") || element.style.width),
        renderHTML: (attributes: { qmWidthPx?: number | string | null }) => {
          const width = normalizedTableColumnPixelWidth(attributes.qmWidthPx);
          return width ? { "data-qm-cell-width-px": String(width), style: `width: ${width}px` } : {};
        }
      },
      backgroundColor: {
        default: null,
        parseHTML: (element: HTMLElement) => normalizedEditorColor(element.getAttribute("data-qm-bg") || element.style.backgroundColor),
        renderHTML: (attributes: { backgroundColor?: string | null }) => {
          const color = normalizedEditorColor(attributes.backgroundColor);
          return color ? { "data-qm-bg": color, style: `background-color: ${color}` } : {};
        }
      }
    };
  },

  renderHTML({ HTMLAttributes }) {
    return ["td", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  }
});

const ColoredTableHeader = TableHeader.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      qmWidthPx: {
        default: null,
        parseHTML: (element: HTMLElement) => normalizedTableColumnPixelWidth(element.getAttribute("data-qm-cell-width-px") || element.style.width),
        renderHTML: (attributes: { qmWidthPx?: number | string | null }) => {
          const width = normalizedTableColumnPixelWidth(attributes.qmWidthPx);
          return width ? { "data-qm-cell-width-px": String(width), style: `width: ${width}px` } : {};
        }
      },
      backgroundColor: {
        default: null,
        parseHTML: (element: HTMLElement) => normalizedEditorColor(element.getAttribute("data-qm-bg") || element.style.backgroundColor),
        renderHTML: (attributes: { backgroundColor?: string | null }) => {
          const color = normalizedEditorColor(attributes.backgroundColor);
          return color ? { "data-qm-bg": color, style: `background-color: ${color}` } : {};
        }
      }
    };
  },

  renderHTML({ HTMLAttributes }) {
    return ["th", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  }
});

const ResizableImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      qmWidth: {
        default: null,
        parseHTML: (element: HTMLElement) => normalizedImageWidth(element.getAttribute("data-qm-width") || element.style.width),
        renderHTML: (attributes: { qmWidth?: number | string | null; qmWidthPx?: number | string | null }) => {
          if (normalizedImagePixelWidth(attributes.qmWidthPx)) {
            return {};
          }

          const width = normalizedImageWidth(attributes.qmWidth);
          return width ? { "data-qm-width": String(width), style: `width: ${width}%; max-width: 100%; height: auto` } : {};
        }
      },
      qmWidthPx: {
        default: null,
        parseHTML: (element: HTMLElement) => normalizedImagePixelWidth(element.getAttribute("data-qm-image-width") || element.style.width),
        renderHTML: (attributes: { qmWidthPx?: number | string | null }) => {
          const width = normalizedImagePixelWidth(attributes.qmWidthPx);
          return width ? { "data-qm-image-width": String(width), style: `width: ${width}px; max-width: 100%; height: auto` } : {};
        }
      }
    };
  }
});

export const richEditorExtensions = [
  StarterKit.configure({
    link: false,
    undoRedo: {
      depth: 500,
      newGroupDelay: 0
    }
  }),
  TextSize,
  TextColor,
  LineHeight,
  BlockLineHeight,
  BlockAttribution,
  Underline,
  Link.configure({
    autolink: true,
    defaultProtocol: "https",
    linkOnPaste: true,
    openOnClick: false,
    HTMLAttributes: {
      rel: "noopener noreferrer",
      target: "_blank"
    }
  }),
  ResizableImage.configure({
    allowBase64: true
  }),
  Placeholder.configure({
    placeholder: "메모를 입력하세요..."
  }),
  TaskList,
  TaskItem.configure({
    nested: true
  }),
  ResizableTable,
  ResizableTableRow,
  ColoredTableHeader,
  ColoredTableCell,
  TextAlign.configure({
    alignments: ["left", "center", "right"],
    types: ["heading", "paragraph", "tableCell", "tableHeader"]
  })
];
