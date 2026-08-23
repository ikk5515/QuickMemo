import type { DecryptedVaultFolder, DecryptedVaultNote } from "./vaultData";

const VAULT_ENTRY_TITLE_MAX_LENGTH = 180;
const VAULT_FOLDER_NAME_MAX_LENGTH = 120;

function truncateUtf16(value: string, maxLength: number) {
  let truncated = value.slice(0, Math.max(0, maxLength));
  const lastCodeUnit = truncated.charCodeAt(truncated.length - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    truncated = truncated.slice(0, -1);
  }
  return truncated;
}

function boundedCollisionName(
  stem: string,
  suffix: string,
  extension: string,
  maxLength: number,
  ordinal: number
) {
  const stemAndSuffixLimit = maxLength - extension.length;
  if (stemAndSuffixLimit <= suffix.length) {
    const compactOrdinal = ordinal <= 35
      ? ordinal === 1 ? "~" : ordinal.toString(36)
      : String.fromCharCode(0x3400 + ((ordinal - 36) % 0x19b5));
    return `${truncateUtf16(compactOrdinal, stemAndSuffixLimit)}${extension}`;
  }
  const stemLimit = stemAndSuffixLimit - suffix.length;
  const boundedStem = truncateUtf16(stem, stemLimit).trimEnd()
    || truncateUtf16("항목", stemLimit);
  return `${boundedStem}${suffix}${extension}`;
}

function normalizedEntryTitle(
  value: string,
  kind: DecryptedVaultNote["entryKind"]
) {
  if (kind === "asset") {
    return value.trim().normalize("NFC").toLocaleLowerCase();
  }
  const extension = kind === "canvas" ? ".canvas" : kind === "base" ? ".base" : ".md";
  const escapedExtension = extension.replace(".", "\\.");
  return `${value.trim().normalize("NFC").replace(new RegExp(`${escapedExtension}$`, "i"), "")}${extension}`
    .toLocaleLowerCase();
}

function uniqueEntryTitle(notes: readonly DecryptedVaultNote[], target: DecryptedVaultNote) {
  const titles = new Set(notes
    .filter((note) => (
      note.id !== target.id
      && (note.folderId ?? null) === (target.folderId ?? null)
    ))
    .map((note) => normalizedEntryTitle(note.title, note.entryKind)));
  const current = target.title.trim();
  const virtualExtension = target.entryKind === "canvas"
    ? /\.canvas$/iu
    : target.entryKind === "base"
      ? /\.base$/iu
      : /\.md$/iu;
  const extensionIndex = target.entryKind === "asset" ? current.lastIndexOf(".") : -1;
  const stem = target.entryKind === "asset"
    ? extensionIndex > 0 ? current.slice(0, extensionIndex) : current
    : current.replace(virtualExtension, "");
  const extension = target.entryKind === "asset" && extensionIndex > 0
    ? current.slice(extensionIndex)
    : "";
  let ordinal = 1;
  while (true) {
    const suffix = ` (중복)${ordinal > 1 ? ` ${ordinal}` : ""}`;
    const candidate = boundedCollisionName(
      stem,
      suffix,
      extension,
      VAULT_ENTRY_TITLE_MAX_LENGTH,
      ordinal
    );
    if (!titles.has(normalizedEntryTitle(candidate, target.entryKind))) return candidate;
    ordinal += 1;
  }
}

export function suggestedCollisionEntryTitle(
  notes: readonly DecryptedVaultNote[],
  target: DecryptedVaultNote
) {
  return uniqueEntryTitle(notes, target);
}

export function suggestedCollisionFolderName(
  folders: readonly DecryptedVaultFolder[],
  target: DecryptedVaultFolder
) {
  const siblingNames = new Set(folders
    .filter((folder) => (
      folder.id !== target.id
      && (folder.parentId ?? null) === (target.parentId ?? null)
    ))
    .map((folder) => folder.displayName.trim().normalize("NFC").toLocaleLowerCase()));
  let ordinal = 1;
  while (true) {
    const suffix = ` (중복)${ordinal > 1 ? ` ${ordinal}` : ""}`;
    const candidate = boundedCollisionName(
      target.displayName.trim(),
      suffix,
      "",
      VAULT_FOLDER_NAME_MAX_LENGTH,
      ordinal
    );
    if (!siblingNames.has(candidate.normalize("NFC").toLocaleLowerCase())) return candidate;
    ordinal += 1;
  }
}

export function promptCollisionEntryTitle(
  notes: readonly DecryptedVaultNote[],
  target: DecryptedVaultNote
) {
  return window.prompt(
    target.type === "shared" && (target.folderId ?? null) !== null
      ? "중복 공유 항목의 새 이름 (내용을 보존해 Vault 루트로 이동합니다)"
      : "중복 항목의 새 이름 (내용은 변경되지 않습니다)",
    suggestedCollisionEntryTitle(notes, target)
  );
}

export function promptCollisionFolderName(
  folders: readonly DecryptedVaultFolder[],
  target: DecryptedVaultFolder
) {
  return window.prompt(
    "중복 폴더의 새 이름 (하위 내용은 변경되지 않습니다)",
    suggestedCollisionFolderName(folders, target)
  );
}

type VaultNameCollisionRepairDecision =
  | { kind: "entry"; name: string; targetId: string }
  | { kind: "folder"; name: string; targetId: string }
  | { kind: "missing" };

export function promptVaultNameCollisionRepair(
  notes: readonly DecryptedVaultNote[],
  folders: readonly DecryptedVaultFolder[],
  targetId: string
): VaultNameCollisionRepairDecision | null {
  const note = notes.find((candidate) => candidate.id === targetId);
  if (note) {
    const name = promptCollisionEntryTitle(notes, note)?.trim();
    return name ? { kind: "entry", name, targetId } : null;
  }
  const folder = folders.find((candidate) => candidate.id === targetId);
  if (!folder) return { kind: "missing" };
  const name = promptCollisionFolderName(folders, folder)?.trim();
  return name ? { kind: "folder", name, targetId } : null;
}
