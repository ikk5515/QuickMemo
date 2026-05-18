import { Mark } from "@tiptap/core";
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
import StarterKit from "@tiptap/starter-kit";

export const editorCellColors = ["#fff7ed", "#fef3c7", "#dcfce7", "#dbeafe", "#fce7f3", "#f1f5f9"] as const;
export const editorImageWidths = [25, 50, 75, 100] as const;
export const editorImagePixelWidthBounds = { min: 120, max: 1200, step: 10 } as const;
export const editorTableWidths = [30, 50, 75, 100] as const;
export const editorTextSizes = [14, 16, 17, 18, 20, 22, 24, 28] as const;

const editorCellColorSet = new Set<string>(editorCellColors);
const editorImageWidthSet = new Set<number>(editorImageWidths);
const editorTextSizeSet = new Set<number>(editorTextSizes);

function normalizedEditorColor(value: unknown) {
  const rawValue = String(value ?? "").trim().toLowerCase();

  if (editorCellColorSet.has(rawValue)) {
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

function normalizedTextSize(value: unknown) {
  const size = Number(String(value ?? "").replace("px", "").trim());

  return editorTextSizeSet.has(size) ? size : null;
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

const ResizableTable = Table.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      qmWidth: {
        default: null,
        parseHTML: (element: HTMLElement) => normalizedTableWidth(element.getAttribute("data-qm-table-width") || element.style.width),
        renderHTML: (attributes: { qmWidth?: number | string | null }) => {
          const width = normalizedTableWidth(attributes.qmWidth);
          return width ? { "data-qm-table-width": String(width), style: `width: ${width}%; max-width: 100%` } : {};
        }
      }
    };
  }
});

const ColoredTableCell = TableCell.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      backgroundColor: {
        default: null,
        parseHTML: (element: HTMLElement) => normalizedEditorColor(element.getAttribute("data-qm-bg") || element.style.backgroundColor),
        renderHTML: (attributes: { backgroundColor?: string | null }) => {
          const color = normalizedEditorColor(attributes.backgroundColor);
          return color ? { "data-qm-bg": color, style: `background-color: ${color}` } : {};
        }
      }
    };
  }
});

const ColoredTableHeader = TableHeader.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      backgroundColor: {
        default: null,
        parseHTML: (element: HTMLElement) => normalizedEditorColor(element.getAttribute("data-qm-bg") || element.style.backgroundColor),
        renderHTML: (attributes: { backgroundColor?: string | null }) => {
          const color = normalizedEditorColor(attributes.backgroundColor);
          return color ? { "data-qm-bg": color, style: `background-color: ${color}` } : {};
        }
      }
    };
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
  ResizableTable.configure({
    resizable: true
  }),
  TableRow,
  ColoredTableHeader,
  ColoredTableCell,
  TextAlign.configure({
    alignments: ["left", "center", "right"],
    types: ["heading", "paragraph", "tableCell", "tableHeader"]
  })
];
