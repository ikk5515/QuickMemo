import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";
import { QuickSwitcher } from "./QuickSwitcher";
import {
  getVaultNavigationShortcut,
  useVaultNavigationShortcuts
} from "./useVaultNavigationShortcuts";
import {
  navigationModifiersFromEvent,
  vaultOpenTargetFromModifiers,
  type CommandPaletteItem,
  type QuickSwitcherItem
} from "./types";

const COMMANDS: readonly CommandPaletteItem[] = [
  {
    id: "new-note",
    label: "새 노트 만들기",
    description: "현재 폴더에 Markdown 노트를 만듭니다.",
    section: "파일",
    shortcut: "⌘N"
  },
  {
    id: "open-graph",
    label: "그래프 뷰 열기",
    description: "전체 지식 그래프를 엽니다.",
    keywords: ["graph", "network"],
    section: "보기"
  },
  {
    id: "locked-command",
    label: "사용할 수 없는 명령",
    disabled: true
  }
];

const ENTRIES: readonly QuickSwitcherItem[] = [
  {
    id: "daily",
    title: "2026-08-22",
    path: "Daily/2026-08-22.md",
    aliases: ["오늘", "Daily note"],
    kind: "markdown"
  },
  {
    id: "canvas",
    title: "제품 설계",
    path: "Projects/제품 설계.canvas",
    kind: "canvas"
  }
];

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("navigation shortcut helpers", () => {
  it("maps primary-P and primary-O without intercepting modified variants", () => {
    expect(getVaultNavigationShortcut({
      altKey: false,
      ctrlKey: false,
      key: "P",
      metaKey: true,
      shiftKey: false
    })).toBe("command-palette");
    expect(getVaultNavigationShortcut({
      altKey: false,
      ctrlKey: true,
      key: "o",
      metaKey: false,
      shiftKey: false
    })).toBe("quick-switcher");
    expect(getVaultNavigationShortcut({
      altKey: true,
      ctrlKey: true,
      key: "p",
      metaKey: false,
      shiftKey: false
    })).toBeNull();
  });

  it("derives Obsidian-style open targets from modifiers", () => {
    const target = (input: Partial<KeyboardEvent>) => vaultOpenTargetFromModifiers(
      navigationModifiersFromEvent({
        altKey: input.altKey ?? false,
        ctrlKey: input.ctrlKey ?? false,
        metaKey: input.metaKey ?? false,
        shiftKey: input.shiftKey ?? false
      })
    );

    expect(target({})).toBe("current");
    expect(target({ metaKey: true })).toBe("new-tab");
    expect(target({ ctrlKey: true, altKey: true })).toBe("new-tab-group");
    expect(target({ metaKey: true, altKey: true, shiftKey: true })).toBe("new-window");
  });

  it("opens the requested surface through the reusable document shortcut hook", () => {
    const onCommandPalette = vi.fn();
    const onQuickSwitcher = vi.fn();

    function Harness() {
      useVaultNavigationShortcuts({
        onOpenCommandPalette: onCommandPalette,
        onOpenQuickSwitcher: onQuickSwitcher
      });
      return null;
    }

    render(<Harness />);
    expect(fireEvent.keyDown(document, { key: "p", metaKey: true })).toBe(false);
    fireEvent.keyDown(document, { key: "O", ctrlKey: true });

    expect(onCommandPalette).toHaveBeenCalledTimes(1);
    expect(onQuickSwitcher).toHaveBeenCalledTimes(1);
  });
});

