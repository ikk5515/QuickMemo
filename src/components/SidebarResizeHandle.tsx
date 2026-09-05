import { useResizableSidebar } from "../features/workspace/useResizableSidebar";
import "../styles/sidebar-resize.css";

export function SidebarResizeHandle({ label, controls, width, minWidth, maxWidth, onChange, onCommit, className = "" }: {
  label: string; controls?: string; width: number; minWidth: number; maxWidth: number;
  onChange: (width: number) => void; onCommit?: (width: number) => void; className?: string;
}) {
  const { resizing, separatorProps } = useResizableSidebar({ width, minWidth, maxWidth, onChange, onCommit });
  return <div {...separatorProps} aria-label={label} aria-controls={controls} className={`qm-sidebar-resizer ${className}`} data-resizing={resizing || undefined} />;
}
