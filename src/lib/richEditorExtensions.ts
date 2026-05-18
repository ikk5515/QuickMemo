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

const editorCellColorSet = new Set<string>(editorCellColors);
const editorImageWidthSet = new Set<number>(editorImageWidths);

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
        renderHTML: (attributes: { qmWidth?: number | string | null }) => {
          const width = normalizedImageWidth(attributes.qmWidth);
          return width ? { "data-qm-width": String(width), style: `width: ${width}%; max-width: 100%; height: auto` } : {};
        }
      }
    };
  }
});

export const richEditorExtensions = [
  StarterKit.configure({
    link: false
  }),
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
  Table.configure({
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