describe("CommandPalette", () => {
  it("adds the Vault command catalog only when the Vault host requests it", () => {
    render(
      <CommandPalette
        commands={[]}
        includeVaultCommands
        onExecute={() => undefined}
        onOpenChange={() => undefined}
        open
      />
    );

    fireEvent.change(screen.getByRole("combobox", { name: "명령 검색" }), {
      target: { value: "새 노트" }
    });
    expect(screen.getByRole("option", { name: /^새 노트 만들기/ })).toHaveTextContent("새 노트 만들기");
  });

  it("provides modal combobox semantics, fuzzy filtering, and keyboard activation", () => {
    const onExecute = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <CommandPalette
        commands={COMMANDS}
        onExecute={onExecute}
        onOpenChange={onOpenChange}
        open
      />
    );

    expect(screen.getByRole("dialog", { name: "명령 팔레트" })).toHaveAttribute("aria-modal", "true");
    const input = screen.getByRole("combobox", { name: "명령 검색" });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "graph" } });

    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option")).toHaveTextContent("그래프 뷰 열기");
    fireEvent.keyDown(input, {
      altKey: true,
      key: "Enter",
      metaKey: true,
      shiftKey: true
    });

    expect(onExecute).toHaveBeenCalledWith(
      expect.objectContaining({ id: "open-graph" }),
      expect.objectContaining({ source: "keyboard", target: "new-window" })
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does not execute disabled commands", () => {
    const onExecute = vi.fn();
    render(
      <CommandPalette
        commands={COMMANDS}
        onExecute={onExecute}
        onOpenChange={() => undefined}
        open
      />
    );
    const input = screen.getByRole("combobox", { name: "명령 검색" });
    fireEvent.change(input, { target: { value: "사용할 수 없는" } });
    const option = screen.getByRole("option");
    expect(option).toHaveAttribute("aria-disabled", "true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onExecute).not.toHaveBeenCalled();
  });
});

describe("QuickSwitcher", () => {
  it("bounds a 5k-vault result set while preserving keyboard and screen-reader context", () => {
    const entries = Array.from({ length: 5_000 }, (_, index): QuickSwitcherItem => ({
      id: `note-${index}`,
      kind: "markdown",
      path: `Archive/Note-${index}.md`,
      title: `노트 ${index}`
    }));
    const onOpen = vi.fn();
    render(
      <QuickSwitcher
        entries={entries}
        onOpen={onOpen}
        onOpenChange={() => undefined}
        open
      />
    );

    const input = screen.getByRole("combobox", { name: "퀵 스위처 검색" });
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(160);
    expect(screen.getByRole("status")).toHaveTextContent(
      "5,000개 결과 중 160개 표시. 더 구체적으로 검색하면 나머지 결과를 찾을 수 있습니다."
    );
    expect(options[0]).toHaveAttribute("aria-setsize", "5000");
    expect(options[159]).toHaveAttribute("aria-posinset", "160");

    fireEvent.keyDown(input, { key: "End" });
    expect(options[159]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ id: "note-159" }),
      expect.objectContaining({ source: "keyboard" })
    );
  });

  it("matches aliases and returns pointer modifier metadata", () => {
    const onOpen = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <QuickSwitcher
        entries={ENTRIES}
        onOpen={onOpen}
        onOpenChange={onOpenChange}
        open
      />
    );

    const input = screen.getByRole("combobox", { name: "퀵 스위처 검색" });
    fireEvent.change(input, { target: { value: "Daily note" } });
    const option = screen.getByRole("option");
    expect(option).toHaveTextContent("2026-08-22");
    fireEvent.click(option, { altKey: true, ctrlKey: true });

    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ id: "daily" }),
      expect.objectContaining({ source: "pointer", target: "new-tab-group" })
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("cycles through results and restores focus after closing", () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)} type="button">열기</button>
          <QuickSwitcher
            entries={ENTRIES}
            onOpen={() => undefined}
            onOpenChange={setOpen}
            open={open}
          />
        </>
      );
    }

    render(<Harness />);
    const launcher = screen.getByRole("button", { name: "열기" });
    launcher.focus();
    fireEvent.click(launcher);
    const input = screen.getByRole("combobox", { name: "퀵 스위처 검색" });
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    const closeButton = screen.getByRole("button", { name: "퀵 스위처 닫기" });
    expect(closeButton).toHaveFocus();
    fireEvent.keyDown(closeButton, { key: "Tab" });
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "퀵 스위처" })).not.toBeInTheDocument();
    expect(launcher).toHaveFocus();
  });

  it("keeps plaintext queries out of storage and console output", () => {
    const storageSpy = vi.spyOn(Storage.prototype, "setItem");
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    render(
      <QuickSwitcher
        entries={ENTRIES}
        onOpen={() => undefined}
        onOpenChange={() => undefined}
        open
      />
    );

    fireEvent.change(screen.getByRole("combobox", { name: "퀵 스위처 검색" }), {
      target: { value: "비공개 프로젝트 검색어" }
    });

    expect(storageSpy).not.toHaveBeenCalled();
    expect(consoleSpy).not.toHaveBeenCalled();
    storageSpy.mockRestore();
    consoleSpy.mockRestore();
  });
});
