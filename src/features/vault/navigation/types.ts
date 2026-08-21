export type VaultOpenTarget = "current" | "new-tab" | "new-tab-group" | "new-window";

export interface NavigationModifierState {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  primaryKey: boolean;
  shiftKey: boolean;
}

export interface NavigationActivationMetadata {
  modifiers: NavigationModifierState;
  source: "keyboard" | "pointer";
  target: VaultOpenTarget;
}

export interface CommandPaletteItem {
  description?: string;
  disabled?: boolean;
  id: string;
  keywords?: readonly string[];
  label: string;
  section?: string;
  shortcut?: string;
}

export type QuickSwitcherItemKind =
  | "markdown"
  | "legacy-html"
  | "canvas"
  | "base"
  | "asset"
  | "folder";

export interface QuickSwitcherItem {
  aliases?: readonly string[];
  id: string;
  kind?: QuickSwitcherItemKind;
  path?: string;
  title: string;
}

type ModifierEvent = Pick<
  KeyboardEvent | MouseEvent,
  "altKey" | "ctrlKey" | "metaKey" | "shiftKey"
>;

export function navigationModifiersFromEvent(event: ModifierEvent): NavigationModifierState {
  return {
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    primaryKey: event.metaKey || event.ctrlKey,
    shiftKey: event.shiftKey
  };
}

export function vaultOpenTargetFromModifiers(
  modifiers: NavigationModifierState
): VaultOpenTarget {
  if (modifiers.primaryKey && modifiers.altKey && modifiers.shiftKey) {
    return "new-window";
  }
  if (modifiers.primaryKey && modifiers.altKey) {
    return "new-tab-group";
  }
  if (modifiers.primaryKey) {
    return "new-tab";
  }
  return "current";
}

export function navigationActivationFromEvent(
  event: ModifierEvent,
  source: NavigationActivationMetadata["source"]
): NavigationActivationMetadata {
  const modifiers = navigationModifiersFromEvent(event);
  return {
    modifiers,
    source,
    target: vaultOpenTargetFromModifiers(modifiers)
  };
}
