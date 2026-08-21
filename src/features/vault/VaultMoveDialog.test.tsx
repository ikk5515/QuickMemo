import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  isKeyboardContextMenuGesture,
  keyboardContextMenuPoint,
  VaultMoveDialog
} from "./VaultMoveDialog";

describe("VaultMoveDialog", () => {
  it("traps focus, exposes destinations, and restores the initiating control", () => {
    const onClose = vi.fn();
    const onMove = vi.fn();
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const view = render(
      <VaultMoveDialog
        destinations={[
          { folderId: null, label: "Vault 루트" },
          { disabled: true, folderId: "current", label: "현재 폴더" },
          { folderId: "other", label: "Projects / Other" }
        ]}
        label="Note.md"
        onClose={onClose}
        onMove={onMove}
        returnFocusTo={trigger}
      />
    );

    const dialog = screen.getByRole("dialog", { name: "Note.md 이동" });
    const close = screen.getByRole("button", { name: "이동 창 닫기" });
    const other = screen.getByRole("button", { name: "Projects / Other" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(close).toHaveFocus();
    expect(screen.getByRole("button", { name: "현재 폴더" })).toBeDisabled();
    other.focus();
    fireEvent.keyDown(other, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(other).toHaveFocus();
    fireEvent.click(other);
    expect(onMove).toHaveBeenCalledWith("other");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it("recognizes the Context Menu key and Shift+F10 and anchors them to the row", () => {
    expect(isKeyboardContextMenuGesture("ContextMenu", false)).toBe(true);
    expect(isKeyboardContextMenuGesture("F10", true)).toBe(true);
    expect(isKeyboardContextMenuGesture("F10", false)).toBe(false);
    expect(keyboardContextMenuPoint({ height: 44, left: 10, top: 20, width: 200 }))
      .toEqual({ x: 34, y: 44 });
  });
});
