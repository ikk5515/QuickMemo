import { FolderInput, X } from "lucide-react";
import { useEffect, useId, useRef } from "react";

export interface VaultMoveTarget {
  returnFocusTo?: HTMLElement | null;
  targetId: string;
  targetKind: "entry" | "folder";
}

export interface VaultMoveDestination {
  disabled?: boolean;
  folderId: string | null;
  label: string;
}

export function isKeyboardContextMenuGesture(key: string, shiftKey: boolean) {
  return key === "ContextMenu" || (shiftKey && key === "F10");
}

export function keyboardContextMenuPoint(rect: Pick<DOMRect, "height" | "left" | "top" | "width">) {
  return {
    x: rect.left + Math.min(24, rect.width / 2),
    y: rect.top + Math.min(24, rect.height)
  };
}

export function VaultMoveDialog({
  destinations,
  label,
  onClose,
  onMove,
  returnFocusTo
}: {
  destinations: readonly VaultMoveDestination[];
  label: string;
  onClose: () => void;
  onMove: (folderId: string | null) => void | Promise<void>;
  returnFocusTo?: HTMLElement | null;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => {
    if (returnFocusTo?.isConnected) {
      returnFocusTo.focus();
    }
  }, [returnFocusTo]);

  function trapDialogFocus(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }
    const controls = [...(dialogRef.current?.querySelectorAll<HTMLButtonElement>(
      "button:not(:disabled)"
    ) ?? [])];
    if (!controls.length) {
      event.preventDefault();
      return;
    }
    const first = controls[0];
    const last = controls.at(-1) as HTMLButtonElement;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialogRef.current?.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className="vault-context-backdrop vault-move-dialog-backdrop"
      onClick={onClose}
      role="presentation"
    >
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className="vault-move-dialog"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={trapDialogFocus}
        ref={dialogRef}
        role="dialog"
      >
        <header>
          <strong id={titleId}>{label} 이동</strong>
          <button aria-label="이동 창 닫기" autoFocus onClick={onClose} type="button"><X size={16} /></button>
        </header>
        <p>이동할 폴더를 선택하세요.</p>
        <ul aria-label="이동 위치" className="vault-move-destinations">
          {destinations.map((destination) => (
            <li key={destination.folderId ?? "vault-root"}>
              <button
                disabled={destination.disabled}
                onClick={() => void onMove(destination.folderId)}
                type="button"
              >
                <FolderInput size={15} />
                <span>{destination.label}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
