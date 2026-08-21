import { useEffect, useRef } from "react";

export type VaultNavigationShortcut = "command-palette" | "quick-switcher";

interface KeyboardShortcutEvent {
  altKey: boolean;
  ctrlKey: boolean;
  isComposing?: boolean;
  key: string;
  metaKey: boolean;
  repeat?: boolean;
  shiftKey: boolean;
}

export function getVaultNavigationShortcut(
  event: KeyboardShortcutEvent
): VaultNavigationShortcut | null {
  if (
    event.isComposing
    || event.repeat
    || event.altKey
    || event.shiftKey
    || (!event.metaKey && !event.ctrlKey)
  ) {
    return null;
  }

  switch (event.key.toLocaleLowerCase()) {
    case "p":
      return "command-palette";
    case "o":
      return "quick-switcher";
    default:
      return null;
  }
}

export function isCommandPaletteShortcut(event: KeyboardShortcutEvent): boolean {
  return getVaultNavigationShortcut(event) === "command-palette";
}

export function isQuickSwitcherShortcut(event: KeyboardShortcutEvent): boolean {
  return getVaultNavigationShortcut(event) === "quick-switcher";
}

export interface UseVaultNavigationShortcutsOptions {
  enabled?: boolean;
  onOpenCommandPalette: () => void;
  onOpenQuickSwitcher: () => void;
}

export function useVaultNavigationShortcuts({
  enabled = true,
  onOpenCommandPalette,
  onOpenQuickSwitcher
}: UseVaultNavigationShortcutsOptions): void {
  const callbacksRef = useRef({ onOpenCommandPalette, onOpenQuickSwitcher });

  useEffect(() => {
    callbacksRef.current = { onOpenCommandPalette, onOpenQuickSwitcher };
  }, [onOpenCommandPalette, onOpenQuickSwitcher]);

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) {
        return;
      }
      const shortcut = getVaultNavigationShortcut(event);
      if (shortcut === null) {
        return;
      }

      event.preventDefault();
      if (shortcut === "command-palette") {
        callbacksRef.current.onOpenCommandPalette();
      } else {
        callbacksRef.current.onOpenQuickSwitcher();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [enabled]);
}
