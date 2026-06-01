import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyThemePreference,
  getStoredThemePreference,
  initializeThemePreference,
  normalizeThemePreference,
  resolveThemePreference,
  writeStoredThemePreference
} from "./theme";

function mockSystemTheme(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      addEventListener: vi.fn(),
      matches,
      media: query,
      removeEventListener: vi.fn()
    }))
  });
}

describe("theme helpers", () => {
  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.colorScheme = "";
    vi.restoreAllMocks();
  });

  it("normalizes unsafe theme values to system", () => {
    expect(normalizeThemePreference("dark")).toBe("dark");
    expect(normalizeThemePreference("light")).toBe("light");
    expect(normalizeThemePreference("system")).toBe("system");
    expect(normalizeThemePreference("midnight")).toBe("system");
  });

  it("resolves system preference from matchMedia", () => {
    mockSystemTheme(true);
    expect(resolveThemePreference("system")).toBe("dark");

    mockSystemTheme(false);
    expect(resolveThemePreference("system")).toBe("light");
  });

  it("persists only the non-sensitive theme preference", () => {
    writeStoredThemePreference("dark");
    expect(getStoredThemePreference()).toBe("dark");
  });

  it("applies the resolved theme to the document element", () => {
    expect(applyThemePreference("dark")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("initializes from localStorage before the app renders", () => {
    writeStoredThemePreference("dark");
    expect(initializeThemePreference()).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
