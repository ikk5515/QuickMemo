import type { PublicRosterUser } from "../types";

export function sortRoster(users: PublicRosterUser[]) {
  return [...users].sort((a, b) => a.order - b.order || a.quickKey - b.quickKey);
}

export function findRosterByShortcut(users: PublicRosterUser[], key: string) {
  if (!/^\d$/.test(key)) {
    return undefined;
  }

  const numericKey = Number(key);
  const quickKey = numericKey === 0 ? 10 : numericKey;
  return users.find((user) => user.quickKey === quickKey);
}

export function initialsFromName(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}
