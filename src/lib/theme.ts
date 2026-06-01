import type { ThemePreference } from "../types";

export type ResolvedTheme = "light" | "dark";

const themeStorageKey = "quickmemo:theme";
const validThemePreferences = new Set<ThemePreference>(["light", "dark", "system"]);

function storageAvailable() {
  try {
    return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
  } catch {
    return false;
  }
}

export function normalizeThemePreference(value: unknown): ThemePreference {
  return typeof value === "string" && validThemePreferences.has(value as ThemePreference)
    ? (value as ThemePreference)
    : "system";
}

export function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "light";
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveThemePreference(preference: ThemePreference): ResolvedTheme {
  return preference === "system" ? getSystemTheme() : preference;
}

export function getStoredThemePreference(): ThemePreference | null {
  if (!storageAvailable()) {
    return null;
  }

  try {
    const value = window.localStorage.getItem(themeStorageKey);
    return value ? normalizeThemePreference(value) : null;
  } catch {
    return null;
  }
}

export function writeStoredThemePreference(preference: ThemePreference) {
  if (!storageAvailable()) {
    return;
  }

  try {
    window.localStorage.setItem(themeStorageKey, preference);
  } catch {
    // Theme is a non-sensitive preference. Failing to cache it must not block the app.
  }
}

export function applyResolvedTheme(theme: ResolvedTheme) {
  if (typeof document === "undefined") {
    return;
  }

  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

export function applyThemePreference(preference: ThemePreference) {
  const resolvedTheme = resolveThemePreference(preference);
  applyResolvedTheme(resolvedTheme);
  return resolvedTheme;
}

export function initializeThemePreference() {
  return applyThemePreference(getStoredThemePreference() ?? "system");
}

export function subscribeSystemThemeChange(callback: (theme: ResolvedTheme) => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => undefined;
  }

  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const handleChange = () => callback(mediaQuery.matches ? "dark" : "light");

  mediaQuery.addEventListener("change", handleChange);
  return () => mediaQuery.removeEventListener("change", handleChange);
}
