import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DecryptedVaultNote } from "../vault/vaultData";
import { VaultJsonCanvasPane } from "./VaultJsonCanvasPane";

const mocks = vi.hoisted(() => ({ renderCanvas: vi.fn() }));

vi.mock("./JsonCanvasView", () => ({
  JsonCanvasView: (props: unknown) => {
    mocks.renderCanvas(props);
    return null;
  }
}));

function canvasSource(text: string) {
  return JSON.stringify({
    edges: [],
    nodes: [{ height: 160, id: "text-a", text, type: "text", width: 280, x: 0, y: 0 }]
  });
}

describe("VaultJsonCanvasPane", () => {
  it("keeps file-option identity stable while a Canvas text node changes", async () => {
    let linkedMarkdownBody = "# 연결 노트";
    const notes = [
      { body: canvasSource("가"), entryKind: "canvas", id: "canvas-a", title: "Canvas" },
      { body: "# 연결 노트", entryKind: "markdown", id: "note-a", title: "연결 노트" }
    ] as DecryptedVaultNote[];
    const common = {
      decodedAssetForEntry: () => null,
      entryPaths: new Map([["canvas-a", "Canvas.canvas"], ["note-a", "연결 노트"]]),
      getDraftBody: (entryId: string, fallback: string) => (
        entryId === "note-a" ? linkedMarkdownBody : fallback
      ),
      markdownDraftRevision: 0,
      notes,
      onChange: () => undefined,
      onOpenFile: () => undefined
    };
    const view = render(<VaultJsonCanvasPane {...common} source={canvasSource("가")} />);
    const firstOptions = (mocks.renderCanvas.mock.lastCall?.[0] as { fileOptions: unknown }).fileOptions;

    view.rerender(<VaultJsonCanvasPane {...common} source={canvasSource("가나다")} />);
    await act(async () => {
      await Promise.resolve();
    });

    const latestOptions = (mocks.renderCanvas.mock.lastCall?.[0] as { fileOptions: unknown }).fileOptions;
    expect(latestOptions).toBe(firstOptions);

    linkedMarkdownBody = "# 즉시 갱신된 연결 노트";
    view.rerender(
      <VaultJsonCanvasPane
        {...common}
        markdownDraftRevision={1}
        source={canvasSource("가나다")}
      />
    );
    const refreshedOptions = (mocks.renderCanvas.mock.lastCall?.[0] as {
      fileOptions: Array<{ content?: string; path: string }>;
    }).fileOptions;
    expect(refreshedOptions).not.toBe(firstOptions);
    expect(refreshedOptions.find((option) => option.path === "연결 노트")?.content)
      .toBe("# 즉시 갱신된 연결 노트");
  });
});
